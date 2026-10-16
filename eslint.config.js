import tseslint from "typescript-eslint";
export default tseslint.config(
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "off" } },
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-console": "error",
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "exit",
          message: "Core must return data, not exit.",
        },
        {
          object: "process",
          property: "stdout",
          message: "Terminal I/O belongs in the CLI.",
        },
        {
          object: "process",
          property: "stderr",
          message: "Terminal I/O belongs in the CLI.",
        },
      ],
    },
  },
);
