import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

process.noDeprecation = true;

const execFileAsync = promisify(execFile);

const rootUrl = "http://127.0.0.1:4173";
const fixtureUrl = `${rootUrl}/demo.html?fixture=load-older`;
const sessionName = `awb-load-older-${Date.now()}`;
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const useWindowsShell = process.platform === "win32";

const checkServer = async () => {
  try {
    const response = await fetch(fixtureUrl, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
};

const waitForServer = async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await checkServer()) {
      return;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${fixtureUrl}`);
};

const runAgentBrowser = async (args, options = {}) => {
  const { stdout, stderr } = await execFileAsync(
    npxBin,
    ["agent-browser", "--session", sessionName, ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        npm_config_loglevel: "error"
      },
      maxBuffer: 1024 * 1024,
      shell: useWindowsShell,
      timeout: 60_000,
      ...options
    }
  );
  if (stderr.trim()) {
    process.stderr.write(stderr);
  }
  return stdout.trim();
};

const runLoadOlderWorkflow = async () => {
  const expression = `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (predicate, label, timeoutMs = 25_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = predicate();
        if (value) {
          return value;
        }
        await sleep(50);
      }
      throw new Error("Timed out waiting for " + label);
    };
    const metrics = () => {
      const element = document.querySelector(".awb-transcript");
      if (!element) {
        throw new Error("Missing .awb-transcript");
      }
      const bounds = element.getBoundingClientRect();
      const target = document.elementFromPoint(
        bounds.left + Math.min(80, Math.max(1, bounds.width / 2)),
        bounds.top + 80
      );
      let anchor = target instanceof Element ? target : undefined;
      while (
        anchor &&
        anchor !== element &&
        !anchor.matches("article, .awb-turn, [data-turn-id]")
      ) {
        anchor = anchor.parentElement ?? undefined;
      }
      const text = element.textContent ?? "";
      return {
        scrollTop: Math.round(element.scrollTop),
        scrollHeight: Math.round(element.scrollHeight),
        clientHeight: Math.round(element.clientHeight),
        anchorText: (anchor?.textContent ?? target?.textContent ?? "")
          .trim()
          .slice(0, 160),
        turn02Count: (text.match(/turn 02/g) ?? []).length,
        turn06Count: (text.match(/turn 06/g) ?? []).length
      };
    };
    const loadEarlierButton = () =>
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Load earlier"
      );

    const sessionRow = document.querySelector(".awb-tree__session");
    if (!(sessionRow instanceof HTMLElement)) {
      throw new Error("Missing ACP demo session row");
    }
    sessionRow.click();
    await waitFor(loadEarlierButton, "Load earlier button");

    const before = metrics();
    loadEarlierButton().click();
    await waitFor(() => {
      const next = metrics();
      return next.turn02Count > 0 && next.scrollHeight > before.scrollHeight;
    }, "prepended turns");
    await sleep(1_000);

    return {
      before,
      after: metrics()
    };
  })()`;
  const output = await runAgentBrowser([
    "eval",
    "-b",
    Buffer.from(expression, "utf8").toString("base64")
  ]);
  return JSON.parse(output);
};

const assertCondition = (condition, message, details = {}) => {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
};

const stopDevServer = async (devServer) => {
  if (!devServer || devServer.killed || devServer.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/pid", String(devServer.pid), "/t", "/f"]).catch(
      () => {
        devServer.kill("SIGTERM");
      }
    );
    return;
  }
  devServer.kill("SIGTERM");
};

let devServer;
try {
  if (!(await checkServer())) {
    devServer = spawn(
      pnpmBin,
      [
        "--filter",
        "@another-workbench/desktop",
        "dev",
        "--",
        "--host",
        "127.0.0.1",
        "--port",
        "4173"
      ],
      {
        cwd: repoRoot,
        shell: useWindowsShell,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    devServer.stdout.on("data", (chunk) => process.stdout.write(chunk));
    devServer.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }

  await waitForServer();
  await runAgentBrowser(["open", fixtureUrl]);
  const { before, after } = await runLoadOlderWorkflow();

  const expectedScrollTop =
    after.scrollHeight - before.scrollHeight + before.scrollTop;

  assertCondition(before.turn02Count === 0, "Older turns were visible before loading", {
    before
  });
  assertCondition(before.anchorText.includes("turn 06"), "Initial anchor is not turn 06", {
    before
  });
  assertCondition(after.turn02Count > 0, "Older turns did not appear", {
    before,
    after
  });
  assertCondition(
    after.turn06Count === before.turn06Count,
    "Existing anchor turn was duplicated or removed",
    { before, after }
  );
  assertCondition(
    Math.abs(after.scrollTop - expectedScrollTop) <= 8,
    "Load earlier did not restore the scroll anchor",
    { before, after, expectedScrollTop }
  );
  assertCondition(after.anchorText.includes("turn 06"), "Viewport anchor moved off turn 06", {
    before,
    after
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        before,
        after,
        expectedScrollTop
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        details: error?.details
      },
      null,
      2
    )
  );
  process.exitCode = 1;
} finally {
  await runAgentBrowser(["close"]).catch(() => undefined);
  await stopDevServer(devServer);
}
