import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const fromHere = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@another-workbench/shared": fromHere("../../packages/shared/src/index.ts"),
      "@another-workbench/core": fromHere("../../packages/core/src/index.ts"),
      "@another-workbench/adapters": fromHere("../../packages/adapters/src/index.ts"),
      "@another-workbench/desktop-server/browser": fromHere("../desktop-server/src/browser.ts")
    }
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fromHere("./index.html"),
        demo: fromHere("./demo.html")
      }
    }
  }
});
