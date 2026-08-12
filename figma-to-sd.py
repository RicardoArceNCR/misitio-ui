#!/usr/bin/env python3
"""
figma-to-sd.py  (v2 — sync con export completo de Figma)
Transforma JSON exportados desde Figma (Variables API format)
al formato Style Dictionary v4.

Lee:     source/raw/{collection}.json
Escribe: source/{collection}.json

Formatos soportados:
  - Figma Variables API: { id, name, modes, variables: [...] }
  - DTCG legacy:         { "collection": { modes: { "Mode 1": {...} } } }
  - Array DTCG:          [ { "collection": { modes: {...} } }, ... ]

CAMBIOS v2 (ver docs/TOKENS_MIGRATION.md para el contexto completo):
  - COLLECTIONS: se quita 'numbers' (ya no existe en el export de Figma) y se
    agregan 'spacing', 'tipografia', 'motion', 'opacity', 'breakpoints'.
  - needs_px(): se agregan los paths con bug de unidad faltante detectados en
    la auditoría de uso (button/base/radius, button/base/gap,
    pill/base/font-size, pill/base/radius).
  - needs_ms(): nuevo — motion.json trae duraciones como FLOAT (ms) que deben
    emitirse con unidad 'ms', igual que needs_px() hace con 'px'.
  - REQUIRED_TOKENS: se agregan checks mínimos para las colecciones nuevas.

CAMBIOS 2026-08-11 (deuda de letter-spacing sin unidad, ver README §Deuda):
  - needs_px(): typography/styles/*/letter-spacing se agrega junto a
    size/line-height — esos valores ya vienen precalculados en píxeles
    (fontSize × ratio) desde Figma, solo faltaba la unidad.
  - needs_em(): nuevo — typography/tracking/* (tight/normal/wide/wider/caps)
    es un ratio pensado para combinarse con cualquier font-size, así que la
    unidad correcta es 'em' (relativa), no 'px' (absoluta). Antes salía
    pelado y el navegador lo descartaba en silencio.
"""

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
RAW_DIR    = SCRIPT_DIR / 'source' / 'raw'
OUT_DIR    = SCRIPT_DIR / 'source'

# v2: 'numbers' fuera (no existe en el nuevo export); se agregan las 5 colecciones nuevas.
# v3: se agregan 'semanticos-dark' y 'componentes-dark' para dark mode.
# v4: se agregan 'shadow' y 'z-index' (rebrand de elevación).
COLLECTIONS = [
    'primitivos', 'semanticos', 'componentes',
    'spacing', 'tipografia', 'motion', 'opacity', 'breakpoints',
    'semanticos-dark', 'componentes-dark',
    'shadow', 'z-index',
]

# ─── Smoke test — §2 del plan Dark Mode ──────────────────────────────────────
# Antes de procesar las 163 variables dark completas, aislamos 4 para verificar
# que el pipeline (.dark selector, filtros, aliases) funciona correctamente.
# Esta flag DEBE ponerse en False antes del build final (ver mensaje al final).
SMOKE_TEST = False

SMOKE_TEST_ALLOW = {
    'semanticos-dark': {
        ('background', 'page'),
        ('text', 'primary'),
        ('surface', 'inverse'),
    },
    'componentes-dark': {
        ('nav', 'bg'),
    },
}

TYPE_MAP = {
    'FLOAT':   'float',
    'STRING':  'string',
    'BOOLEAN': 'boolean',
    'COLOR':   'color',
}

FIGMA_META = {'$scopes', '$libraryName', '$collectionName'}

# IDs de variables en colecciones -dark + primitivos + shadow (se pobló en main() antes
# del parseo). Sirve para detectar aliases cross-collection que apuntan a colecciones
# light no cargadas en el build dark. Las referencias dentro del ecosistema dark (entre
# -dark, a primitivos, o a shadow) se preservan como aliases SD para mantener la cadena
# de actualización.
# 'shadow' se incluye porque style-dictionary-dark.config.js carga shadow.json (a
# diferencia de las demás colecciones light): componentes-dark.json tiene
# card/shadow, modal/shadow, toast/shadow, tooltip/shadow apuntando a shadow/*-dark,
# y esas referencias deben preservarse como alias SD, no resolverse a literal.
DARK_BUILD_IDS = set()

