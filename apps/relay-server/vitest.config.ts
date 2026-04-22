import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const fromHere = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@another-workbench/shared": fromHere("../../packages/shared/src/index.ts")
    }
  },
  test: {
    environment: "node"
  }
});
