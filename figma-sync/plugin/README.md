# Plugin de Figma — Fase 2

No probado end-to-end desde el chat (no hay acceso a Figma acá). Sintaxis
de `code.js` verificada (`node --check`), pero el comportamiento real
dentro de Figma necesita correrlo en tu Figma Desktop.

## Instalar (desarrollo local)

1. Figma Desktop → menú de la cuenta → **Plugins** → **Development** →
   **Import plugin from manifest...**
2. Elegí `figma-sync/plugin/manifest.json` de este repo.
3. Con un archivo de Figma abierto: **Plugins** → **Development** →
   **figma-sync (vaca)**.

## Usar

1. Corré el extractor si no lo hiciste (Fase 1): `node extractor/run.mjs
   transparencia` desde `figma-sync/`.
2. Abrí el plugin, cargá `output/transparencia.json` primero (menos
   nodos, más fácil de verificar uno por uno) antes de `niveles.json`.
3. Al terminar, el panel muestra tres números: binds aplicados, omitidos
   a propósito (shadow, padding/gap sin Auto Layout, line-height, fuente
   no disponible) y variables no encontradas en este archivo de Figma.

## Criterio de éxito (doc §6)

Click en el fill de un nodo importado → el panel derecho de Figma debe
mostrar el **nombre de la variable** ligada (ej. `card/bg`), no un hex
suelto. Si muestra hex, algo no bindeó — revisar la lista de "no
encontradas" en el panel del plugin primero.

## Si `notFoundInFigma` no sale vacío

Significa que el `figmaName` que armó la Fase 0 (`build-token-map.mjs`)
no matchea el nombre real de ninguna variable en ESTE archivo de Figma
-- típicamente porque las variables de Figma todavía no existen con ese
nombre exacto, o difieren en mayúsculas/orden de segmentos. No es un bug
del plugin: es la apuesta central del pipeline (ADR 0009) fallando para
ese token puntual -- hay que corregir el nombre en Figma o revisar
`token-map.json`.