# Mapea variable ID → nombre de colección. Se pobla en main() antes del parseo
# (todas las colecciones, no solo dark). Se usa para namespacear correctamente
# las referencias SD hacia FLAT_COLLECTIONS.
VAR_ID_TO_COLLECTION = {}

# Colecciones cuyas variables llegan de Figma SIN el prefijo de colección en el
# nombre (ej: 'sm', 'sm-dark', 'dropdown' en vez de 'shadow/sm', 'z-index/dropdown'
# — a diferencia de opacity/*, breakpoint/*, motion/duration/* que sí lo traen).
# transform_shadow()/transform_zindex() envuelven el árbol bajo la colección para
# producir var(--shadow-sm) / var(--z-index-modal) consistente con el resto del
# sistema; acá se namespacean las referencias que apuntan a ellas (desde
# componentes.json Y componentes-dark.json) para que sigan resolviendo.
FLAT_COLLECTIONS = {'shadow', 'z-index'}

# Aliases cross-collection en dark que son INTENCIONALES: spacing no tiene variante
# dark (es idéntico en ambos modos), así que componentes-dark apunta directamente
# a spacing de la colección light. No son errores de binding en Figma.
EXPECTED_DARK_CROSS_COLLECTION = {
    'button/size/sm/height',    # → spacing/8 (32px)
    'button/size/sm/padding-x', # → spacing/3 (12px)
    'button/size/md/height',    # → spacing/10 (40px)
    'button/size/md/padding-x', # → spacing/4 (16px)
    'button/size/lg/height',    # → spacing/12 (48px)
    'button/size/lg/padding-x', # → spacing/6 (24px)
}

# ─── Mapa de valores motion legacy → CSS válido ───────────────────────────────
# Si en algún momento Figma vuelve a exportar aliases de motion como strings
# no-CSS ("motion/fast") en vez de FLOAT, este mapa los resuelve.
MOTION_MAP = {
    'motion/fast':   '150ms ease',
    'motion/normal': '250ms ease',
    'motion/slow':   '400ms ease',
}

# ─── Tokens críticos que deben existir en el output ───────────────────────────
REQUIRED_TOKENS = {
    'semanticos': [
        ['text', 'primary'],
        ['surface', 'base'],
        ['brand', 'main'],
        ['focus', 'ring-color'],
    ],
    'primitivos': [
        ['color', 'neutral', '50'],
        ['color', 'main', '500'],
        ['radius', 'md'],
    ],
    # v2: checks mínimos para que un export incompleto falle temprano y claro,
    # en vez de fallar silenciosamente más abajo en Style Dictionary / Tailwind.
    'spacing': [
        ['spacing', '0'],
        ['spacing', '8'],
    ],
    'opacity': [
        ['opacity', 'ghost'],
        ['opacity', 'high'],
    ],
    'motion': [
        ['motion', 'duration', 'fast'],
    ],
    'breakpoints': [
        ['breakpoint', 'md'],
    ],
    'semanticos-dark': [
        ['background', 'page'],
        ['text', 'primary'],
        ['surface', 'inverse'],
    ],
    'componentes-dark': [
        ['nav', 'bg'],
    ],
    'shadow': [
        ['shadow', 'sm'],
        ['shadow', 'md'],
        ['shadow', 'lg'],
        ['shadow', 'sm-dark'],
        ['shadow', 'md-dark'],
        ['shadow', 'lg-dark'],
    ],
    'z-index': [
        ['z-index', 'dropdown'],
        ['z-index', 'modal'],
    ],
}


# ─── Color conversion ─────────────────────────────────────────────────────────

def rgba_to_css(r, g, b, a):
    """Convierte r/g/b/a (0–1) a string CSS preservando precisión completa."""
    R = round(r * 255)
    G = round(g * 255)
    B = round(b * 255)
    if a >= 1.0:
        return f'#{R:02x}{G:02x}{B:02x}'
    a_str = f'{a:.4f}'.rstrip('0').rstrip('.')
    return f'rgba({R}, {G}, {B}, {a_str})'


