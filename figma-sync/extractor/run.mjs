#!/usr/bin/env node
/**
 * Fase 1 del pipeline DOM -> Figma (ver
 * docs/tooling/figma-sync-implementation.md §3).
 *
 * Uso:
 *   node extractor/run.mjs <seccion> [--url http://localhost:3000/vaca]
 *
 * <seccion> es el id del elemento raíz a extraer (sin '#'), ej.
 * "transparencia" o "niveles" -- calzan con las anclas reales del menú en
 * src/app/(marketing)/vaca/page.tsx.
 *
 * Requiere:
 *   - `pnpm dev` corriendo. Default de esta URL: http://localhost:3000/vaca
 *     (puerto default real de `next dev` sin -p ni PORT -- confirmado
 *     contra package.json/.env.local/next.config.ts de este repo, ninguno
 *     lo pisa). OJO: en un intentona anterior en un sandbox de este chat
 *     apareció 3200 en la salida de `pnpm dev` -- ese run tuvo un error de
 *     permisos en el mismo comando (redirección a /tmp falló) y no se
 *     pudo confirmar limpio, así que NO se trata como dato confiable.
 *     Mirá vos el puerto real que imprime tu `pnpm dev` y pasalo con
 *     --url si no es 3000 -- no asumas ninguno de los dos números a ciegas.
 *   - token-map.json ya generado: `npm run build-token-map` en esta misma
 *     carpeta (Fase 0).
 */

import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_MAP_PATH = path.resolve(__dirname, "../token-map.json");
const OUT_DIR = path.resolve(__dirname, "../output");

function parseArgs(argv) {
  const section = argv[2];
  if (!section || section.startsWith("--")) {
    console.error(
      "Uso: node extractor/run.mjs <seccion> [--url http://localhost:3000/vaca]",
    );
    process.exit(1);
  }
  const urlFlagIdx = argv.indexOf("--url");
  const url = urlFlagIdx !== -1 ? argv[urlFlagIdx + 1] : "http://localhost:3000/vaca";
  return { section, url };
}

