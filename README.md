# @misitio/ui

Design system compartido entre proyectos de cliente. Hoy publica **solo
tokens** (CSS). Los componentes React viven todavía en cada proyecto y se
suman a este paquete en una versión posterior — ver "Qué sigue".

Origen del contenido: Figma → `figma-to-sd.py` → Style Dictionary →
`build/`. Los valores **no se editan acá**: se cambian en Figma y se
regeneran.

## Instalar

```bash
pnpm add github:RicardoArceNCR/misitio-ui#v0.1.0
```

Se instala por tag de git a propósito: ambos repos son privados y esto
evita montar autenticación contra un registry en cada máquina y en CI.
Migrar a GitHub Packages más adelante no cambia el código del consumidor,
solo el origen — pero sí exige renombrar el paquete al scope del dueño
(`@ricardoarcencr/…`), porque GitHub Packages no acepta otro.

El campo `files` se respeta aun instalando por git: al consumidor le llega
`build/`, el `README.md` y el `package.json`, no `source/` ni el pipeline
(verificado instalando `v0.1.0` en un proyecto limpio). La frontera de ADR
0011 — "un consumidor debe poder usar los tokens, no editarlos" — ya es
real, no una convención documentada.

Fijá siempre un tag. Sin tag, `pnpm` toma la rama por defecto y perdés el
control de versión que es justamente el motivo de que esto sea un paquete.

## Desplegar un consumidor (Vercel o cualquier CI sin llaves SSH)

`pnpm` resuelve `github:owner/repo#tag` con un `git clone` real —no un
tarball por HTTPS— porque este paquete tiene script `prepare`. Ese clone
usa por defecto URL SSH (`git@github.com:...`), que falla en cualquier
entorno sin llave SSH configurada (Vercel, GitHub Actions, etc.) con `Host
key verification failed: fatal: Could not read from remote repository`,
**sin importar si el repo es público o privado**: el formato de URL no
depende de la visibilidad.

Encontrado en el primer deploy de `vper` (2026-08-11). Como este repo es
público desde esa fecha, la solución no necesita ningún token: alcanza con
reescribir la URL SSH a HTTPS antes de `pnpm install`. En el `vercel.json`
del consumidor:

```json
{
  "installCommand": "git config --global url.\"https://github.com/\".insteadOf \"git@github.com:\" && pnpm install"
}
```

Copiá este `vercel.json` tal cual en cualquier proyecto nuevo que consuma
este paquete, antes del primer deploy. (`misitio` resuelve lo mismo con un
método más viejo, de cuando este repo todavía era privado —
`MISITIO_UI_READ_TOKEN` + rewrite con token—, que sigue funcionando pero ya
es más complejo de lo necesario; no es el método a copiar.)

## Orden de carga (contrato, no sugerencia)

Los cuatro archivos van con `@import`, **dentro del CSS global**, en este
orden:

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

@import "@misitio/ui/tokens.css";      /* 1: primitivos + semánticos */
@import "@misitio/ui/tokens-dark.css"; /* 2: overrides bajo .dark    */
@import "@misitio/ui/theme-bridge.css";/* 3: mapeo a Tailwind v4     */
@import "./brand.css";                 /* 4: marca de este cliente   */
```

Y el entry de JS (`layout.tsx` / `main.tsx`) importa **un solo** CSS:

```tsx
import "./globals.css";
```

El orden no es arbitrario. `tokens-dark.css` sobreescribe bajo `.dark`,
`theme-bridge.css` mapea todo a los namespaces de Tailwind v4 (`@theme
inline`) y a la API de shadcn/ui, y `brand.css` gana por ser el último.
Alterarlo no rompe un componente suelto: rompe el theming completo.

### Por qué NO se importan los tokens desde el entry de JS

Este README prescribía hasta 2026-08-18 cargar `tokens.css` y
`tokens-dark.css` como `import` de JS. Estaba mal, y el error es difícil
de diagnosticar — vale dejarlo escrito.

El CSS importado desde un módulo JS lo emite el bundler como **una hoja
aparte**; el importado con `@import` desde otro CSS queda **dentro de la
misma hoja**. Partir la cadena entre los dos mecanismos produce dos
`<link>` cuyo orden relativo decide el bundler, no el código. Y el orden
es lo único que hace funcionar a `brand.css`: la marca gana por
**cascada**, no por especificidad — son `:root` contra `:root`.

Medido en un build real de Next (`vper`, mismo commit, cambiando solo
dónde se importan los CSS):

| | hojas CSS emitidas | `<link>` en el HTML |
|---|---|---|
| Split JS/CSS (contrato viejo) | 2 | 2 |
| Todo por `@import` | **1** | **1** |

El síntoma en `vper` fue que los colores de marca se caían de forma
intermitente en `dev` con HMR mientras producción se veía bien. Se
"resolvió" durante una semana con `!important` en los once stops de la
rampa neutral de su `brand.css`.

**Regla que queda:** si `brand.css` necesita `!important` para ganar, el
orden de carga está mal. No se agrega `!important`, se arregla la cadena.

Vale para cualquier bundler: Vite tiene sus propias reglas de orden entre
chunks de CSS, distintas de las de Next. El contrato de arriba no depende
de ninguna.

## Pisar la marca del cliente

Cada proyecto define su marca sobreescribiendo los semánticos `--brand-*`,
después del import del bridge. Misma especificidad, gana el último:

```css
@import "@misitio/ui/theme-bridge.css";