def color_token(r, g, b, a):
    """
    Retorna { $type, $value } para un color.
    Colores con alpha < 1 usan $type: string para evitar que
    Style Dictionary pierda precisión en alphas pequeños.
    """
    css = rgba_to_css(r, g, b, a)
    typ = 'color' if a >= 1.0 else 'string'
    return {'$type': typ, '$value': css}


# ─── Nested dict builder ──────────────────────────────────────────────────────

def set_nested(d, path, value):
    """Inserta value en d siguiendo la lista de keys en path."""
    for key in path[:-1]:
        if key not in d or not isinstance(d[key], dict):
            d[key] = {}
        d = d[key]
    last = path[-1]
    if last in d and isinstance(d[last], dict) and '$value' not in d[last]:
        d[last].update(value)
    else:
        d[last] = value


def count_tokens(node):
    if not isinstance(node, dict):
        return 0
    if '$value' in node:
        return 1
    return sum(count_tokens(v) for v in node.values())


def filter_smoke_test(tokens, collection_name):
    """Keep only tokens whose paths are in SMOKE_TEST_ALLOW, discard the rest."""
    allow_paths = SMOKE_TEST_ALLOW.get(collection_name, set())
    result = {}
    for path_tuple in allow_paths:
        current = tokens
        for part in path_tuple:
            if isinstance(current, dict) and part in current:
                current = current[part]
            else:
                break
        else:
            target = result
            for part in path_tuple[:-1]:
                if part not in target:
                    target[part] = {}
                target = target[part]
            target[path_tuple[-1]] = current
    return result


# ─── Validación del output ─────────────────────────────────────────────────────

def validate_output(name, tokens):
    """Verifica que tokens críticos existan y tengan $value."""
    required = REQUIRED_TOKENS.get(name, [])
    for path in required:
        node = tokens
        for key in path:
            if not isinstance(node, dict) or key not in node:
                print(f'✗ Token faltante: {name} → {"/".join(path)}')
                sys.exit(1)
            node = node[key]
        if not isinstance(node, dict) or '$value' not in node:
            print(f'✗ Token sin $value: {name} → {"/".join(path)}')
            sys.exit(1)


# ─── Parsers ──────────────────────────────────────────────────────────────────

def parse_raw_value(raw_val, vtype, res_by_mode, mode_id):
    """Convierte un valor concreto (no alias) a token SD."""
    if vtype == 'COLOR':
        if isinstance(raw_val, dict) and 'r' in raw_val:
            r, g, b, a = raw_val['r'], raw_val['g'], raw_val['b'], raw_val.get('a', 1.0)
        else:
            resolved = res_by_mode.get(mode_id, {}).get('resolvedValue', {})
            r = resolved.get('r', 0)
            g = resolved.get('g', 0)
            b = resolved.get('b', 0)
            a = resolved.get('a', 1.0)
        return color_token(r, g, b, a)

    # Redondear floats para eliminar float noise de Figma
    # (0.4000000059604645 → 0.4, 1.2000000476837158 → 1.2)
    if vtype == 'FLOAT':
        clean = round(raw_val, 4) if isinstance(raw_val, float) else raw_val
        return {'$type': 'float', '$value': clean}

    if vtype == 'STRING':
        val = str(raw_val)
        val = MOTION_MAP.get(val, val)
        return {'$type': 'string', '$value': val}

    return {'$type': 'string', '$value': str(raw_val)}


