import { describe, expect, it, vi } from "vitest";
import type { DiagnosticsWriteInputRpc } from "@another-workbench/shared";
import { createBoundedDiagnosticWriter } from "../src/ui/chat-shell/use-renderer-diagnostics.js";

describe("renderer diagnostics writer", () => {
  it("allows one write in flight, coalesces pending entries, and enforces cooldown", async () => {
    const resolvers: Array<() => void> = [];
    const writes: DiagnosticsWriteInputRpc[] = [];
    const write = vi.fn((entry: DiagnosticsWriteInputRpc) => {
      writes.push(entry);
      return new Promise<{ logged: true; entryId: string; logPath: string }>((resolve) => {
        resolvers.push(() => resolve({ logged: true, entryId: "entry", logPath: "log" }));
      });
    });
    let nowMs = 1_000;
    const writer = createBoundedDiagnosticWriter({
      transport: { diagnostics: { write } } as never,
      getContext: () => ({ activeSessionId: "session-1" }),
      nowMs: () => nowMs,
      maxBytes: 1_024
    });

    writer.write(
      { kind: "renderer-stall", context: { huge: "x".repeat(5_000) } },
      { cooldownKey: "stall", cooldownMs: 60_000 }
    );
    writer.write({ kind: "renderer-stall" }, { cooldownKey: "stall" });
    writer.write({ kind: "renderer-heartbeat", message: "first pending" });
    writer.write({ kind: "renderer-heartbeat", message: "latest pending" });

    expect(write).toHaveBeenCalledTimes(1);
    expect(new TextEncoder().encode(JSON.stringify(writes[0])).byteLength).toBeLessThanOrEqual(
      1_024
    );
    expect(writes[0]?.context).toMatchObject({ truncated: true });
    resolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(2);
    expect(writes[1]).toMatchObject({
      kind: "renderer-heartbeat",
      message: "latest pending",
      sessionId: "session-1",
      metrics: {
        droppedByCooldown: 1,
        droppedByOverwrite: 1
      }
    });

    nowMs += 60_000;
    resolvers.shift()?.();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    writer.write({ kind: "renderer-stall" }, { cooldownKey: "stall" });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(3));
    writer.dispose();
  });
});