:root {
  --brand-action: #ff003f;
  --brand-font-display: "League Gothic";
}
```

Esa es la superficie pensada para pisar. Los primitivos
(`--color-neutral-*`, `--spacing-*`) y los tokens de componente
(`--button-*`, `--card-*`, `--footer-*`) se pueden pisar igual, pero si un
cliente necesita cambiarlos de forma sistemática eso es señal de que falta
un token semántico nuevo en Figma, no de que haya que acumular overrides.

## Desarrollo

```bash
npm run tokens   # figma-to-sd.py: source/raw/ (export de Figma) → source/
npm run build    # Style Dictionary: source/ → build/
npm test         # guardarrail de unidades sobre build/
npm run verify   # los tres, en orden
```

`build/` es 100% salida generada y va versionado para que el consumidor no
tenga que correr Python ni Style Dictionary. El único archivo del bridge que
se edita a mano es `theme-bridge.template.css`, en la raíz — nunca el de
`build/`.

### El guardarrail de unidades

`npm test` falla si un token sale con valor numérico pelado, y si un token
resuelve bien en claro pero queda pelado en oscuro.

Existe por un bug real: en la colección dark de Figma, `nav/height`,
`modal|pill|toast|tooltip/radius` y `avatar/size/*` son valores concretos
sin alias, y `needs_px()` no los cubría. Salía `--nav-height: 64` bajo
`.dark`, lo que vuelve inválido cualquier `h-[var(--nav-height)]`. En claro
no se veía porque ahí esos tokens sí son alias de un primitivo. Estuvo
parchado a mano en el repo de un cliente durante semanas, y el parche se
habría borrado en la siguiente regeneración.

## Deuda conocida

No bloquea el uso, pero conviene no redescubrirla:

- **Alias faltantes en la colección dark de Figma.** Los ocho tokens de
  arriba repiten el número en vez de referenciar el primitivo. Hoy los
  valores coinciden exactos (`spacing/16` = 64px, `radius/xl` = 16px…), así
  que el render es idéntico, pero si alguien cambia `radius/xl` el modo
  claro se mueve y el oscuro se queda. El arreglo es del lado de Figma:
  hacer que la variable dark aliasee el primitivo.
- **`build/tokens.js` viaja al consumidor sin que nadie lo use.** Son
  187 KB de tokens en JS que ningún proyecto importa hoy. Sale del paquete
  quitando la plataforma `js` de `style-dictionary.config.js`, pero eso es
  una decisión sobre el pipeline y no se tomó acá.

### Resuelto (v0.1.3, 2026-08-11): `letter-spacing` sin unidad

`--typography-tracking-*` y `--typography-styles-*-letter-spacing` salían
como números pelados (`0.12`, `-3.12`), inválido en CSS — el navegador lo
descartaba en silencio. Confirmado en producción: `--button-letter-spacing`
en `Button` de `misitio` no tenía ningún efecto visual por esto.

Arreglado en el generador (`figma-to-sd.py`), no en la salida, dos unidades
distintas según qué es cada token:

- `typography/tracking/*` (tight/normal/wide/wider/caps) es un **ratio**
  pensado para combinarse con cualquier font-size → unidad `em` (relativa,
  ya escala con el tamaño de quien lo consuma).
- `typography/styles/*/letter-spacing` (por estilo: hero, h1, label-lg…) ya
  viene **precalculado en píxeles** desde Figma (fontSize × ratio) → unidad
  `px`.

Con esto, `--text-h1--letter-spacing` y equivalentes ya se generan en
`theme-bridge-typography.generated.css` — antes se excluían a propósito
porque mapear un número pelado hubiera sido el mismo bug otra vez. Cualquier
clase `text-h1`, `text-display-*`, `text-label-*`, `text-overline-*` ahora
aplica letter-spacing real, no solo tamaño y line-height.

**Importante para consumidores que ya venían compensando esto a mano** (con
`tracking-[Nem]` arbitrario en el componente, porque el token no hacía
nada): verificar visualmente antes de actualizar el tag, por si ahora se
suma el letter-spacing del token *más* el arbitrario que ya estaba puesto
como parche.

## Qué sigue

Los componentes React (`Button`, `Card`, `Input`, `Header`, `Footer`,
`Hero`, `Accordion`, `FitText`, `VesselMeter`) siguen viviendo en cada
proyecto y ya divergieron entre ellos. Entran acá bajo `./components`
cuando se reconcilien.

Van en este mismo repo y no en uno aparte por una razón concreta: los
tokens de componente (`--button-*`, `--footer-*`) se generan desde
`source/componentes.json`, que es parte de este pipeline. Separarlos
convertiría "agregar un Footer con íconos sociales" en dos releases
coordinados en vez de un commit.
