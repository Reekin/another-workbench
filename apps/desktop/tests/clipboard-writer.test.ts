import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeVerifiedClipboardText } from "../src/electron/clipboard-writer.js";
import { createElectronDiagnosticsLogger } from "../src/electron/electron-diagnostics.js";

describe("clipboard writer", () => {
  it("accepts a successful write and normalized Windows line endings", () => {
    const diagnostics = { log: vi.fn(), logSync: vi.fn() };
    const clipboard = {
      writeText: vi.fn(),
      readText: vi.fn(() => "first\r\nsecond")
    };

    writeVerifiedClipboardText(clipboard, diagnostics, "first\nsecond");

    expect(clipboard.writeText).toHaveBeenCalledWith("first\nsecond");
    expect(diagnostics.logSync).not.toHaveBeenCalled();
  });

  it("logs and rejects a clipboard verification mismatch", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "awb-clipboard-writer-"));
    const occurredAt = "2026-09-03T03:00:00.000Z";
    const diagnostics = createElectronDiagnosticsLogger({
      baseDir,
      now: () => occurredAt
    });
    const clipboard = {
      writeText: vi.fn(),
      readText: vi.fn(() => "different")
    };

    try {
      expect(() =>
        writeVerifiedClipboardText(clipboard, diagnostics, "expected")
      ).toThrow("Clipboard contents did not match");
      const entry = JSON.parse(
        readFileSync(
          join(baseDir, "logs", "electron-2026-09-03.jsonl"),
          "utf8"
        ).trim()
      ) as {
        severity: string;
        source: string;
        message: string;
        details: Record<string, unknown>;
      };
      expect(entry).toMatchObject({
        severity: "error",
        source: "clipboard",
        message: "Failed to write clipboard text.",
        details: {
        requestedLength: 8,
        actualLength: 9,
        error: "Clipboard contents did not match the requested text."
        }
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
