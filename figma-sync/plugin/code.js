/**
 * Fase 2 del pipeline DOM -> Figma (ver
 * docs/tooling/figma-sync-implementation.md §4).
 *
 * Deliberadamente JS plano, no TypeScript: es un plugin chico y no vale la
 * pena meter un paso de compilación (tsc/esbuild) para esto todavía --
 * mismo criterio "bajo demanda" que el resto del repo. Si esto crece,
 * migrar a code.ts es un paso aislado, no un rediseño.
 *
 * Lee un árbol como el que emite extractor/run.mjs (Fase 1) y:
 *   - crea un frame/texto/asset por nodo, con x/y/width/height reales
 *     (no placeholders -- ver nota sobre el VesselMeter abajo)
 *   - ata fills/strokes/corner-radius/font-size a la variable de Figma
 *     real cuando existe (setBoundVariableForPaint / setBoundVariable)
 *   - lo que el MVP decidió NO bindear (shadow, padding/gap sin Auto
 *     Layout, line-height) se detecta y se reporta, nunca se intenta a la
 *     fuerza ni se pierde en silencio
 *
 * Toda la lógica confía en que el nombre de la variable en este archivo
 * de Figma coincide EXACTO con el figmaName que armó la Fase 0
 * (build-token-map.mjs) -- esa es la apuesta central del ADR 0009. Si un
 * nombre no matchea, cae en report.notFoundInFigma, no rompe el import
 * completo.
 */

figma.showUI(__html__, { width: 440, height: 620 });

figma.ui.onmessage = async (msg) => {
  if (msg.type !== "import") return;

  try {
    const tree = msg.tree;
    const [variables, collections] = await Promise.all([
      figma.variables.getLocalVariablesAsync(),
      figma.variables.getLocalVariableCollectionsAsync(),
    ]);
    const report = {
      bound: 0,
      skippedByDesign: [],
      notFoundInFigma: [],
      nameCollisions: [],
    };

    // Dos mapas, no uno (cambio 2026-08-05 -- antes esto excluía TODA
    // colección "-dark" de plano, ver ADR 0009 §7 "fuera de alcance"):
    // "background/page" (y muchos otros) existen en semanticos Y
    // semanticos-dark CON EL MISMO NOMBRE -- si se mete todo en un solo
    // Map por nombre, una colección pisa a la otra sin ningún criterio
    // (confirmado en una corrida real contra transparencia.json: 183
    // colisiones). La Fase 1 (extractor) ahora marca cada nodo con
    // `node.dark` (si vive dentro de un `.dark` real del sitio) y resuelve
    // su `figmaName` contra `byCssVarDark` cuando corresponde -- acá el
    // trabajo es solo elegir el Map correcto por nodo, `byNameLight` o
    // `byNameDark`, nunca mezclarlos.
    const darkCollectionIds = new Set(
      collections.filter((c) => c.name.endsWith("-dark")).map((c) => c.id),
    );

    const byNameLight = new Map();
    const byNameDark = new Map();
    for (const v of variables) {
      const isDarkCollection = darkCollectionIds.has(v.variableCollectionId);
      const target = isDarkCollection ? byNameDark : byNameLight;
      if (target.has(v.name)) {
        report.nameCollisions.push(
          `${v.name} (colección id ${v.variableCollectionId}, ${isDarkCollection ? "dark" : "light"})`,
        );
      }
      target.set(v.name, v);
    }
    const byName = { light: byNameLight, dark: byNameDark };

    const rootNode = await buildNode(tree, tree.rect, byName, report);

    // Auto-posicionar el import DEBAJO de lo que ya hay en la página
    // (cambio 2026-08-05, pedido explícito "quiero importar todas las
    // secciones... como se ve en la web"): antes `rootNode.x/y` quedaba en
    // (0,0) siempre (self-relativo desde `buildNode(tree, tree.rect, ...)`
    // -- root vs. su propio rect da 0,0), así que cada import nuevo pisaba
    // literalmente lo que ya estuviera ahí -- bug real confirmado
    // importando Manifiesto arriba de Transparencia. Apilar por Y contra
    // el bounding box real de TODO lo que ya vive en `figma.currentPage`
    // (no solo el último import) reproduce el orden real de scroll de la
    // página SIEMPRE QUE se importen las secciones en el mismo orden en
    // que aparecen en el sitio (hero, niveles, niveles-tarjetas,
    // manifiesto, transparencia, faq) -- el plugin no conoce ese orden,
    // es responsabilidad de quien importa.
    // `x = 0` fijo (no alineado a la izquierda del último import): todas
    // las secciones quedan en una sola columna vertical, como el scroll
    // real de la página, sin importar que difieran en ancho.
    const GAP = 80; // aire entre imports en el canvas -- ajustable, no un token de diseño real
    const existing = figma.currentPage.children;
    const offsetY =
      existing.length > 0 ? Math.max(...existing.map((n) => n.y + n.height)) + GAP : 0;
    rootNode.x = 0;
    rootNode.y = offsetY;

    figma.currentPage.appendChild(rootNode);
    figma.viewport.scrollAndZoomIntoView([rootNode]);

    figma.ui.postMessage({ type: "done", report });
  } catch (err) {
    figma.ui.postMessage({
      type: "error",
      message: String(err && err.message ? err.message : err),
    });
  }
};