// Todo lo que corre DENTRO del browser tiene que ser autocontenido -- no
// puede cerrar sobre nada de este scope, por eso el regex y la lógica de
// resolución de tokens se pasan como datos (tokenMap) o se redeclaran acá
// adentro. Ver docs/tooling/figma-sync-implementation.md §3 para el porqué
// de cada decisión (regex sin anclar, tokensEnCalc como fallback explícito,
// SVG sin recorrer, etc.).
function extractInBrowser({ rootSelector, tokenMap }) {
  const root = document.querySelector(rootSelector);
  if (!root) return null;

  const rootRect = root.getBoundingClientRect();
  const VAR_RE = /var\(--([\w-]+)\)/g;
  // Anclado esta vez (`^...$` contra UNA clase a la vez, no la string
  // completa) -- ver el porqué en el comentario de STATE_PREFIX_RE de
  // abajo: dejamos de correr un regex global sin anclar sobre todo
  // `rawClass` porque eso no distinguía una clase con modificador de
  // estado (`disabled:bg-[var(--x)]`) de la clase en reposo
  // (`bg-[var(--y)]`) -- ambas quedaban con el mismo rol "bg", sin marca.
  const CLASS_TOKEN_RE = /^([a-zA-Z][\w]*)-\[var\(--([\w-]+)\)\]$/;

  // Bug real (Button, encontrado en vivo 2026-08-05, ver
  // docs/decisions/0009-... sección del botón): cva compone el className
  // poniendo las clases `disabled:*` de la firma BASE antes que las
  // clases del variant ("default"), así que en el string final
  // renderizado ("disabled:bg-[var(--button-disabled-bg)] ...
  // bg-[var(--button-primary-bg)] ... hover:bg-[var(--button-primary-bg-
  // hover)] ..."), el token disabled queda TEXTUALMENTE primero. El regex
  // viejo (global, sin anclar, sobre la string completa) no distinguía
  // "disabled:bg-[var(...)]" de "bg-[var(...)]" -- a los dos les
  // extraía el mismo rol "bg", en orden de aparición, y el guard de
  // "duplicado" de code.js (pensado para pseudo-elementos before:/
  // after:, ver ADR 0009) se quedaba con el PRIMERO -- el de :disabled,
  // no el real. Confirmado en Figma: el botón importaba con el fill de
  // "button/disabled/text" en vez de "button/primary/text", pese a que
  // el botón real en la web nunca está disabled.
  //
  // Fix: identificar el modificador de CADA clase individualmente (ya
  // separábamos `rawClass` en classes para tipografía, ver
  // resolveTypography) y, si trae un prefijo de estado de interacción
  // (hover/active/focus/disabled/etc.), no compite por su rol -- no entra
  // a `tokens`. El var() igual se registra en `matchedVarNames` (para no
  // aparecer después como falso positivo en `tokensEnCalc`) y queda
  // trazado en `skippedStateTokens`, visible en el JSON de salida por si
  // hace falta revisar a mano. Fuera de alcance a propósito seguir
  // modelando esos estados en Figma (mismo criterio que ADR 0009 con
  // hover/press -- acá se hace explícito en vez de depender de un
  // accidente de orden de string).
  const STATE_PREFIX_RE =
    /^(hover|active|focus|focus-visible|focus-within|disabled|visited|group-hover|group-active|group-focus|group-focus-within|peer-hover|peer-active|peer-focus):/;

  // isDark: cambio 2026-08-05 (ver el comentario grande sobre
  // byCssVarDark en build-token-map.mjs) -- si el nodo tiene un token de
  // color y vive dentro de un `.dark` real, se resuelve primero contra
  // `byCssVarDark` (la variable de Figma de la colección oscura) y solo si
  // esa no existe cae a `byCssVar` (light) como fallback -- mismo criterio
  // "nunca dejar sin bind si hay algo razonable, pero preferir lo
  // correcto" que ya usa `fallbackColor` más abajo en este archivo.
  function resolveTokens(rawClass, isDark) {
    const tokens = [];
    const matchedVarNames = new Set();
    const skippedStateTokens = [];
    const classes = rawClass.split(/\s+/).filter(Boolean);

    for (const c of classes) {
      const isState = STATE_PREFIX_RE.test(c);
      const bare = isState ? c.replace(STATE_PREFIX_RE, "") : c;
      const m = CLASS_TOKEN_RE.exec(bare);
      if (!m) continue;
      const role = m[1];
      const varName = m[2];
      matchedVarNames.add(varName);
      if (isState) {
        skippedStateTokens.push({ role, cssVar: `--${varName}`, state: c.split(":")[0] });
        continue;
      }
      const cssVar = `--${varName}`;
      const entry =
        (isDark && tokenMap.byCssVarDark[cssVar]) || tokenMap.byCssVar[cssVar];
      tokens.push({
        role,
        cssVar,
        figmaName: entry ? entry.figmaName : null,
        bound: Boolean(entry),
      });
    }
    // var() que aparecen en la clase pero NO calzan el patrón completo
    // prefijo-[var(--x)] -- típicamente dentro de un calc(). No se intenta
    // bind automático (ver §3 del doc), se listan aparte.
    const tokensEnCalc = [];
    VAR_RE.lastIndex = 0;
    let vm;
    while ((vm = VAR_RE.exec(rawClass))) {
      if (!matchedVarNames.has(vm[1])) tokensEnCalc.push(`--${vm[1]}`);
    }
    return { tokens, tokensEnCalc, skippedStateTokens };
  }

  // Bug real encontrado probando en Figma: un nodo puede traer más de una
  // clase de tipografía a la vez -- ej. transparencia.tsx:38, "text-
  // display-xl lg:text-display-hero" (cambio a "responsive" del
  // 2026-07-31). Matchear por string exacto contra classList (como hacía
  // esta función antes) nunca encuentra "lg:text-display-hero" -- el
  // prefijo de variant no calza contra la clave "text-display-hero" del
  // mapa -- así que se queda con "text-display-xl" (64px) aunque en el
  // viewport real del extractor esté activo el lg: (104px, "hero"). El
  // nodo terminaba bindeado al tamaño equivocado.
  //
  // Fix: juntar TODAS las clases de tipografía candidatas (con el
  // prefijo de variant despojado antes de buscar en el mapa) y
  // desambiguar contra el tamaño REALMENTE medido del elemento
  // (getComputedStyle), comparando cada candidata contra el valor real
  // de su custom property en :root -- no por convención de "cuál debería
  // ganar", por lo que de verdad está renderizado en este momento.
  function resolveTypography(el, classList) {
    const candidates = [];
    for (const c of classList) {
      const stripped = c.replace(/^[a-z0-9-]+:/, "");
      const entry = tokenMap.byTailwindTypographyClass[stripped];
      if (entry) candidates.push({ className: stripped, ...entry });
    }
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const measuredPx = parseFloat(getComputedStyle(el).fontSize);
    for (const cand of candidates) {
      const rootVal = getComputedStyle(document.documentElement)
        .getPropertyValue(cand.size.cssVar)
        .trim();
      const rootPx = parseFloat(rootVal);
      if (
        !Number.isNaN(rootPx) &&
        !Number.isNaN(measuredPx) &&
        Math.abs(rootPx - measuredPx) < 0.5
      ) {
        return cand;
      }
    }
    // Ninguna calzó exacto (no debería pasar) -- se queda con la primera,
    // mismo comportamiento de antes, para no romper el import.
    return candidates[0];
  }

  function extractNode(el) {
    const tag = el.tagName.toLowerCase();

    // SVG: no se recorre nodo por nodo -- se exporta aparte como asset
    // (ver §3 y §7 del doc: VesselMeter, ícono de check en Niveles, logo).
    if (tag === "svg") {
      const r = el.getBoundingClientRect();
      return {
        tag: "svg",
        rect: {
          x: r.left - rootRect.left,
          y: r.top - rootRect.top,
          width: r.width,
          height: r.height,
        },
        asset: true,
        outerHTML: el.outerHTML,
      };
    }

    const rect = el.getBoundingClientRect();
    const rawClass = el.getAttribute("class") || "";
    const classList = rawClass.split(/\s+/).filter(Boolean);
    // `el.closest('.dark')` -- mismo mecanismo que Tailwind usa para
    // resolver la variante (`@custom-variant dark (&:is(.dark *))`, ver
    // globals.css): matchea el propio elemento O cualquier ancestro real
    // en el documento, no solo dentro del árbol que se está extrayendo --
    // así un nodo queda "dark" aunque el `className="dark"` viva en un
    // ancestro fuera de la sección extraída (no pasa hoy en este repo,
    // pero closest() lo cubre gratis igual).
    const isDark = Boolean(el.closest(".dark"));
    const { tokens, tokensEnCalc, skippedStateTokens } = resolveTokens(rawClass, isDark);
    const typography = resolveTypography(el, classList);

    const children = Array.from(el.children);
    const node = {
      tag,
      rect: {
        x: rect.left - rootRect.left,
        y: rect.top - rootRect.top,
        width: rect.width,
        height: rect.height,
      },
      dark: isDark,
      tokens,
      tokensEnCalc,
      // Solo informativo (ver STATE_PREFIX_RE arriba) -- clases
      // hover:/active:/disabled:/etc. que se detectaron pero deliberadamente
      // no compiten por su rol. No lo consume el plugin (code.js).
      skippedStateTokens,
      typography,
    };

    // Nodo hoja de texto: sin hijos-elemento pero con texto propio.
    if (children.length === 0 && el.textContent && el.textContent.trim().length > 0) {
      node.text = el.textContent.trim();
      const cs = getComputedStyle(el);
      // Respaldo visual, NO fuente de verdad del token -- la fuente de
      // verdad es `typography` de arriba cuando existe.
      node.fallbackFont = {
        family: cs.fontFamily,
        weight: cs.fontWeight,
        size: cs.fontSize,
      };

      // fallbackTextColor (cambio 2026-08-05, bug real: "Echémosle" en
      // Hero entraba NEGRO en vez de blanco): `color` es una propiedad
      // heredable de CSS -- un `<span>` sin su propio `text-[var(...)]`
      // (como este, ver hero-vaca.tsx) hereda el color de un ancestro
      // (acá, `text-[var(--hero-text)]` del `<section>` raíz). El regex de
      // `resolveTokens` solo mira el className de ESTE nodo, nunca sube a
      // buscar de dónde viene el color heredado -- así que sin esto, el
      // nodo queda sin ningún token de rol "text", y un TextNode nuevo de
      // Figma nace con su fill NEGRO default (a diferencia de los frames,
      // que sí se vacían explícitamente en el plugin -- ver code.js). Se
      // guarda el `color` YA RESUELTO por el navegador (incluye
      // herencia), mismo mecanismo que `fallbackColor` unas líneas más
      // abajo para el fondo -- el plugin solo lo usa si el nodo no trae
      // un token real de rol "text".
      if (!tokens.some((t) => t.role === "text")) {
        node.fallbackTextColor = cs.color;
      }

      // padding (cambio 2026-08-05, para el caso "badge": un nodo de texto
      // que ADEMÁS tiene su propio bg/fill, ej. el `<p>` "Echémosle la
      // vaca" -- bg-[var(--color-amarillo-500)] + text-[var(--surface-
      // ink)] en el MISMO elemento, sin hijos, ver niveles.tsx). El plugin
      // (code.js) arma un frame (fondo) + texto hijo (color propio) para
      // esos casos -- necesita saber cuánto padding real tenía el
      // elemento para no tapar el texto con el borde del frame. Se guarda
      // siempre en cualquier hoja de texto (barato, no solo en badges):
      // no tiene costo usarlo condicionalmente del lado del plugin.
      node.padding = {
        left: parseFloat(cs.paddingLeft) || 0,
        top: parseFloat(cs.paddingTop) || 0,
        right: parseFloat(cs.paddingRight) || 0,
        bottom: parseFloat(cs.paddingBottom) || 0,
      };
    }

    // Nodo sin tokens de color detectados y sin texto: guardar el color de
    // fondo computado como fallback para no dejarlo sin pintar en Figma,
    // marcado explícitamente como no-bound.
    const hasColorToken = tokens.some((t) => ["bg", "fill", "text"].includes(t.role));
    if (!hasColorToken && children.length === 0) {
      const cs = getComputedStyle(el);
      if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") {
        node.fallbackColor = cs.backgroundColor;
      }
    }

    node.children = children.map(extractNode);
    return node;
  }

  const tree = extractNode(root);

  // Fondo ambiente del ROOT (cambio 2026-08-05, bug real reportado en vivo:
  // "no se ve el texto" en Manifiesto -- la sección en el sitio real no
  // tiene su propio `bg-[var(...)]`, se apoya en el blanco del <body>. El
  // guard de `fallbackColor` de arriba SOLO corre en nodos hoja
  // (`children.length === 0`) -- correcto para evitar pintar de blanco
  // sólido cualquier div interno que en realidad debería quedar
  // transparente y dejar ver el fill de SU padre en Figma (que sí importó
  // bien). Pero el ROOT de la extracción no tiene padre del lado de Figma
  // (se appendea directo a `figma.currentPage`) -- si el root tampoco
  // tiene bg-token propio, en Figma queda con `fills = []` (transparente)
  // y se ve el canvas de Figma detrás en vez del fondo real de la página,
  // que en este sitio es blanco. Se resuelve con el MISMO criterio visual
  // que usa el navegador: subir por `parentElement` hasta encontrar el
  // primer `background-color` no transparente (folos los ancestros REALES
  // del documento, no solo los que caen dentro del árbol extraído).
  if (!tree.tokens.some((t) => ["bg", "fill"].includes(t.role)) && !tree.fallbackColor) {
    let cur = root;
    let bg = null;
    while (cur) {
      const c = getComputedStyle(cur).backgroundColor;
      if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") {
        bg = c;
        break;
      }
      cur = cur.parentElement;
    }
    // Si NINGÚN ancestro real tiene un bg explícito (caso típico: todo el
    // documento depende del blanco default del navegador, sin
    // background-color en ningún nivel), blanco es la aproximación
    // correcta -- es lo que el usuario ve de verdad en pantalla.
    tree.fallbackColor = bg || "rgb(255, 255, 255)";
  }

  return tree;
}

