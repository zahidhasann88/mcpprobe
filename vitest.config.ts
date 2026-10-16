import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    // Every test spawns real fixture server processes; running files in parallel
    // starves process startup (notably on Windows) and trips the short call timeouts.
    fileParallelism: false,
  },
});
