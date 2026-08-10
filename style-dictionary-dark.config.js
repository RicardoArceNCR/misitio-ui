module.exports = {
  source: [
    "source/primitivos.json",
    "source/semanticos-dark.json",
    "source/componentes-dark.json",
    "source/shadow.json",
  ],
  platforms: {
    css: {
      transformGroup: "css",
      buildPath: "build/",
      files: [
        {
          destination: "tokens-dark.css",
          format: "css/variables",
          filter: (token) => !token.filePath || !token.filePath.includes("primitivos"),
          options: {
            selector: ".dark",
            outputReferences: true,
          },
        },
      ],
    },
  },
};