def parse_figma_api(data, collection_name=''):
    """
    Parsea el formato Figma Variables API:
    { id, name, modes: { modeId: modeName }, variables: [...] }
    
    Para colecciones -dark: si un alias apunta a un target FUERA de la colección
    (cross-collection alias, típicamente apuntando a la versión light), se resuelve
    al valor concreto en vez de emitir una referencia SD. Esto permite que el build
    dark sea autocontenido sin cargar las colecciones light.
    """
    modes   = data['modes']
    mode_id = next(iter(modes))
    result  = {}

    is_dark_coll = collection_name.endswith('-dark')

    for var in data['variables']:
        name        = var['name']          # "brand/main", "color/brand/red/600"
        vtype       = var['type']          # "FLOAT", "COLOR", "STRING"
        val_by_mode = var.get('valuesByMode', {})
        res_by_mode = var.get('resolvedValuesByMode', {})

        if mode_id not in val_by_mode:
            continue

        raw_val = val_by_mode[mode_id]

        if isinstance(raw_val, dict) and raw_val.get('type') == 'VARIABLE_ALIAS':
            resolved   = res_by_mode.get(mode_id, {})
            alias_name = resolved.get('aliasName', '')
            alias_target_id = raw_val.get('id')

            # ── Cross-collection alias en colecciones dark: resolver a valor concreto ──
            # Si el target del alias no está en DARK_BUILD_IDS (que incluye todos los
            # IDs de colecciones -dark + primitivos), es un alias que apunta a una
            # colección light que NO se carga en el build dark. Se resuelve al valor
            # concreto para evitar referencias huérfanas o circulares.
            # Las referencias dentro del ecosistema dark (entre -dark o a primitivos)
            # se preservan como aliases SD para mantener la cadena de actualización.
            if is_dark_coll and alias_target_id and alias_target_id not in DARK_BUILD_IDS:
                if name not in EXPECTED_DARK_CROSS_COLLECTION:
                    print(f'⚠  {collection_name}: "{name}" → alias cruza a colección light '
                          f'("{alias_name}", id {alias_target_id}). Se resuelve a literal. '
                          f'Verificar si debía apuntar a la variable homónima en la colección -dark.')
                # Resolver alias a su valor concreto: raw_val es un VARIABLE_ALIAS,
                # no un valor primitivo. Extraer el resolvedValue numérico/color/string.
                resolved = res_by_mode.get(mode_id, {})
                resolved_val = resolved.get('resolvedValue', raw_val)
                if isinstance(resolved_val, dict) and 'r' in resolved_val:
                    token = color_token(resolved_val['r'], resolved_val['g'],
                                        resolved_val['b'], resolved_val.get('a', 1.0))
                else:
                    token = parse_raw_value(resolved_val, vtype, res_by_mode, mode_id)
            elif alias_name:
                # Namespacear si el target vive en una FLAT_COLLECTION (shadow,
                # z-index): esas variables no traen el prefijo de colección en
                # el nombre de Figma, así que hay que agregarlo a mano o la
                # referencia queda apuntando a un path que no existe en el
                # árbol de tokens ya envuelto por transform_shadow/transform_zindex.
                ref_name = alias_name
                target_collection = VAR_ID_TO_COLLECTION.get(alias_target_id)
                if target_collection in FLAT_COLLECTIONS and not alias_name.startswith(target_collection + '/'):
                    ref_name = f'{target_collection}/{alias_name}'
                sd_ref = '{' + ref_name.replace('/', '.') + '}'
                sd_type = TYPE_MAP.get(vtype, 'string')
                if vtype == 'COLOR':
                    resolved_val = resolved.get('resolvedValue', {})
                    a = resolved_val.get('a', 1.0) if isinstance(resolved_val, dict) else 1.0
                    sd_type = 'color' if a >= 1.0 else 'string'
                token = {'$type': sd_type, '$value': sd_ref}
            else:
                token = parse_raw_value(raw_val, vtype, res_by_mode, mode_id)
        else:
            token = parse_raw_value(raw_val, vtype, res_by_mode, mode_id)

        # v2: WARNING para nombres con mayúsculas — el bug de hero.text.Color
        # (docs/TOKENS_MIGRATION.md §4) viene de aquí: Figma permite mayúsculas
        # en el nombre de variable, pero el CSS var final se normaliza a
        # lowercase más adelante en la cadena de build, dejando el token fuente
        # huérfano. Lo avisamos en vez de fallar silenciosamente.
        if name != name.lower():
            print(f'⚠  Nombre de variable con mayúsculas: "{name}" '
                  f'→ pedir a diseño que lo renombre en lowercase en Figma.')

        path = name.split('/')
        set_nested(result, path, token)

    return result


def strip_meta(node):
    if not isinstance(node, dict):
        return node
    return {k: strip_meta(v) for k, v in node.items() if k not in FIGMA_META}


def parse_dtcg(data, name):
    """Parsea formato DTCG legacy (array o objeto con wrapper de colección)."""
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and name in item:
                data = item[name]
                break
        else:
            if data and isinstance(data[0], dict):
                data = next(iter(data[0].values()))

    if isinstance(data, dict):
        if name in data:
            data = data[name]
        if 'modes' in data:
            first_mode = next(iter(data['modes'].values()))
            return strip_meta(first_mode)

    return strip_meta(data)


