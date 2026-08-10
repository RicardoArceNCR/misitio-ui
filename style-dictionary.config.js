const tailwindTypographyBridgeFormat = require("./format-tailwind-typography");

module.exports = {
  // Style Dictionary v4: los formatos/transforms/filters custom se declaran
  // aquí, en `hooks` — ya no existe StyleDictionary.registerFormat estático.
  hooks: {
    formats: {
      "css/tailwind-typography-bridge": tailwindTypographyBridgeFormat,
    },
  },
  source: [
    "source/primitivos.json",
    "source/semanticos.json",
    "source/componentes.json",
    "source/spacing.json",
    "source/tipografia.json",
    "source/motion.json",
    "source/opacity.json",
    "source/breakpoints.json",
    "source/shadow.json",
    "source/z-index.json",
  ],
  platforms: {
    css: {
      transformGroup: "css",
      buildPath: "build/",
      files: [
        {
          destination: "tokens.css",
          format: "css/variables",
          options: {
            selector: ":root",
            outputReferences: true,
          },
        },
      ],
    },
    js: {
      transformGroup: "js",
      buildPath: "build/",
      files: [
        {
          destination: "tokens.js",
          format: "javascript/esm",
        },
      ],
    },
    // Genera SOLO la sección tipográfica de theme-bridge.css — el resto
    // del bridge (colores semánticos → API shadcn, breakpoints, radius,
    // spacing, motion) sigue siendo curado a mano en theme-bridge.css,
    // porque es una decisión de diseño, no una derivación mecánica.
    tailwindTypography: {
      transformGroup: "css",
      buildPath: "build/",
      files: [
        {
          destination: "theme-bridge-typography.generated.css",
          format: "css/tailwind-typography-bridge",
        },
      ],
    },
  },
};