/**
 * ancestorRect: el rect (en el mismo espacio de coordenadas que node.rect
 * -- todos relativos a la raíz de la extracción, NO al padre inmediato,
 * ver extractor/run.mjs) del frame en el que este nodo se va a appendear.
 * Los rects del JSON son todos relativos a la raíz de la sección
 * extraída, así que acá se recalcula la posición relativa al padre real
 * que Figma necesita.
 */
async function buildNode(node, ancestorRect, byName, report) {
  // SVG: no se reconstruye nodo por nodo -- se importa el outerHTML tal
  // cual con createNodeFromSvg, con el tamaño REAL extraído del DOM
  // (node.rect.width/height, no un placeholder a ojo). Para el
  // VesselMeter esto da 192x219 -- el tamaño real medido en el sitio, no
  // el viewBox interno del SVG (140x160).
  if (node.asset) {
    const svgNode = figma.createNodeFromSvg(node.outerHTML);
    svgNode.x = node.rect.x - ancestorRect.x;
    svgNode.y = node.rect.y - ancestorRect.y;
    svgNode.resize(Math.max(1, node.rect.width), Math.max(1, node.rect.height));
    return svgNode;
  }

  const isText = node.text !== undefined;

  // Nodo "badge" (cambio 2026-08-05, bug real: "Echémosle la vaca" en
  // Niveles -- `<p class="bg-[var(--color-amarillo-500)] ...
  // text-[var(--surface-ink)]">`, fondo Y texto propio en el MISMO
  // elemento, sin hijos): un `TextNode` de Figma tiene un solo `.fills`
  // (el glifo) -- no hay dónde poner un fondo aparte. `PROP_BY_ROLE` en
  // `applyTokens` mapea bg/fill/text los TRES a "fills" -- en un nodo así
  // el primer token (bg, amarillo) se comía el fill del TEXTO (letras
  // amarillas, sin caja) y el segundo (el color real del texto) se
  // descartaba como "duplicado" (guard pensado para pseudo-elementos
  // before:/after:, que acá no aplica: son dos roles legítimos, no un
  // duplicado espurio). Fix: si el nodo tiene texto propio Y su propio
  // bg/fill, se arma un FRAME (el fondo) con un TextNode HIJO (el color
  // de texto real) -- dos capas de Figma, no una.
  const bgToken = (node.tokens ?? []).find(
    (t) => ["bg", "fill"].includes(t.role) && t.bound,
  );
  if (isText && bgToken) {
    return buildBadgeNode(node, ancestorRect, byName, report);
  }

  // Nota: un nodo de texto normal (como el "." de Niveles) entra por acá
  // igual que cualquier <p>/<h2>/<td> -- no necesita rama de asset. La
  // corrección de la sesión anterior (no era un ícono SVG) significa
  // exactamente esto: cero código especial, el bind de color por rol
  // "text" ya lo cubre como a cualquier otro texto.
  const target = isText ? figma.createText() : figma.createFrame();
  if (!isText) {
    target.fills = [];
    // clipsContent = false (cambio 2026-08-05, bug real confirmado contra
    // niveles.json: las 3 tarjetas de precio no aparecían "nada, ni una
    // sola" en Figma). Causa: el wrapper `sm:contents` de niveles.tsx mide
    // 0x0 en el DOM -- correcto, es justo lo que hace `display: contents`
    // (el elemento no genera caja propia, solo sus hijos participan del
    // layout del abuelo) -- pero acá igual se crea un Frame y se redimensiona
    // a 1x1px (`Math.max(1, ...)` más abajo). Un Frame de Figma nuevo nace
    // con `clipsContent = true`: todo lo que sus hijos dibujen FUERA de esa
    // caja de 1x1 se recorta -- y los 3 hijos (tarjetas reales, x=334/652/
    // 970, 294x546 cada una) quedan posicionados correctamente pero
    // completamente invisibles, clipeados por su propio padre. No es
    // exclusivo de este caso puntual: cualquier nodo "layout-transparente"
    // (rect propio degenerado con hijos reales) tendría el mismo problema,
    // así que se desactiva el clipping para TODO frame que arma este
    // pipeline -- ninguna sección de este sitio depende hoy de que Figma
    // recorte contenido (el único caso real de overflow:hidden, el loop de
    // FitText, ya está fuera de alcance a propósito, ver ADR 0009).
    target.clipsContent = false;
  }

  target.name = node.tag + (isText ? `: "${String(node.text).slice(0, 24)}"` : "");
  target.x = node.rect.x - ancestorRect.x;
  target.y = node.rect.y - ancestorRect.y;

  if (isText) {
    // OJO: un TextNode nuevo nace con textAutoResize = 'WIDTH_AND_HEIGHT'
    // (default de Figma) -- en ese modo, resize() TIRA ERROR (no falla
    // en silencio, aborta). Por eso el resize real de un nodo de texto
    // vive DENTRO de applyText, después de poner textAutoResize = 'NONE'
    // (que a su vez necesita la fuente ya cargada) -- nunca acá.
    await applyText(target, node, byName, report);
  } else {
    target.resize(Math.max(1, node.rect.width), Math.max(1, node.rect.height));
  }

  await applyTokens(target, node, byName, report);

  if (!isText) {
    for (const child of node.children ?? []) {
      const childNode = await buildNode(child, node.rect, byName, report);
      target.appendChild(childNode);
    }
  }

  return target;
}

