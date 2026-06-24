import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const root = process.cwd();
const sourceRoots = ["apps", "packages"];
const countedExts = new Set([
  ".ts",
  ".tsx",
  ".cts",
  ".mts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".css"
]);
const productCodeExts = new Set([".ts", ".tsx", ".cts", ".mts", ".go"]);
const excludedParts = new Set([
  "node_modules",
  "dist",
  "dist-web",
  "dist-electron",
  "release",
  "build",
  "coverage",
  ".vite",
  ".turbo"
]);

const toRepoPath = (absolutePath) => relative(root, absolutePath).split(sep).join("/");

const isExcludedPath = (repoPath) => {
  const parts = repoPath.split("/");
  if (parts.some((part) => excludedParts.has(part))) {
    return true;
  }
  if (
    repoPath.includes("/tests/") ||
    repoPath.includes("/test/") ||
    repoPath.includes("/__tests__/") ||
    repoPath.includes("/fixtures/")
  ) {
    return true;
  }
  if (/(^|\/).*\.(test|spec)\.[cm]?[tj]sx?$/.test(repoPath)) {
    return true;
  }
  if (repoPath.endsWith(".d.ts")) {
    return true;
  }
  if (repoPath.includes("/codex-app-server-generated/")) {
    return true;
  }
  return false;
};

const readLineCount = (absolutePath) =>
  readFileSync(absolutePath, "utf8").split(/\r?\n/).length;

const rows = [];

const walk = (absoluteDir) => {
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const absolutePath = join(absoluteDir, entry.name);
    const repoPath = toRepoPath(absolutePath);
    if (entry.isDirectory()) {
      if (!isExcludedPath(`${repoPath}/`)) {
        walk(absolutePath);
      }
      continue;
    }
    const ext = extname(entry.name);
    if (!countedExts.has(ext) || isExcludedPath(repoPath)) {
      continue;
    }
    rows.push({
      repoPath,
      ext,
      lines: readLineCount(absolutePath)
    });
  }
};

for (const sourceRoot of sourceRoots) {
  walk(join(root, sourceRoot));
}

const sum = (items) => items.reduce((total, row) => total + row.lines, 0);
const byExt = new Map();
const byArea = new Map();

for (const row of rows) {
  byExt.set(row.ext, (byExt.get(row.ext) ?? 0) + row.lines);
  const area = row.repoPath.split("/").slice(0, 2).join("/");
  byArea.set(area, (byArea.get(area) ?? 0) + row.lines);
}

const mainProductAreas = new Set([
  "apps/desktop",
  "apps/desktop-server",
  "packages/core",
  "packages/shared",
  "packages/adapters"
]);

const productCodeRows = rows.filter((row) => productCodeExts.has(row.ext));
const mainProductRows = rows.filter((row) =>
  mainProductAreas.has(row.repoPath.split("/").slice(0, 2).join("/"))
);

const sortEntries = (map) =>
  Object.fromEntries([...map.entries()].sort((left, right) => right[1] - left[1]));

const report = {
  sourceRoots,
  excluded: {
    tests: true,
    fixtures: true,
    generatedCodexTypes: true,
    declarations: true,
    buildOutputs: [...excludedParts].sort()
  },
  counts: {
    productCodeTsTsxGo: {
      files: productCodeRows.length,
      lines: sum(productCodeRows)
    },
    mainWorkbenchAllCountedExts: {
      files: mainProductRows.length,
      lines: sum(mainProductRows)
    },
    allAppsPackagesCountedExts: {
      files: rows.length,
      lines: sum(rows)
    }
  },
  byExt: sortEntries(byExt),
  byArea: sortEntries(byArea)
};

console.log(JSON.stringify(report, null, 2));
