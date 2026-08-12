# Fix de primitivos de color (amber/sky/clay/jade)

> Brief técnico para quien ejecute el cambio en Figma + Style Dictionary.
> La decisión y su porqué viven en `misitio/docs/decisions/0012-paleta-primitivos-vper.md`
> — este archivo es el "cómo", no el "por qué".
> Origen: sesión de trabajo en `vper-media-next`, 2026-08-11/12.

## 1. Diagnóstico (verificado contra `source/primitivos.json`, no a ojo)

```
color/amarillo:  50-300 y 700-950 == color/leaf (copia literal)
                 solo 400-600 tienen amarillo real
color/gold:      gold/500 (#fedd00) == amarillo/500 (#fedd00), duplicado
color/neutral:   50-700 hue ~35-40° (cálido) → 800-950 hue ~200° (azul)
```

`accent` (`#ff003f`, rosa saturado) no corresponde a ninguna identidad de
marca real. `main/300-400` (`#87f5ed`, `#53f1e5`) son casi neón.

## 2. Propuesta — 4 familias ancladas en OKLCH + neutral acromático

| Familia | Ancla | Stop | Reemplaza |
|---|---|---|---|
| `amber` | `#FDBF66` | 300 | `amarillo` + `gold` (rotos/duplicados) |
| `sky` | `#5EB2E3` | 500 | `info` (renombre — el valor ya era correcto) |
| `clay` | `#D55856` | 600 | `accent` (rosa no correspondía a nada) |
| `jade` | `#74BDB7` | 400 | `main` (neón) + `leaf` (se fusionan) |
| `neutral` | — | croma 0 | `neutral` (se corrige, no se reemplaza) |

`ink` se elimina — se disuelve en `neutral/800-950` + el canvas negro.

### Rampas completas

**amber** — 50 `#FFF5E9` · 100 `#FDEAD0` · 200 `#FED7A4` · **300 `#FDBF66`**
· 400 `#F4A508` · 500 `#D38F0F` · 600 `#B17706` · 700 `#8F5F06` · 800
`#6E4802` · 900 `#4F3301` · 950 `#352000`

**sky** — 50 `#F0F8FD` · 100 `#E0EFFA` · 200 `#C4E3F8` · 300 `#A0D4F5` ·
400 `#7CC1EB` · **500 `#5EB2E3`** · 600 `#378EBD` · 700 `#22729C` · 800
`#11587A` · 900 `#053E59` · 950 `#00293D`

**clay** — 50 `#FFF4F3` · 100 `#FFE6E4` · 200 `#FFD1CE` · 300 `#FFB7B2` ·
400 `#FE9690` · 500 `#F1716D` · **600 `#D55856`** · 700 `#AF403F` · 800
`#8A2D2D` · 900 `#651C1D` · 950 `#470D0F`

**jade** — 50 `#F1F9F8` · 100 `#E1F1EF` · 200 `#C5E6E3` · 300 `#A2D9D4` ·
**400 `#74BDB7`** · 500 `#56B0A9` · 600 `#39958F` · 700 `#237974` · 800
`#125D59` · 900 `#05433F` · 950 `#002C2A`

**neutral** (croma 0) — 50 `#FAFAFA` · 100 `#F3F3F3` · 200 `#E6E6E6` · 300
`#D6D6D6` · 400 `#BEBEBE` · 500 `#9E9E9E` · 600 `#808080` · 700 `#606060`
· 800 `#3D3D3D` · 900 `#232323` · 950 `#0E0E0E`. El negro puro (`#000000`)
no es un paso de la rampa — es el canvas de las secciones oscuras.

## 3. Mapeo semántico (contraste WCAG verificado, no estimado)

**Superficies y texto** — Canvas: blanco / negro puro. Superficie 1
(card): `neutral/50` claro / `neutral/950` oscuro (1.09). Superficie 2
(modal, popover): blanco / `neutral/900` (1.34). Texto primario:
`neutral/900` / `neutral/50` (19.95). Texto secundario: `neutral/700` /
`neutral/400` (11.42). Borde decorativo: `neutral/200` / `neutral/800`
(2.52). Borde de control: `neutral/300` / `neutral/700` (4.06) — **ojo**:
`neutral/800` sobre negro da 2.52, no alcanza 3:1 para un borde que es la
única delimitación de un control.

**Marca** — Relleno: `amber/300` + texto `neutral/950`, **idéntico en
claro y oscuro** (11.1 claro, 12.8 oscuro sobre canvas — no hace falta
variante por modo). Hover del relleno: `amber/200` ambos modos. Texto de
marca: `amber/700` claro (5.52) / `amber/300` oscuro (12.82). Borde de
marca: `amber/600` claro (3.81) / `amber/300` oscuro.

Prohibiciones duras: `amber/300` y `amber/400` nunca son texto, ícono ni
borde sobre fondo claro (1.64 y 2.05). Nunca texto blanco sobre
`amber/300`. El primer ámbar legible como texto sobre claro es `amber/700`.

**Feedback** (superficie tintada + borde + ícono + texto, nunca color
solo; borde paso 600 claro / 800 oscuro):

