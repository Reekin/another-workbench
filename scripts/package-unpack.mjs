import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "..");
const desktopRoot = resolve(repoRoot, "apps/desktop");
const releaseRoot = resolve(repoRoot, "release");
const pad = (value) => String(value).padStart(2, "0");
const formatLocalTimestamp = (date) =>
  [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("")
  + "-"
  + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
const outputDir = process.env.AWB_UNPACK_OUTPUT_DIR
  ? resolve(process.env.AWB_UNPACK_OUTPUT_DIR)
  : resolve(
      releaseRoot,
      `another-workbench-unpacked-${formatLocalTimestamp(new Date())}`
    );
const appDir = resolve(outputDir, "resources/app");

const assertInside = (parent, child) => {
  const rel = relative(parent, child);
  if (rel.startsWith("..") || rel === "" || resolve(parent, rel) !== child) {
    throw new Error(`Refusing to write outside ${parent}: ${child}`);
  }
};

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const assertExists = async (path, label) => {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing: ${path}. Run pnpm build first.`);
  }
  await stat(path);
};

const copyDirectory = async (from, to) => {
  await assertExists(from, basename(from));
  await cp(from, to, {
    recursive: true,
    force: true,
    dereference: true,
    verbatimSymlinks: false
  });
};

const desktopRequire = createRequire(resolve(desktopRoot, "package.json"));
const electronBinaryPath = desktopRequire("electron");
const electronDistDir = dirname(electronBinaryPath);

assertInside(releaseRoot, outputDir);
await mkdir(releaseRoot, { recursive: true });
if (existsSync(outputDir)) {
  throw new Error(`Refusing to overwrite existing output directory: ${outputDir}`);
}
await copyDirectory(electronDistDir, outputDir);

await mkdir(appDir, { recursive: true });
await copyDirectory(resolve(desktopRoot, "dist-electron"), resolve(appDir, "dist-electron"));
await copyDirectory(resolve(desktopRoot, "dist-web"), resolve(appDir, "dist-web"));

const rootPackage = await readJson(resolve(repoRoot, "package.json"));
const desktopPackage = await readJson(resolve(desktopRoot, "package.json"));
await writeFile(
  resolve(appDir, "package.json"),
  `${JSON.stringify(
    {
      name: desktopPackage.name,
      productName: "Another Workbench",
      version: rootPackage.version ?? desktopPackage.version ?? "0.0.0",
      private: true,
      type: "module",
      main: "dist-electron/main.js"
    },
    null,
    2
  )}\n`,
  "utf8"
);

if (process.platform === "win32") {
  const electronExe = resolve(outputDir, "electron.exe");
  const appExe = resolve(outputDir, "another-workbench.exe");
  if (existsSync(electronExe)) {
    await rm(appExe, { force: true });
    await rename(electronExe, appExe);
  }
}

await writeFile(
  resolve(outputDir, "README.txt"),
  [
    "Another Workbench unpacked build",
    "",
    process.platform === "win32"
      ? "Run another-workbench.exe from this directory."
      : "Run the Electron binary from this directory.",
    "The application payload is stored in resources/app.",
    ""
  ].join("\n"),
  "utf8"
);

console.log(
  JSON.stringify(
    {
      ok: true,
      outputDir,
      appDir,
      electronDistDir
    },
    null,
    2
  )
);
