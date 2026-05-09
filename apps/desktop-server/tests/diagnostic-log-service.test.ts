import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DiagnosticLogService } from "../src/diagnostic-log-service.js";

describe("DiagnosticLogService", () => {
  it("persists performance diagnostics as daily JSONL", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "another-workbench-diagnostics-"));
    const service = new DiagnosticLogService({
      baseDir,
      now: () => "2026-05-09T21:12:03.586Z",
      createEntryId: () => "diagnostic-test-entry"
    });

    const result = await service.write({
      kind: "renderer-stall",
      severity: "warning",
      source: "renderer-diagnostics",
      message: "Renderer event loop stall detected.",
      diagnosticId: "renderer-test",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      cursor: "cursor-1",
      metrics: {
        lagMs: 1234,
        usedJSHeapSize: 42
      },
      context: {
        href: "file:///app/index.html"
      }
    });

    expect(result).toEqual({
      logged: true,
      entryId: "diagnostic-test-entry",
      logPath: join(baseDir, "logs", "perf-2026-05-09.jsonl")
    });

    const content = await readFile(result.logPath, "utf8");
    expect(JSON.parse(content.trim())).toMatchObject({
      version: 1,
      entryId: "diagnostic-test-entry",
      occurredAt: "2026-05-09T21:12:03.586Z",
      severity: "warning",
      kind: "renderer-stall",
      source: "renderer-diagnostics",
      diagnosticId: "renderer-test",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      cursor: "cursor-1",
      metrics: {
        lagMs: 1234,
        usedJSHeapSize: 42
      },
      context: {
        href: "file:///app/index.html"
      }
    });
  });
});
