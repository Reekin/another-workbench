import type { DiagnosticsWriteInputRpc } from "@another-workbench/shared";
import { describe, expect, it } from "vitest";
import { RuntimePipelineDiagnostics } from "../src/runtime/runtime-pipeline-diagnostics.js";

describe("RuntimePipelineDiagnostics", () => {
  it("aggregates pipeline volume and emits threshold diagnostics", () => {
    const writes: DiagnosticsWriteInputRpc[] = [];
    const diagnostics = new RuntimePipelineDiagnostics({
      write: (input) => writes.push(input),
      windowMs: 60_000,
      heartbeatMs: 60_000,
      probeIntervalMs: 60_000,
      stallThresholdMs: 200
    });

    diagnostics.recordRpc({
      type: "read-completed",
      readSeq: 7,
      chunkBytes: 4_096,
      bufferedBytesBefore: 0,
      bufferedBytesAfter: 0,
      parsedLineCount: 30,
      parseErrorCount: 0,
      notificationCount: 29,
      maxNotificationListenerSyncMs: 240,
      syncDurationMs: 260,
      pendingRequestCount: 2,
      methods: {
        "item/agentMessage/delta": 20,
        "item/commandExecution/outputDelta": 9,
        "<response>": 1
      }
    });
    diagnostics.recordRpc({
      type: "turn-released",
      firstReadSeq: 7,
      lastReadSeq: 9,
      readCount: 3,
      releaseDelayMs: 350
    });
    diagnostics.recordRuntimeEvent("message.delta", 2_000, 35, 3);
    diagnostics.recordRuntimeEvent("terminal.output", 800, 12, 2);
    diagnostics.flush();
    diagnostics.dispose();

    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime-pipeline",
          severity: "warning",
          context: expect.objectContaining({ stage: "rpc-read-stall" })
        }),
        expect.objectContaining({
          kind: "runtime-pipeline",
          severity: "warning",
          context: expect.objectContaining({ stage: "rpc-turn-release" })
        }),
        expect.objectContaining({
          kind: "runtime-pipeline",
          context: expect.objectContaining({
            stage: "rpc-window",
            methods: expect.objectContaining({
              "item/agentMessage/delta": 20
            })
          }),
          metrics: expect.objectContaining({
            readCount: 1,
            parsedLineCount: 30,
            maxReleaseDelayMs: 350
          })
        }),
        expect.objectContaining({
          kind: "runtime-pipeline",
          context: expect.objectContaining({
            stage: "runtime-event-window",
            byType: {
              "message.delta": 1,
              "terminal.output": 1
            }
          }),
          metrics: expect.objectContaining({
            count: 2,
            textChars: 2_800,
            maxListenerCount: 3
          })
        })
      ])
    );
  });
});
