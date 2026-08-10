/**
 * format-tailwind-typography.js
 * ══════════════════════════════════════════════════════════════════════
 * Formato custom de Style Dictionary v4 (API basada en `hooks`, no en
 * StyleDictionary.registerFormat estático — ese método ya no existe en v4).
 *
 * Genera la sección tipográfica de theme-bridge.css a partir de los
 * tokens `typography-styles-*-size` / `-line-height`, con la sintaxis
 * PAREADA correcta que exige Tailwind v4:
 *
 *   --text-label-xs: 10px;
 *   --text-label-xs--line-height: 12.5px;
 *
 * en vez de una sola variable con coma (`10px, 12.5px`), que es CSS
 * inválido y hace que el navegador descarte todo el font-size — ese
 * fue el bug que rompió cada text-label-* / text-display-* del sitio.
 * ══════════════════════════════════════════════════════════════════════
 */

module.exports = function tailwindTypographyBridgeFormat({ dictionary }) {
  // Agrupamos por "familia" (ej. "display-hero", "label-xs", "body-md")
  // buscando pares size/line-height que compartan el mismo prefijo.
  const families = new Map();

  dictionary.allTokens.forEach((token) => {
    const match = token.name.match(
      /^typography-styles-(.+)-(size|line-height|letter-spacing)$/,
    );
    if (!match) return;
    const [, family, prop] = match;
    if (!families.has(family)) families.set(family, {});
    families.get(family)[prop] = token.name;
  });

  // Mapeo family -> nombre de utility Tailwind (--text-*)
  const familyToUtility = (family) => {
    if (family.startsWith("display-")) return `text-${family}`;
    if (family.startsWith("heading-h")) return `text-h${family.replace("heading-h", "")}`;
    if (family.startsWith("body-")) return `text-${family}`;
    if (family.startsWith("label-")) return `text-${family}`;
    if (family.startsWith("overline-")) return `text-${family}`;
    return null; // code-*, body-*-bold, etc. no se exponen como utility de Tailwind
  };

  const lines = [];
  for (const [family, tokens] of families) {
    const utility = familyToUtility(family);
    if (!utility || !tokens.size) continue;

    lines.push(`  --${utility}: var(--typography-styles-${family}-size);`);
    if (tokens["line-height"]) {
      lines.push(
        `  --${utility}--line-height: var(--typography-styles-${family}-line-height);`,
      );
    }
    // NOTA: no mapeamos letter-spacing aquí a propósito. Los tokens
    // `typography-styles-*-letter-spacing` en tokens.css son números
    // sin unidad (ej. -3.12, 0.84), y `letter-spacing` en CSS exige
    // una unidad (px/em). Mapearlos tal cual generaría otro valor
    // inválido silenciosamente descartado — el mismo tipo de bug que
    // esto busca eliminar. Antes de automatizarlo, esos tokens fuente
    // necesitan traer su unidad (ej. -3.12px o -0.03em) en tipografia.json.
  }

  return `/* AUTO-GENERADO por format-tailwind-typography.js — no editar a mano */\n@theme inline {\n${lines.join("\n")}\n}\n`;
};
