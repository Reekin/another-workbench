import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createElectronDiagnosticsLogger,
  createElectronRunJournal,
  isBlankRendererHealth,
  shouldReloadForChildProcessGone,
  shouldReloadForLoadFailure,
  shouldReloadForRenderProcessGone
} from "../src/electron/electron-diagnostics.js";

describe("Electron diagnostics", () => {
  it("detects a completed renderer document with an empty root as blank", () => {
    expect(
      isBlankRendererHealth({
        rootExists: true,
        rootChildCount: 0,
        rootTextLength: 0,
        bodyTextLength: 0,
        readyState: "complete",
        href: "file:///app/index.html"
      })
    ).toBe(true);
    expect(
      isBlankRendererHealth({
        rootExists: true,
        rootChildCount: 1,
        rootTextLength: 12,
        bodyTextLength: 12,
        readyState: "complete",
        href: "file:///app/index.html"
      })
    ).toBe(false);
  });

  it("reloads for renderer crashes but not clean exits", () => {
    expect(shouldReloadForRenderProcessGone({ reason: "crashed", exitCode: 1 })).toBe(
      true
    );
    expect(shouldReloadForRenderProcessGone({ reason: "clean-exit", exitCode: 0 })).toBe(
      false
    );
  });

  it("reloads only main-frame load failures and ignores aborted loads", () => {
    expect(shouldReloadForLoadFailure({ errorCode: -105, isMainFrame: true })).toBe(
      true
    );
    expect(shouldReloadForLoadFailure({ errorCode: -105, isMainFrame: false })).toBe(
      false
    );
    expect(shouldReloadForLoadFailure({ errorCode: -3, isMainFrame: true })).toBe(
      false
    );
  });

  it("reloads windows after GPU child-process loss", () => {
    expect(shouldReloadForChildProcessGone({ type: "GPU", reason: "crashed" })).toBe(
      true
    );
    expect(shouldReloadForChildProcessGone({ type: "Utility", reason: "crashed" })).toBe(
      false
    );
    expect(shouldReloadForChildProcessGone({ type: "GPU", reason: "clean-exit" })).toBe(
      false
    );
  });

  it("records stale runs and removes the current marker after a graceful exit", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "awb-electron-diagnostics-"));
    const markerDir = join(baseDir, "logs", "main-process-runs");
    const occurredAt = "2026-08-03T18:30:00.000Z";
    try {
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(
        join(markerDir, "stale-run.json"),
        JSON.stringify({
          version: 1,
          runId: "stale-run",
          pid: 41,
          startedAt: "2026-08-03T18:00:00.000Z",
          executablePath: "C:\\apps\\another-workbench.exe"
        }),
        "utf8"
      );

      const logger = createElectronDiagnosticsLogger({
        baseDir,
        now: () => occurredAt
      });
      const journal = createElectronRunJournal({
        logger,
        baseDir,
        now: () => occurredAt,
        pid: 84,
        runId: "current-run",
        executablePath: "C:\\apps\\another-workbench.exe",
        processExists: () => false
      });

      journal.start();
      expect(readdirSync(markerDir)).toEqual(["current-run.json"]);

      journal.record("Application before-quit event received.");
      journal.finish("app-quit", { exitCode: 0 });
      expect(readdirSync(markerDir)).toEqual([]);

      const entries = readFileSync(
        join(baseDir, "logs", "electron-2026-08-03.jsonl"),
        "utf8"
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { message: string; details?: unknown });
      expect(entries.map((entry) => entry.message)).toEqual([
        "Previous main process ended without a graceful shutdown.",
        "Main process started.",
        "Application before-quit event received.",
        "Main process exited."
      ]);
      expect(entries[0]?.details).toMatchObject({ runId: "stale-run", pid: 41 });
      expect(entries[3]?.details).toMatchObject({
        runId: "current-run",
        pid: 84,
        reason: "app-quit",
        exitCode: 0
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