def load_and_parse(path, name):
    """Detecta el formato y parsea el archivo raw."""
    with open(path, encoding='utf-8') as f:
        data = json.load(f)

    if isinstance(data, dict) and 'variables' in data and 'modes' in data:
        return parse_figma_api(data, name)

    return parse_dtcg(data, name)


# ─── Transformaciones por colección ────────────────────────────────────────────

def transform_primitivos(tokens):
    """
    Renombra border → border-width para evitar colisión de namespace
    con la clave 'border' (colores semánticos) de semanticos.json.
    También añade spacing.7 = 28 que falta en el export de Figma
    (gap entre spacing/6=24 y spacing/8=32 en la escala de 4px).

    NOTA v2: si 'spacing.json' (colección nueva) termina siendo la única fuente
    de la escala de spacing, este parche debe moverse a transform_spacing() y
    spacing.* debe quitarse de primitivos.json en Figma. Ver
    docs/TOKENS_MIGRATION.md §5.
    """
    if 'border' in tokens and 'border-width' not in tokens:
        tokens['border-width'] = tokens.pop('border')
    if 'spacing' in tokens and '7' not in tokens['spacing']:
        tokens['spacing']['7'] = {'$type': 'float', '$value': 28}
    return tokens


def transform_semanticos(tokens):
    """
    Mantiene focus/ring/color como fuente de verdad.
    La versión vieja focus/ring-color ya no debe existir.
    """
    return tokens


def transform_motion(tokens):
    """
    motion/easing/* llega como STRING (cubic-bezier(...) o keyword) → OK tal cual.
    motion/duration/* llega como FLOAT en ms → se marca para needs_ms() en
    apply_units(), no requiere transformación de estructura.
    """
    return tokens


def transform_flat_collection(name):
    """Envuelve un árbol flat ({'sm': ..., 'md': ...}) bajo la key de la
    colección ({'shadow': {'sm': ..., 'md': ...}}). Necesario porque shadow y
    z-index llegan de Figma sin el prefijo de colección en el nombre de
    variable (ver FLAT_COLLECTIONS)."""
    def _wrap(tokens):
        return {name: tokens}
    return _wrap


TRANSFORMS = {
    'primitivos':       transform_primitivos,
    'semanticos':       transform_semanticos,
    'semanticos-dark':  transform_semanticos,
    'motion':           transform_motion,
    'shadow':           transform_flat_collection('shadow'),
    'z-index':          transform_flat_collection('z-index'),
}


# ─── Unidades: px ───────────────────────────────────────────────────────────────