/**
 * buildBadgeNode: ver el comentario grande en buildNode sobre por qué
 * hace falta esto (un nodo con texto propio Y su propio bg/fill no cabe
 * en un solo TextNode de Figma). Arma un FRAME (fondo, borde, radius --
 * los roles que le corresponden a la CAJA) con un TextNode hijo adentro
 * (el color/tipografía del TEXTO real) -- cada uno recibe SOLO los tokens
 * de su propio rol, filtrados del array completo del nodo original.
 */
async function buildBadgeNode(node, ancestorRect, byName, report) {
  const frame = figma.createFrame();
  frame.name = `${node.tag} (badge): "${String(node.text).slice(0, 24)}"`;
  frame.x = node.rect.x - ancestorRect.x;
  frame.y = node.rect.y - ancestorRect.y;
  frame.resize(Math.max(1, node.rect.width), Math.max(1, node.rect.height));
  frame.fills = [];

  const cajaTokens = (node.tokens ?? []).filter((t) => t.role !== "text");
  await applyTokens(
    frame,
    { ...node, tokens: cajaTokens, fallbackColor: node.fallbackColor },
    byName,
    report,
  );

  const textChild = figma.createText();
  await applyText(textChild, node, byName, report);
  // applyText ya dejó textAutoResize='NONE' + resize con el rect DE AFUERA
  // (el `<p>` completo, con padding incluido) -- acá corresponde el
  // tamaño de ADENTRO del padding real (ver `node.padding`, capturado en
  // el extractor con getComputedStyle). Sin esto el texto se dibuja
  // pisando el borde del frame en vez de quedar centrado como en el sitio
  // real.
  const pad = node.padding ?? { left: 0, top: 0, right: 0, bottom: 0 };
  textChild.x = pad.left;
  textChild.y = pad.top;
  textChild.resize(
    Math.max(1, node.rect.width - pad.left - pad.right),
    Math.max(1, node.rect.height - pad.top - pad.bottom),
  );

  const textTokens = (node.tokens ?? []).filter((t) => t.role === "text");
  await applyTokens(
    textChild,
    {
      ...node,
      tokens: textTokens,
      fallbackColor: undefined,
      fallbackTextColor: node.fallbackTextColor,
    },
    byName,
    report,
  );

  frame.appendChild(textChild);
  return frame;
}