| Estado | Claro (superficie/texto) | Ratio | Oscuro (superficie/texto) | Ratio |
|---|---|---|---|---|
| Info | `sky/50` / `sky/700` | 4.94 | `sky/950` / `sky/400` | 7.72 |
| Éxito | `jade/50` / `jade/700` | 4.84 | `jade/950` / `jade/300` | 9.62 |
| Advertencia | `amber/50` / `amber/700` | 5.12 | `amber/950` / `amber/300` | 9.44 |
| Error | `clay/50` / `clay/700` | 5.37 | `clay/950` / `clay/400` | 7.49 |

**Otros** — Focus ring: `sky/600` claro (3.64) / `sky/400` oscuro (10.68)
— `sky/500` da 2.35, no usar. Disabled fondo: `neutral/200` / `neutral/900`.
Overlay/scrim: negro 50% claro / negro 70% oscuro. Divisor: `neutral/200`
/ `neutral/800`.

**Series de datos** (orden fijo, color nunca es el único codificador —
siempre + patrón de línea/marcador/etiqueta): sobre claro `sky/600` ·
`amber/600` (`amber/500` no llega a 3:1) · `clay/600` · `jade/600` ·
`neutral/600`. Sobre negro: `sky/400` · `amber/300` · `clay/400` ·
`jade/300` · `neutral/400`.

## 4. La colisión marca/advertencia — separar por FORMA, no por color

Si `amber` es la marca, no puede ser también advertencia sin ambigüedad.
Se acepta el solapamiento de hue y se separa por forma:

- Marca: **solo relleno sólido** (`amber/300`) — botón, badge, subrayado,
  barra. Nunca superficie tintada.
- Advertencia: **solo superficie tintada** (`amber/50`/`amber/950`),
  siempre con borde izquierdo + ícono + texto. Nunca relleno sólido.

Nunca comparten forma, así que no compiten aunque compartan hue. Trigger
de reapertura: si en pruebas reales una advertencia se confunde con un
elemento de marca, o aparece un componente que necesita ambos usos en la
misma vista, mover advertencia a la rampa de contingencia `ember`
(naranja, hue 48°, 26° de separación — ya precalculada abajo).

### Rampa de contingencia `ember` (no implementar en v1)

50 `#FFF4EF` · 100 `#FFE7DC` · 200 `#FFD4BE` · 300 `#FFBA97` · 400
`#FF9A64` · 500 `#F87106` · 600 `#D15D00` · 700 `#A94A02` · 800 `#823803`
· 900 `#5E2600` · 950 `#401700`.

## 5. Correspondencia con los primitivos actuales

| Actual | Nuevo | Acción |
|---|---|---|
| `color/amarillo` | `color/amber` | Reemplazar — rampa rota |
| `color/gold` | `color/amber` | Eliminar — duplicaba amarillo |
| `color/info` | `color/sky` | Renombrar — valores correctos |
| `color/accent` | `color/clay` | Reemplazar — rosa no está en identidad |
| `color/main` | `color/jade` | Reemplazar — pasos 300-400 eran neón |
| `color/leaf` | — | Eliminar — `jade` cubre éxito |
| `color/ink` | — | Eliminar — se disuelve en `neutral/800-950` + canvas |
| `color/neutral` | `color/neutral` | Corregir — quitar salto de temperatura |
| `color/white`, `color/black` | sin cambio | `black` pasa a ser el canvas oscuro |

Primitivos de tipografía, radius y border-width no se tocan.

## 6. Implementación (orden obligatorio del proyecto)

1. Figma primero — la paleta entra a la colección `primitivos`. No editar
   `build/` (salida generada).
2. Semánticos en Figma — el mapeo de la sección 3 va a la colección
   semántica, no directo a componentes.
3. Export y build — Style Dictionary regenera `tokens.css`/`tokens-dark.css`
   (`npm run build`, ver `style-dictionary.config.js`).
4. `theme-bridge.template.css` a mano — único archivo que se edita a
   mano, respetando el orden de carga invariante (`tokens.css` →
   `tokens-dark.css` → `theme-bridge.css`).
5. Alias de transición — mantener `amarillo`/`gold`/`main`/`accent`/
   `leaf`/`ink` como alias de los nombres nuevos durante un release;
   eliminar en el siguiente. El renombre es breaking en toda la cadena.
6. Bump de versión + tag — los consumidores fijan el tag exacto (nunca
   rama default), así que esto no rompe nada hasta que cada uno decida
   actualizar.
7. Verificación real antes del PR.

## 7. Qué NO hacer

No implementar esto directo en el `brand.css` de ningún consumidor como
solución definitiva. `vper` ya tiene un stopgap local (mismos valores de
color, sin el renombre de propiedades) pensado para borrarse en cuanto
esto exista acá — ver `vper-media-next/src/app/brand.css`, secciones 2-4,
como referencia de valores ya verificados (compilados con el motor real
de Tailwind, no a ojo) y de qué combinaciones semánticas ya se probaron.

## 8. Puntos abiertos

- Nombres en inglés (`amber`/`sky`/`clay`/`jade`) vs. mantener español
  (`amarillo`) — fijar antes de escribir el JSON de Figma.
- Temperatura del gris junto al ámbar: corrección opcional (croma 0.004,
  hue 70, en 800-950), imperceptible como color. El negro puro es lo
  correcto respecto al logo — esto es afinamiento, no blocker.
- Gamificación: colores de nivel/XP/tiers pendientes hasta que exista
  pantalla real que lo necesite.
