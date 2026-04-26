import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorLogService } from "../src/error-log-service.js";

describe("ErrorLogService", () => {
  it("persists error entries as daily JSONL with stack traces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "awb-error-log-"));
    const service = new ErrorLogService({
      baseDir: dir,
      now: () => "2026-04-26T04:00:00.000Z",
      createEntryId: () => "error-1"
    });

    const result = await service.write({
      message: "Send failed: boom",
      severity: "error",
      source: "send",
      stack: "Error: boom\n    at send",
      context: {
        sessionId: "session-1"
      }
    });

    expect(result).toEqual({
      logged: true,
      entryId: "error-1",
      logPath: join(dir, "logs", "errors-2026-04-26.jsonl")
    });

    const lines = (await readFile(result.logPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      version: 1,
      entryId: "error-1",
      occurredAt: "2026-04-26T04:00:00.000Z",
      severity: "error",
      message: "Send failed: boom",
      source: "send",
      stack: "Error: boom\n    at send",
      context: {
        sessionId: "session-1"
      }
    });
  });
});
