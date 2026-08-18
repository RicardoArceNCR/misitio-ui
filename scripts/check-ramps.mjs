#!/usr/bin/env node
/**
 * Guardarrail de rampas de color sobre el CSS ya compilado.
 *
 * Mismo criterio que check-units.mjs: se valida la SALIDA, no la fuente,
 * porque lo que rompe al consumidor es el CSS. Y sin dependencias: este
 * repo solo tiene style-dictionary y nodemon.
 *
 * Existe por un bug real (ver ADR 0012 en misitio): color/neutral venia
 * calido en 50-700 (hue ~40 grados) y saltaba a azul en 800-950 (hue ~200,
 * croma x12). Nadie lo detecto en review porque un diff de 11 hex no se
 * lee como una discontinuidad — hay que medirla. Los consumidores lo
 * pagaban como "el borde de las cards tira a azul" y lo parcheaban con
 * overrides locales, que es exactamente lo que un design system existe
 * para evitar.
 *
 * Cuatro reglas, todas verificables:
 *
 *   1. MONOTONIA — dentro de una familia, la luminancia baja de 50 a 950.
 *      Una rampa que sube y baja no sirve para derivar jerarquia visual:
 *      "un paso mas oscuro" deja de significar algo.
 *   2. CONTINUIDAD DE MATIZ — entre stops vecinos con croma suficiente,
 *      el hue no salta mas de MAX_DHUE grados. Una familia es una familia.
 *   3. CONTINUIDAD DE CROMA — la saturacion no salta mas de MAX_C_RATIO
 *      entre vecinos. Caza el empalme de dos familias aun cuando el stop
 *      claro sea demasiado gris para tener un hue medible — que es
 *      exactamente el caso de neutral/700 -> neutral/800.
 *   4. NEUTRAL ES NEUTRAL — la familia `neutral` no supera MAX_C_NEUTRAL
 *      de croma en ningun stop. Un gris con tinte deja de servir como
 *      gris: compite con la marca en vez de sostenerla.
 *
 * Las cuatro se apagan por familia con una entrada en ALLOW y un motivo
 * escrito. Igual que en check-units.mjs, esa lista es la unica via para
 * que algo pase, y obliga a justificar por escrito en vez de en el chat.
 *
 * QUE NO CHEQUEA, A PROPOSITO: la regularidad del paso de luminancia.
 * Se probo y se descarto — las rampas reales son densas a proposito en el
 * extremo claro (mas grises utiles para fondos y bordes). La propia
 * paleta `neutral` de Tailwind v4 tiene un ratio de 10.8x entre su paso
 * mas grande y el mas chico; una regla que marca a Tailwind entrena a la
 * gente a ignorar la salida del chequeo, que es peor que no tenerlo.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["build/tokens.css"];

/* Umbrales calibrados contra rampas reales, no elegidos a ojo.
   Medidos sobre amber/sky/clay/jade de la propuesta (las 4 "sanas"):
     - salto de hue entre vecinos:      max 5 grados   -> tolerancia 30
     - ratio de croma entre vecinos:    max 2.3x       -> tolerancia 3
     - croma del neutral calido actual: max 0.0062 en 50-700 (aceptable)
                                        0.0242 en 800  (el bug)
                                        -> corte en 0.01: deja pasar un
                                        neutral sutilmente calido, corta
                                        los 3 stops rotos.
   Cada tolerancia deja margen >=30% sobre el peor caso sano. */
const MAX_DHUE = 30; // grados entre stops vecinos
const MIN_C_HUE = 0.01; // debajo de esto el hue es ruido numerico
const MAX_C_RATIO = 3; // salto de croma entre vecinos
const MIN_C_RATIO_FLOOR = 0.01; // no evaluar ratio si ambos son casi gris
const MAX_C_NEUTRAL = 0.01; // croma maximo tolerado en `neutral`

// Cada entrada necesita motivo. Sin motivo, no entra.
//
// Esta lista NO es "cosas que decidimos ignorar": es el backlog visible.
// Cada entrada es un bug conocido con dueno y destino. Se borra la linea
// cuando el bug se arregla — si al arreglar la Fase 5 el chequeo sigue
// verde con estas lineas puestas, es que el arreglo no llego.
const ALLOW = [
  {
    family: "amarillo",
    rule: "monotonia",
    why: "amarillo/300->400 la luminancia sube. Los stops 50-300 y 700-950 son copia literal de leaf; solo 400-600 son amarillo real. Pendiente ADR 0013.",
  },
  {
    family: "amarillo",
    rule: "continuidad",
    why: "saltos de matiz de 35 y 41 grados, misma causa que la entrada de arriba. Pendiente ADR 0013.",
  },
  {
    family: "info",
    rule: "croma",
    why: "info/50 (#f7fbfe) esta casi blanco y su croma salta 3.7x contra info/100. Se corrige al recalibrar la familia. Pendiente ADR 0013.",
  },
];

