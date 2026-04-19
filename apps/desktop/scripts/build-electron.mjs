import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const currentDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(currentDir, "..");
const watchMode = process.argv.includes("--watch");

const mainEntryPoint = resolve(desktopRoot, "src/electron/main.ts");
const preloadEntryPoint = resolve(desktopRoot, "src/electron/preload.cts");
const outputDir = resolve(desktopRoot, "dist-electron");

const sharedOptions = {
  bundle: true,
  sourcemap: true,
  platform: "node",
  target: "node20",
  external: ["electron"],
  logLevel: "info"
};

const mainBuildOptions = {
  ...sharedOptions,
  format: "esm",
  entryPoints: [mainEntryPoint],
  outfile: resolve(outputDir, "main.js")
};

const preloadBuildOptions = {
  ...sharedOptions,
  format: "cjs",
  entryPoints: [preloadEntryPoint],
  outfile: resolve(outputDir, "preload.cjs")
};

await mkdir(outputDir, { recursive: true });

if (watchMode) {
  const mainContext = await context(mainBuildOptions);
  const preloadContext = await context(preloadBuildOptions);
  await mainContext.watch();
  await preloadContext.watch();
  await mainContext.rebuild();
  await preloadContext.rebuild();
  await new Promise(() => {});
} else {
  await build(mainBuildOptions);
  await build(preloadBuildOptions);
}
