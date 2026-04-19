import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const currentDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(currentDir, "..");
const devServerUrl = "http://127.0.0.1:4173/";
const mainBundlePath = resolve(desktopRoot, "dist-electron/main.js");
const preloadBundlePath = resolve(desktopRoot, "dist-electron/preload.cjs");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const childProcesses = new Set();

const quoteForCmd = (value) =>
  /[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;

const spawnChild = (command, args, options = {}) => {
  const child =
    process.platform === "win32"
      ? spawn(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", [command, ...args].map(quoteForCmd).join(" ")],
          {
            cwd: desktopRoot,
            stdio: "inherit",
            ...options
          }
        )
      : spawn(command, args, {
          cwd: desktopRoot,
          stdio: "inherit",
          ...options
        });
  childProcesses.add(child);
  child.on("exit", () => {
    childProcesses.delete(child);
  });
  return child;
};

const shutdown = (exitCode = 0) => {
  for (const child of childProcesses) {
    child.kill();
  }
  process.exit(exitCode);
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

const waitForHttp = async (url, attempts = 120) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const waitForFile = async (path, attempts = 120) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${path}`);
};

const electronBundler = spawnChild(pnpmCommand, [
  "exec",
  "node",
  "./scripts/build-electron.mjs",
  "--watch"
]);
const viteServer = spawnChild(pnpmCommand, [
  "exec",
  "vite",
  "--host",
  "127.0.0.1",
  "--port",
  "4173",
  "--strictPort"
]);

const failFast = (label) => (code) => {
  if (code === 0 || code === null) {
    return;
  }
  console.error(`${label} exited unexpectedly with code ${code}.`);
  shutdown(code);
};

electronBundler.on("exit", failFast("electron bundle watcher"));
viteServer.on("exit", failFast("vite dev server"));

await waitForFile(mainBundlePath);
await waitForFile(preloadBundlePath);
await waitForHttp(devServerUrl);

const electron = spawnChild(
  pnpmCommand,
  ["exec", "electron", "./dist-electron/main.js"],
  {
    env: {
      ...process.env,
      NODE_ENV: "development",
      AWB_VITE_DEV_SERVER_URL: devServerUrl
    }
  }
);

electron.on("exit", (code) => {
  shutdown(code ?? 0);
});
