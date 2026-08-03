import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(currentDir, "..");

const outputResourcesDir = resolve(packageRoot, "dist/resources");

await mkdir(resolve(packageRoot, "dist"), { recursive: true });
await rm(outputResourcesDir, { recursive: true, force: true });
await cp(resolve(packageRoot, "src/resources"), outputResourcesDir, {
  recursive: true,
  force: true
});
