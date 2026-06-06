import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(currentDir, "..");

await mkdir(resolve(packageRoot, "dist"), { recursive: true });
await cp(resolve(packageRoot, "src/resources"), resolve(packageRoot, "dist/resources"), {
  recursive: true,
  force: true
});
