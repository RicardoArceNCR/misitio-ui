#!/usr/bin/env node
/**
 * Guardarrail de unidades sobre el CSS ya compilado.
 *
 * Existe por un bug real: en la coleccion dark de Figma, nav/height,
 * modal|pill|toast|tooltip/radius y avatar/size/* son valores concretos sin
 * alias, y figma-to-sd.py no los tenia en needs_px(). El resultado era
 * `--nav-height: 64` bajo `.dark`, que vuelve invalido cualquier
 * `h-[var(--nav-height)]`. Nadie lo noto porque el modo claro (donde esos
 * tokens si son alias de un primitivo) se veia bien.
 *
 * El chequeo es sobre la salida, no sobre la fuente, a proposito: lo que
 * rompe al consumidor es el CSS, y asi cubre cualquier gap futuro de
 * needs_px() sin tener que anticiparlo.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["build/tokens.css", "build/tokens-dark.css"];

// Tokens que son legitimamente sin unidad (ratios, multiplicadores, capas)
// o que un consumidor nunca lee crudo. Cada entrada necesita motivo: esta
// lista es la unica via para que un valor pelado pase el chequeo.
const ALLOW = [
  { re: /^--z-index-/, why: "z-index es un entero por definicion" },
  { re: /^--opacity-/, why: "opacity es un ratio 0..1" },
  { re: /^--typography-weight-|-weight$/, why: "font-weight es un entero" },
  { re: /^--typography-leading-/, why: "line-height sin unidad es un ratio (intencional)" },
  {
    re: /^--breakpoint-/,
    why: "theme-bridge.template.css los redefine con px en su bloque @theme",
  },
  {
    re: /^--typography-(heading|subheading|body|label|caption|hero)-size$/,
    why: "preexistente: escala vieja, superada por --typography-styles-*. Ver DEUDA en README",
  },
];

const BARE_NUMBER = /^-?\d+(\.\d+)?$/;
const DECL = /^\s*(--[\w-]+)\s*:\s*([^;]+);/;

let failures = [];

for (const file of FILES) {
  const text = readFileSync(path.join(root, file), "utf8");
  for (const [i, line] of text.split("\n").entries()) {
    const m = DECL.exec(line);
    if (!m) continue;
    const [, name, rawValue] = m;
    const value = rawValue.trim();

    if (!BARE_NUMBER.test(value) || value === "0") continue;
    if (ALLOW.some((a) => a.re.test(name))) continue;

    failures.push({ file, line: i + 1, name, value });
  }
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} token(s) con valor sin unidad:\n`);
  for (const f of failures) {
    console.error(`  ${f.file}:${f.line}  ${f.name}: ${f.value}`);
  }
  console.error(
    "\nSi es una dimension, agregala a needs_px() en figma-to-sd.py y regenera.\n" +
      "Si de verdad va sin unidad, agregala a ALLOW en este archivo con su motivo.\n",
  );
  process.exit(1);
}

// Segundo invariante: un token no puede resolverse en claro y quedar pelado
// en oscuro. Ese desajuste es exactamente la forma que tomo el bug original
// y no lo agarra el chequeo de arriba si el valor esta en ALLOW.
const parse = (file) => {
  const map = new Map();
  for (const line of readFileSync(path.join(root, file), "utf8").split("\n")) {
    const m = DECL.exec(line);
    if (m) map.set(m[1], m[2].trim());
  }
  return map;
};

const light = parse("build/tokens.css");
const dark = parse("build/tokens-dark.css");
const mismatches = [];

for (const [name, darkValue] of dark) {
  const lightValue = light.get(name);
  if (lightValue === undefined) continue;
  const lightResolves = lightValue.startsWith("var(") || !BARE_NUMBER.test(lightValue);
  if (lightResolves && BARE_NUMBER.test(darkValue) && darkValue !== "0") {
    mismatches.push({ name, lightValue, darkValue });
  }
}

if (mismatches.length > 0) {
  console.error(`\n✗ ${mismatches.length} token(s) validos en claro y pelados en oscuro:\n`);
  for (const m of mismatches) {
    console.error(`  ${m.name}: claro=${m.lightValue}  oscuro=${m.darkValue}`);
  }
  process.exit(1);
}

console.log(`✓ Unidades OK en ${FILES.join(", ")} (sin valores pelados, claro y oscuro en paridad).`);