async function main() {
  const { section, url } = parseArgs(process.argv);

  if (!existsSync(TOKEN_MAP_PATH)) {
    console.error(
      `✗ No existe ${TOKEN_MAP_PATH}. Corré primero: npm run build-token-map (Fase 0).`,
    );
    process.exit(1);
  }
  const tokenMap = JSON.parse(readFileSync(TOKEN_MAP_PATH, "utf8"));

  console.log(`→ Abriendo ${url} ...`);
  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    console.error(
      `✗ No se pudo lanzar Chromium. Si el error menciona una librería faltante ` +
        `(libXdamage, libnss3, etc.), correr "sudo npx playwright install-deps" ` +
        `(o el equivalente sin sudo si no tenés permisos de root -- ver README). ` +
        `Detalle: ${err.message.split("\n")[0]}`,
    );
    process.exit(1);
  }
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle" });
  } catch (err) {
    console.error(
      `✗ No se pudo cargar ${url}. ¿Está "pnpm dev" corriendo? Y si está corriendo: ` +
        `¿en qué puerto lo imprimió realmente en su propia terminal ("Local: http://localhost:XXXX")? ` +
        `No asumas 3000 -- confirmalo ahí y pasalo con --url si difiere. Detalle: ${err.message}`,
    );
    await browser.close();
    process.exit(1);
  }

  const selector = `#${section}`;
  const tree = await page.evaluate(extractInBrowser, {
    rootSelector: selector,
    tokenMap,
  });
  await browser.close();

  if (!tree) {
    console.error(
      `✗ No se encontró ningún elemento con selector "${selector}" en ${url}.`,
    );
    process.exit(1);
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `${section}.json`);
  writeFileSync(outFile, JSON.stringify(tree, null, 2));

  // Resumen rápido: cuántos tokens se resolvieron vs. cuántos quedaron
  // sueltos (bound: false) -- para saber de entrada si hay nombres para
  // corregir antes de pasar al plugin de Figma.
  let boundCount = 0;
  let unboundCount = 0;
  let svgCount = 0;
  let darkNodeCount = 0;
  (function walk(node) {
    if (node.asset) {
      svgCount++;
      return;
    }
    if (node.dark) darkNodeCount++;
    for (const t of node.tokens ?? []) t.bound ? boundCount++ : unboundCount++;
    for (const child of node.children ?? []) walk(child);
  })(tree);

  console.log(`✓ ${outFile}`);
  console.log(
    `  ${boundCount} tokens resueltos, ${unboundCount} sin match en token-map, ${svgCount} SVG (assets aparte), ${darkNodeCount} nodos dark.`,
  );
  if (unboundCount > 0) {
    console.log(
      `  ⚠  Hay tokens sin match -- revisar el JSON antes de pasarlo al plugin.`,
    );
  }
}

main();
