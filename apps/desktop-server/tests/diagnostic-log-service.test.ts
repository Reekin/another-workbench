import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
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

  it("serializes concurrent writes and rotates bounded log files", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "another-workbench-diagnostics-"));
    let entrySequence = 0;
    const service = new DiagnosticLogService({
      baseDir,
      now: () => "2026-07-19T10:00:00.000Z",
      createEntryId: () => `diagnostic-${++entrySequence}`,
      maxEntryBytes: 256,
      maxFileBytes: 320,
      maxFiles: 3
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        service.write({
          kind: "renderer-long-task",
          severity: "warning",
          message: `entry-${index}-${"x".repeat(120)}`,
          context: {
            oversized: "y".repeat(1_000)
          }
        })
      )
    );

    const logsDir = join(baseDir, "logs");
    const names = (await readdir(logsDir)).sort();
    expect(names).toEqual([
      "perf-2026-07-19.jsonl",
      "perf-2026-07-19.jsonl.1",
      "perf-2026-07-19.jsonl.2"
    ]);
    for (const name of names) {
      expect((await stat(join(logsDir, name))).size).toBeLessThanOrEqual(320);
      const lines = (await readFile(join(logsDir, name), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const line of lines) {
        expect(Buffer.from(line, "utf8").length).toBeLessThanOrEqual(256);
        expect(JSON.parse(line)).toMatchObject({
          context: {
            truncated: true
          }
        });
      }
    }
  });
});