const allowed = (family, rule) =>
  ALLOW.some((a) => a.family === family && a.rule === rule);

/* ── sRGB → OKLCh (Bjorn Ottosson). Sin dependencias. ───────────────── */
const toLinear = (c) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

function hexToOklch(hex) {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const [r, g, b] = [0, 2, 4].map((i) =>
    toLinear(parseInt(full.slice(i, i + 2), 16) / 255),
  );

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const C = Math.hypot(A, B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}

const dHue = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/* ── Parseo: --color-<familia>-<stop>: #hex ─────────────────────────── */
function parseRamps(css) {
  const ramps = new Map();
  const re = /--color-([a-z0-9]+)-(\d+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g;
  for (const [, family, stop, hex] of css.matchAll(re)) {
    if (hex.replace("#", "").length > 6) continue; // con alfa: fuera de alcance
    if (!ramps.has(family)) ramps.set(family, new Map());
    ramps.get(family).set(Number(stop), hex.toLowerCase()); // ultima gana
  }
  return ramps;
}

/* ── Chequeo ────────────────────────────────────────────────────────── */
const errors = [];
const checked = [];

for (const file of FILES) {
  const css = readFileSync(path.join(root, file), "utf8");

  for (const [family, stopsMap] of parseRamps(css)) {
    const stops = [...stopsMap.keys()].sort((a, b) => a - b);
    if (stops.length < 3) continue;

    const pts = stops.map((s) => ({
      stop: s,
      hex: stopsMap.get(s),
      ...hexToOklch(stopsMap.get(s)),
    }));
    checked.push(`${family} (${stops.length} stops)`);

    // 1. monotonia de luminancia
    if (!allowed(family, "monotonia")) {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if (b.L >= a.L) {
          errors.push(
            `${file}: ${family}/${a.stop} (${a.hex}, L=${a.L.toFixed(3)}) -> ` +
              `${family}/${b.stop} (${b.hex}, L=${b.L.toFixed(3)}): la ` +
              `luminancia no baja. Una rampa no monotona no sirve para ` +
              `derivar jerarquia visual.`,
          );
        }
      }
    }

    // 2. continuidad de matiz
    if (!allowed(family, "continuidad")) {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if (a.C < MIN_C_HUE || b.C < MIN_C_HUE) continue;
        const d = dHue(a.H, b.H);
        if (d > MAX_DHUE) {
          errors.push(
            `${file}: ${family}/${a.stop} (${a.hex}, hue ${a.H.toFixed(0)}) -> ` +
              `${family}/${b.stop} (${b.hex}, hue ${b.H.toFixed(0)}): salto de ` +
              `${d.toFixed(0)} grados, maximo ${MAX_DHUE}. Dos familias ` +
              `distintas pegadas en una sola rampa.`,
          );
        }
      }
    }

    // 3. continuidad de croma — la regla que caza un empalme de familias
    //    aunque el stop claro sea demasiado gris para tener hue medible.
    //    Es el caso de neutral/700 (C=0.004) -> neutral/800 (C=0.024).
    if (!allowed(family, "croma")) {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if (Math.max(a.C, b.C) < MIN_C_RATIO_FLOOR) continue;
        const ratio = Math.max(a.C, b.C) / Math.max(Math.min(a.C, b.C), 1e-6);
        if (ratio > MAX_C_RATIO) {
          errors.push(
            `${file}: ${family}/${a.stop} (${a.hex}, C=${a.C.toFixed(4)}) -> ` +
              `${family}/${b.stop} (${b.hex}, C=${b.C.toFixed(4)}): el croma ` +
              `salta ${ratio.toFixed(1)}x, maximo ${MAX_C_RATIO}. La saturacion ` +
              `de una familia cambia de a poco; un salto asi es otra familia.`,
          );
        }
      }
    }

    // 4. neutral es neutral
    if (family === "neutral" && !allowed(family, "acromatico")) {
      for (const p of pts) {
        if (p.C > MAX_C_NEUTRAL) {
          errors.push(
            `${file}: neutral/${p.stop} (${p.hex}) tiene croma ` +
              `${p.C.toFixed(3)}, maximo ${MAX_C_NEUTRAL}. Un neutral con ` +
              `tinte compite con la marca en vez de sostenerla.`,
          );
        }
      }
    }
  }
}

if (errors.length) {
  console.error(`\ncheck-ramps: ${errors.length} problema(s)\n`);
  for (const e of errors) console.error("  - " + e);
  console.error(
    `\nSi alguno es intencional, agregalo a ALLOW en scripts/check-ramps.mjs ` +
      `con el motivo escrito.\n`,
  );
  process.exit(1);
}

console.log(`check-ramps: OK — ${checked.join(", ")}`);