def needs_px(path):
    """Returns True if a float token at this path should carry a px unit."""
    p, n = path, len(path)
    if n < 2:
        return False
    if p[0] in ('spacing', 'radius', 'border-width'):
        return True
    if n >= 3 and p[0] == 'typography' and p[1] == 'size':
        return True
    if n >= 4 and p[0] == 'typography' and p[1] == 'styles' and p[-1] in ('size', 'line-height', 'letter-spacing'):
        return True
    if n >= 3 and p[0] == 'button' and p[1] == 'text-size':
        return True
    if n >= 2 and p[0] == 'button' and p[1] == 'radius':
        return True
    if n >= 4 and p[0] == 'button' and p[1] == 'size' and p[3] in ('padding-x', 'padding-y', 'height'):
        return True
    if p[0] == 'card'  and p[1] in ('padding', 'radius'):
        return True
    if p[0] == 'input' and p[1] in ('radius', 'padding-x', 'padding-y'):
        return True
    if n >= 3 and p[0] == 'pill' and p[2] in ('padding-x', 'padding-y'):
        return True
    if n >= 3 and p[0] == 'layout' and p[2] in ('padding-x', 'padding-y', 'gap-x'):
        return True
    if n >= 3 and p[0] == 'pill' and p[1] == 'text' and p[2] in ('size', 'line-height', 'letter-spacing'):
        return True
    if n >= 2 and p[0] == 'pill' and p[1] == 'sm':
        return True
    if n >= 3 and p[0] == 'pill' and p[2] == 'border-width':
        return True
    if n >= 4 and p[0] == 'button' and p[1] == 'base' and p[2] == 'border' and p[3] == 'width':
        return True
    if n >= 2 and p[0] == 'focus' and p[1] in ('ring-width', 'offset', 'outline-offset'):
        return True
    if n >= 3 and p[0] == 'focus' and p[1] == 'ring' and p[2] in ('focus-ring-offset', 'focus-ring-width'):
        return True

    # v2 — gaps detectados en la auditoría de uso (tokens.css emitía estos
    # valores SIN unidad: --button-base-radius: 9999, --button-base-gap: 8,
    # --pill-base-radius: 12, --pill-base-font-size: 14). Confirmar con
    # tipografia.json si pill-base-font-size debe en realidad apuntar a un
    # tamaño de la escala tipográfica en vez de tener valor propio duplicado.
    if n >= 3 and p[0] == 'button' and p[1] == 'base' and p[2] in ('radius', 'gap'):
        return True
    if n >= 3 and p[0] == 'pill' and p[1] == 'base' and p[2] in ('radius', 'font-size'):
        return True

    # v3 — en la colección LIGHT estos ocho apuntan a un primitivo
    # ({spacing.16}, {radius.xl}...) y heredan su unidad, pero en la
    # colección DARK de Figma son valores concretos sin alias, así que sin
    # esta regla salían pelados: `--nav-height: 64` bajo `.dark` hace que
    # `h-[var(--nav-height)]` sea CSS inválido. Se verificó que cada valor
    # concreto equivale exacto a su primitivo (spacing/16 = 64px,
    # radius/xl = 16px, etc.), así que emitir px acá no cambia el render,
    # solo lo vuelve válido.
    #
    # El alias sigue faltando del lado de Figma: la variable dark debería
    # referenciar el primitivo en vez de repetir el número. Mientras no se
    # haga, un cambio de radius/xl mueve light y deja dark atrás.
    if n >= 2 and p[0] == 'nav' and p[1] == 'height':
        return True
    if n >= 2 and p[0] in ('modal', 'pill', 'toast', 'tooltip') and p[1] == 'radius':
        return True
    if n >= 3 and p[0] == 'avatar' and p[1] == 'size':
        return True

    return False


def needs_px_breakpoint(path, collection_name):
    """breakpoints.json resulta en paths top-level: ['sm'], ['md'], etc."""
    return collection_name == 'breakpoints' and len(path) == 1


# ─── Unidades: ms (v2, nuevo) ───────────────────────────────────────────────────

def needs_ms(path, collection_name):
    """motion/duration/* son FLOAT en ms y deben emitirse con unidad 'ms'."""
    if collection_name != 'motion':
        return False
    p, n = path, len(path)
    return n >= 2 and p[-2] == 'duration'


# ─── Unidades: em ───────────────────────────────────────────────────────────────

def needs_em(path):
    """typography/tracking/* es un RATIO (ej. 0.12 = 12% del font-size), no un
    píxel absoluto — a diferencia de typography/styles/*/letter-spacing, que ya
    viene precalculado en píxeles desde Figma (fontSize × ratio). 'em' es la
    unidad correcta porque ya es relativa al font-size del elemento, que es
    justo lo que este ratio necesita: heredar el tamaño de quien lo consuma
    (--typography-tracking-caps se usa igual en un botón de 14px que en un
    label de 12px, y el espaciado real debe escalar con cada uno).

    Antes de esta regla, el valor salía pelado (0.12), que es CSS inválido
    para letter-spacing y el navegador lo descartaba en silencio — ver
    --button-letter-spacing en button.tsx de misitio, que no tenía efecto
    visual real hasta este fix."""
    p, n = path, len(path)
    return n >= 2 and p[0] == 'typography' and p[1] == 'tracking'


def apply_units(node, collection_name, path=None):
    """
    Recorre el árbol de tokens convirtiendo floats que necesitan unidad CSS.
      Valor concreto → $type: dimension, $value: "Npx" / "Nms"
      Alias          → $type: dimension, $value: "{ref}"  (evita mismatch de tipo)
    """
    if path is None:
        path = []
    if not isinstance(node, dict):
        return node
    if '$value' in node:
        if node.get('$type') != 'float':
            return node

        unit = None
        if needs_px(path) or needs_px_breakpoint(path, collection_name):
            unit = 'px'
        elif needs_ms(path, collection_name):
            unit = 'ms'
        elif needs_em(path):
            unit = 'em'

        if unit:
            val = node['$value']
            if isinstance(val, (int, float)):
                return {'$type': 'dimension', '$value': f'{val:g}{unit}'}
            if isinstance(val, str) and val.startswith('{'):
                return {'$type': 'dimension', '$value': val}
        return node
    return {k: apply_units(v, collection_name, path + [k]) for k, v in node.items()}