async function applyText(target, node, byName, report) {
  const rawFamily = (node.fallbackFont && node.fallbackFont.family) || "Inter";
  // "Red Hat Display, \"Red Hat Display Fallback\"" -> "Red Hat Display"
  const family = rawFamily
    .split(",")[0]
    .replace(/["']/g, "")
    .replace(/ Fallback$/i, "")
    .trim();
  const style = weightToStyle((node.fallbackFont && node.fallbackFont.weight) || "400");

  try {
    await figma.loadFontAsync({ family, style });
    target.fontName = { family, style };
  } catch {
    // La fuente de marca (Red Hat Display, JetBrains Mono, Anton) puede no
    // estar instalada en el archivo de Figma del usuario -- no es un bug
    // del plugin, es una dependencia externa. Fallback a Inter (siempre
    // disponible en Figma) y se reporta, no se rompe el import completo.
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    target.fontName = { family: "Inter", style: "Regular" };
    report.skippedByDesign.push(
      `Fuente "${family}" no disponible en este archivo de Figma -- "${String(node.text).slice(0, 30)}" quedó en Inter, revisar a mano.`,
    );
  }

  // Recién con la fuente cargada: pasar a tamaño manual y fijar el rect
  // real extraído del DOM. Si esto corriera antes de loadFontAsync/
  // fontName, o si nunca se tocara textAutoResize, Figma seguiría
  // autoajustando la caja al contenido -- exactamente el placeholder que
  // se evitó a propósito para el SVG del VesselMeter, pero sin resolver
  // acá para texto.
  target.textAutoResize = "NONE";
  target.resize(Math.max(1, node.rect.width), Math.max(1, node.rect.height));

  target.characters = String(node.text);
  if (node.fallbackFont && node.fallbackFont.size) {
    const px = parseFloat(node.fallbackFont.size);
    if (!Number.isNaN(px)) target.fontSize = px;
  }

  if (node.typography) {
    // Tipografía siempre contra `byName.light`: `tipografia.json` no tiene
    // versión `-dark` (el type-scale no cambia por modo, solo el color) --
    // ver build-token-map.mjs, DARK_SOURCE_FILES no lo incluye.
    await bindNumericIfExists(
      target,
      "fontSize",
      node.typography.size && node.typography.size.figmaName,
      byName.light,
      report,
    );
    if (node.typography.lineHeight) {
      // El LineHeight de Figma no es un FLOAT plano (es {unit, value}) --
      // setBoundVariable('lineHeight', variable) no aplica igual que con
      // fontSize. Se deja para bind manual, no se intenta a la fuerza.
      report.skippedByDesign.push(
        `${node.typography.lineHeight.figmaName} (line-height -- formato de Figma no es bindeable como fontSize, revisar a mano)`,
      );
    }
  }
}

async function applyTokens(target, node, byName, report) {
  // claimedProps: qué propiedad de Figma (fills/strokes) ya recibió un
  // bind real en este nodo. Caso real encontrado probando en Figma: el
  // div de la card de Transparencia trae 5 tokens -- card-bg, card-
  // padding, card-shadow, y background-subtle DOS VECES (de los
  // pseudo-elementos before:/after: del zigzag decorativo). La Fase 1 no
  // distingue "fill del nodo real" de "fill de un pseudo-elemento que
  // esta extracción no puede representar como capa propia" -- sin este
  // guard, bindPaint pisaba fills en cada iteración y el último de la
  // lista ganaba siempre (background-subtle), no el semánticamente
  // correcto (card-bg). Heurística, no garantía: asume que el token del
  // elemento real viene antes que los de before:/after: en el className
  // -- cierto en el código real de este repo, pero si alguna vez no lo
  // fuera, el bind seguiría siendo el primero de la lista, no un pisado
  // silencioso al azar -- y quedaría reportado acá para revisar.
  const claimedProps = new Set();
  const PROP_BY_ROLE = { bg: "fills", fill: "fills", text: "fills", border: "strokes" };

  // Nodo dark → preferir la variable de la colección oscura; si esa
  // colección no tiene esta variable puntual (mirror incompleto, ver
  // build-token-map.mjs), caer a light antes de darlo por no-encontrado
  // (cambio 2026-08-05 -- cubre el caso real semanticos-dark con 75 hojas
  // contra 78 de semanticos, no es un mirror 1:1 perfecto).
  const map = node.dark ? byName.dark : byName.light;

  for (const t of node.tokens ?? []) {
    if (!t.bound) continue; // ya venía sin match desde la Fase 0/1, ni se intenta acá
    const variable = map.get(t.figmaName) || byName.light.get(t.figmaName);
    if (!variable) {
      report.notFoundInFigma.push(t.figmaName);
      continue;
    }

    const prop = PROP_BY_ROLE[t.role];
    if (prop && claimedProps.has(prop)) {
      report.skippedByDesign.push(
        `${t.figmaName} (segundo token de "${t.role}" en el mismo nodo -- probablemente un pseudo-elemento before:/after: sin capa propia acá; se mantuvo el primero)`,
      );
      continue;
    }

    switch (t.role) {
      case "bg":
      case "fill":
        bindPaint(target, "fills", variable);
        claimedProps.add("fills");
        report.bound++;
        break;
      case "text":
        if (target.type === "TEXT") {
          bindPaint(target, "fills", variable);
          claimedProps.add("fills");
          report.bound++;
        } else {
          report.skippedByDesign.push(
            `${t.figmaName} (role "text" en un nodo <${node.tag}> que no es texto -- revisar a mano)`,
          );
        }
        break;
      case "border":
        bindPaint(target, "strokes", variable);
        claimedProps.add("strokes");
        report.bound++;
        break;
      case "rounded":
        if ("topLeftRadius" in target) {
          for (const corner of [
            "topLeftRadius",
            "topRightRadius",
            "bottomLeftRadius",
            "bottomRightRadius",
          ]) {
            target.setBoundVariable(corner, variable);
          }
          report.bound++;
        }
        break;
      case "p":
      case "gap":
        // Requiere Auto Layout activo en el frame -- fuera de alcance del
        // MVP (doc §4/§6, "v2"). Se detecta y se reporta, no se bindea.
        report.skippedByDesign.push(
          `${t.figmaName} (role "${t.role}" -- necesita Auto Layout, v2)`,
        );
        break;
      case "shadow":
        // Efecto de Figma, no paint -- fuera de alcance del MVP.
        report.skippedByDesign.push(
          `${t.figmaName} (shadow -- efecto de Figma, bind manual)`,
        );
        break;
      default:
        report.skippedByDesign.push(
          `${t.figmaName} (role "${t.role}" sin regla de bind todavía)`,
        );
    }
  }

  // Color literal sin token (fallbackColor): se pinta tal cual para no
  // dejar el nodo sin pintar, pero NUNCA se cuenta como "bound" -- es un
  // nodo que nunca tuvo token en el DOM, no uno que se perdió.
  const hasColorToken = (node.tokens ?? []).some((t) =>
    ["bg", "fill", "text"].includes(t.role),
  );
  if (!hasColorToken && node.fallbackColor && "fills" in target) {
    const rgb = parseCssColor(node.fallbackColor);
    if (rgb) target.fills = [{ type: "SOLID", color: rgb }];
  }

  // fallbackTextColor (cambio 2026-08-05, bug real: "Echémosle" en Hero
  // entraba negro): mismo mecanismo que fallbackColor de arriba, pero
  // para el color de TEXTO heredado (ver el comentario grande en
  // run.mjs) -- un TextNode de Figma nace con fill negro default si nadie
  // se lo pisa (a diferencia de los frames, vaciados en `buildNode`). Solo
  // aplica si este nodo no tiene su propio token de rol "text" (si lo
  // tiene, ya se bindeó arriba en el switch -- no pisarlo con un color
  // literal).
  const hasTextToken = (node.tokens ?? []).some((t) => t.role === "text");
  if (!hasTextToken && node.fallbackTextColor && target.type === "TEXT") {
    const rgb = parseCssColor(node.fallbackTextColor);
    if (rgb) target.fills = [{ type: "SOLID", color: rgb }];
  }
}

function bindPaint(target, prop, variable) {
  const existing = target[prop];
  const base =
    existing && existing.length
      ? existing[0]
      : { type: "SOLID", color: { r: 0, g: 0, b: 0 } };
  const paint = figma.variables.setBoundVariableForPaint(base, "color", variable);
  target[prop] = [paint];
}

async function bindNumericIfExists(target, field, figmaName, byName, report) {
  if (!figmaName) return;
  const variable = byName.get(figmaName);
  if (!variable) {
    report.notFoundInFigma.push(figmaName);
    return;
  }
  try {
    target.setBoundVariable(field, variable);
    report.bound++;
  } catch (err) {
    report.skippedByDesign.push(
      `${figmaName} (setBoundVariable('${field}') falló: ${err.message})`,
    );
  }
}

function weightToStyle(weight) {
  const w = parseInt(weight, 10);
  if (Number.isNaN(w)) return "Regular";
  if (w >= 700) return "Bold";
  if (w >= 500) return "Medium";
  return "Regular";
}

// Convierte "rgb(13, 24, 30)" / "rgba(13, 24, 30, 0.5)" (formato de
// getComputedStyle) a {r,g,b} 0-1 que espera la API de fills de Figma.
// Alpha se ignora a propósito -- fallbackColor es solo para nodos SIN
// token, donde no vale la pena reconstruir el paint completo.
function parseCssColor(css) {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(css);
  if (!m) return null;
  return { r: Number(m[1]) / 255, g: Number(m[2]) / 255, b: Number(m[3]) / 255 };
}
