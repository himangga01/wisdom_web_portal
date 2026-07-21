import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    testTimeout: 15_000,
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "hono/jsx",
  },
});
