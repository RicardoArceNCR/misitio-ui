#!/usr/bin/env node
/**
 * Fase 0 del pipeline DOM → Figma (ver
 * docs/tooling/figma-sync-implementation.md §2).
 *
 * Camina source/*.json UNA sola vez y deriva, para cada token hoja,
 * cssVar y figmaName DEL MISMO array de claves — nunca reconstruye uno a
 * partir del otro. Es la razón de ser de este script: revertir guiones a
 * barras a mano (`cssVar.replace(/-/g, '/')`) es ambiguo apenas un
 * segmento de clave trae un guion propio (ejemplos reales en este repo:
 * `surface.inverse-subtle`, `typography.styles.body.lg-bold`). Acá el
 * path nunca se serializa y se vuelve a parsear, así que esa ambigüedad
 * no puede aparecer.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.resolve(__dirname, "../../source");
const BUILD_DIR = path.resolve(__dirname, "../../build");
const OUT_FILE = path.resolve(__dirname, "../token-map.json");

// Fuera a propósito: motion.json/opacity.json/breakpoints.json (confirmado
// con grep contra transparencia.tsx/niveles.tsx: ningún var(--motion-...),
// var(--opacity-...) ni var(--breakpoint-...) en esos dos componentes).
const SOURCE_FILES = [
  "primitivos.json",
  "semanticos.json",
  "componentes.json",
  "spacing.json",
  "tipografia.json",
  "shadow.json",
  "z-index.json",
];

// Dark mode (cambio 2026-08-05, ver docs/decisions/0009-... y su §7
// "fuera de alcance": estaba deliberadamente fuera del MVP original, hasta
// que importar TODAS las secciones de /vaca y /vaca-b -- varias con
// `className="dark"` real (Card de Manifiesto, secciones de Niveles) --
// hizo evidente que sin esto, esas tarjetas entran a Figma con el color
// CLARO en vez del oscuro real. No hay `primitivos-dark.json`/
// `spacing-dark.json`/etc. -- solo `semanticos`/`componentes` varían por
// modo (confirmado: los primitivos y el spacing no tienen versión dark en
// `source/` en la raíz del paquete).
const DARK_SOURCE_FILES = ["semanticos-dark.json", "componentes-dark.json"];

function isLeaf(node) {
  return node !== null && typeof node === "object" && "$value" in node;
}

function walk(node, pathSoFar, collection, byCssVar) {
  if (isLeaf(node)) {
    const cssVar = `--${pathSoFar.join("-")}`;
    const figmaName = pathSoFar.join("/");
    const existing = byCssVar[cssVar];
    if (existing && existing.figmaName !== figmaName) {
      console.warn(
        `⚠  colisión en ${cssVar}: ya estaba mapeado a "${existing.figmaName}" ` +
          `(${existing.collection}), ahora "${figmaName}" (${collection}) lo pisa. ` +
          `Revisar a mano — no debería pasar si source/*.json no tiene claves duplicadas.`,
      );
    }
    byCssVar[cssVar] = { figmaName, collection, type: node.$type ?? null };
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, child] of Object.entries(node)) {
      walk(child, [...pathSoFar, key], collection, byCssVar);
    }
  }
}

function buildByCssVar(files) {
  const byCssVar = {};
  for (const file of files) {
    const full = path.join(SOURCE_DIR, file);
    if (!existsSync(full)) {
      console.warn(`⚠  ${file} no existe en ${SOURCE_DIR}, se saltea.`);
      continue;
    }
    const json = JSON.parse(readFileSync(full, "utf8"));
    const collection = file.replace(/\.json$/, "");
    for (const [rootKey, rootVal] of Object.entries(json)) {
      walk(rootVal, [rootKey], collection, byCssVar);
    }
  }
  return byCssVar;
}

/**
 * Caso aparte, no genérico: las clases de tipografía COMPILADAS de
 * Tailwind (text-display-xl, text-h2, text-body-md...) no llevan var()
 * literal en el className renderizado — Tailwind v4 las resuelve vía
 * @theme inline en theme-bridge-typography.generated.css
 * (--text-h2: var(--typography-styles-heading-h2-size)).
 *
 * Importante: para sacar el figmaName de esa variable NO se revierte el
 * nombre a mano (mismo problema de ambigüedad que arriba — ejemplo real:
 * "typography-styles-body-lg-bold-size" sin el path real, un split
 * ingenuo por guion no puede saber si "lg-bold" es un solo segmento o
 * dos). En vez de eso, se busca esa cssVar en el byCssVar que ya
 * construyó buildByCssVar() — el figmaName correcto ya está ahí.
 */
