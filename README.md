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

Los tres archivos van en este orden, en el `layout.tsx` raíz:

```tsx
import "@misitio/ui/tokens.css";      // 1: :root (claro)
import "@misitio/ui/tokens-dark.css"; // 2: .dark
import "./globals.css";               // 3: tailwind + bridge
```

Y en `globals.css`:

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

@import "@misitio/ui/theme-bridge.css";
```

El orden no es arbitrario. `tokens-dark.css` sobreescribe bajo `.dark`, y
`theme-bridge.css` mapea todo a los namespaces de Tailwind v4 (`@theme
inline`) y a la API de shadcn/ui (`:root` / `.dark`). Alterarlo no rompe un
componente suelto: rompe el theming completo.

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
- **`letter-spacing` sin unidad.** `--typography-tracking-*` y
  `--typography-styles-*-letter-spacing` salen como números pelados, lo que
  en CSS es inválido. Preexistente y presente en claro y oscuro por igual,
  así que no es una regresión de este paquete. Están en la lista blanca del
  guardarrail hasta que se decida la unidad correcta (`em` o `px`) en Figma.
- **`build/tokens.js` viaja al consumidor sin que nadie lo use.** Son
  187 KB de tokens en JS que ningún proyecto importa hoy. Sale del paquete
  quitando la plataforma `js` de `style-dictionary.config.js`, pero eso es
  una decisión sobre el pipeline y no se tomó acá.

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
