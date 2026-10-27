import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/core/index.ts", "src/cli/index.ts"],
  format: ["esm"],
  target: "node22",
  dts: true,
  sourcemap: true,
  clean: true,
});