function buildTypographyClassMap(byCssVar) {
  const cssPath = path.join(BUILD_DIR, "theme-bridge-typography.generated.css");
  if (!existsSync(cssPath)) {
    console.warn(
      `⚠  ${cssPath} no existe — ¿corriste el build de tokens? Se saltea tipografía.`,
    );
    return {};
  }
  const css = readFileSync(cssPath, "utf8");
  const re = /--text-([\w-]+):\s*var\(--([\w-]+)\);/g;
  const raw = {};
  let m;
  while ((m = re.exec(css))) {
    raw[m[1]] = m[2];
  }

  const out = {};
  for (const [key, varName] of Object.entries(raw)) {
    if (key.endsWith("--line-height")) continue; // se procesa junto a su base, abajo
    const className = `text-${key}`;
    const sizeCssVar = `--${varName}`;
    const sizeEntry = byCssVar[sizeCssVar];
    if (!sizeEntry) {
      console.warn(
        `⚠  ${className}: ${sizeCssVar} no aparece en byCssVar (¿falta un archivo en SOURCE_FILES?). Se saltea.`,
      );
      continue;
    }
    const lineHeightVarName = raw[`${key}--line-height`] ?? null;
    const lineHeightCssVar = lineHeightVarName ? `--${lineHeightVarName}` : null;
    const lineHeightEntry = lineHeightCssVar ? byCssVar[lineHeightCssVar] : null;

    out[className] = {
      size: { cssVar: sizeCssVar, figmaName: sizeEntry.figmaName },
      lineHeight: lineHeightEntry
        ? { cssVar: lineHeightCssVar, figmaName: lineHeightEntry.figmaName }
        : null,
    };
  }
  return out;
}

function main() {
  const byCssVar = buildByCssVar(SOURCE_FILES);
  // byCssVarDark: mismo mecanismo, mismo `walk()`, contra los archivos
  // -dark -- el cssVar resultante (ej. `--card-bg`) es el MISMO string que
  // en light (ver tokens-dark.css: la variable no cambia de nombre bajo
  // `.dark`, solo de valor), lo que cambia es `figmaName`/`collection` a
  // la variable de la colección oscura. El extractor decide cuál mapa usar
  // por nodo (ver run.mjs, `isDark`), esto solo arma los dos índices.
  const byCssVarDark = buildByCssVar(DARK_SOURCE_FILES);
  const byTailwindTypographyClass = buildTypographyClassMap(byCssVar);

  const map = { byCssVar, byCssVarDark, byTailwindTypographyClass };
  writeFileSync(OUT_FILE, JSON.stringify(map, null, 2));

  const total = Object.keys(byCssVar).length;
  const totalDark = Object.keys(byCssVarDark).length;
  const totalTypo = Object.keys(byTailwindTypographyClass).length;
  console.log(`✓ ${OUT_FILE}`);
  console.log(
    `  ${total} tokens en byCssVar, ${totalDark} en byCssVarDark, ${totalTypo} clases de tipografía resueltas.`,
  );

  // Verificación mínima contra §2 del doc: estos 8 tokens deben aparecer,
  // vistos de verdad en transparencia.tsx/niveles.tsx.
  const checklist = [
    "--background-subtle",
    "--card-padding",
    "--card-radius",
    "--border-subtle",
    "--text-primary",
    "--text-secondary",
    "--brand-action",
    "--color-neutral-900",
  ];
  console.log("\n  Checklist §2 del doc:");
  for (const cssVar of checklist) {
    const entry = byCssVar[cssVar];
    console.log(
      entry
        ? `  ✓ ${cssVar} → ${entry.figmaName} (${entry.collection})`
        : `  ✗ ${cssVar} — NO ENCONTRADO`,
    );
  }
}

main();