# ─── Main ───────────────────────────────────────────────────────────────────────

def main():
    if not RAW_DIR.exists():
        print(f'✗ No existe {RAW_DIR}')
        print('  Coloca los JSON exportados de Figma en esa carpeta.')
        sys.exit(1)

    print('Figma → Style Dictionary (v2)\n')

    # ── Pre-poblar VAR_ID_TO_COLLECTION (todas las colecciones) y DARK_BUILD_IDS
    # (solo -dark + primitivos + shadow) para detección de aliases cross-collection.
    # Escanea todos los raw JSON antes del parseo principal.
    for name in COLLECTIONS:
        path = RAW_DIR / f'{name}.json'
        if path.exists():
            try:
                with open(path, encoding='utf-8') as f:
                    raw = json.load(f)
                if 'variables' in raw:
                    for v in raw['variables']:
                        VAR_ID_TO_COLLECTION[v['id']] = name
                        if name in ('primitivos', 'shadow') or name.endswith('-dark'):
                            DARK_BUILD_IDS.add(v['id'])
            except Exception:
                pass  # la colección se validará en el parseo principal

    loaded = {}
    for name in COLLECTIONS:
        path = RAW_DIR / f'{name}.json'
        if not path.exists():
            continue
        try:
            tokens = load_and_parse(path, name)
            loaded[name] = tokens
        except Exception as e:
            print(f'✗ Error en {name}.json: {e}')
            sys.exit(1)

    if not loaded:
        print(f'✗ No se encontraron archivos en {RAW_DIR}')
        print(f'  Esperados: {", ".join(f"{n}.json" for n in COLLECTIONS)}')
        sys.exit(1)

    missing = [n for n in COLLECTIONS if n not in loaded]
    if missing:
        print(f'⚠  Colecciones no encontradas (se omiten): {", ".join(missing)}\n')

    total_raw = sum(count_tokens(t) for t in loaded.values())
    print(f'✓ Mapa de IDs construido: {total_raw} variables\n')

    grand_total = 0
    for name in COLLECTIONS:
        if name not in loaded:
            continue

        tokens = loaded[name]

        if name in TRANSFORMS:
            tokens = TRANSFORMS[name](tokens)

        # ── SMOKE TEST: filtrar a solo las variables permitidas ──────────
        if SMOKE_TEST and name in SMOKE_TEST_ALLOW:
            original_count = count_tokens(tokens)
            tokens = filter_smoke_test(tokens, name)
            filtered_count = count_tokens(tokens)
            discarded = original_count - filtered_count
            allowed_vars = ', '.join('/'.join(p) for p in SMOKE_TEST_ALLOW.get(name, set()))
            print(f'  🧪 SMOKE_TEST — {name}: procesando solo ({allowed_vars}) '
                  f'({filtered_count} vars), descartando {discarded} vars')
        # ──────────────────────────────────────────────────────────────────

        tokens = apply_units(tokens, name)

        validate_output(name, tokens)

        n = count_tokens(tokens)
        grand_total += n

        out = OUT_DIR / f'{name}.json'
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(tokens, f, indent=2, ensure_ascii=False)
            f.write('\n')

        print(f'✓ {name}.json → source/{name}.json ({n} tokens)')

    print(f'\n✓ Total: {grand_total} tokens procesados')
    print('  Ejecuta: npx style-dictionary build --config style-dictionary_config.js')

    if SMOKE_TEST:
        print('\n⚠  ⚠  ⚠  SMOKE_TEST = True — ¡NO HAGAS COMMIT ASÍ!')
        print('  Antes del build final, pon SMOKE_TEST = False en la línea 38.')
        print('  Este mensaje es tu recordatorio. No te saltes este paso.')


if __name__ == '__main__':
    main()
