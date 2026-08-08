import { performance } from "node:perf_hooks";
import type { DiagnosticsWriteInputRpc } from "@another-workbench/shared";
import type { JsonRpcPipelineDiagnostic } from "./json-rpc-line-client.js";

export type RuntimePipelineDiagnosticsOptions = {
  write: (input: DiagnosticsWriteInputRpc) => void;
  windowMs?: number;
  heartbeatMs?: number;
  probeIntervalMs?: number;
  stallThresholdMs?: number;
};

const increment = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

export class RuntimePipelineDiagnostics {
  private readonly write: RuntimePipelineDiagnosticsOptions["write"];
  private readonly windowMs: number;
  private readonly heartbeatMs: number;
  private readonly probeIntervalMs: number;
  private readonly stallThresholdMs: number;
  private readonly rpcMethods: Record<string, number> = {};
  private readonly runtimeEventTypes: Record<string, number> = {};
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  private expectedProbeAt = performance.now();
  private lastRead:
    | Extract<JsonRpcPipelineDiagnostic, { type: "read-completed" }>
    | undefined;
  private rpcReadCount = 0;
  private rpcChunkBytes = 0;
  private rpcParsedLineCount = 0;
  private rpcParseErrorCount = 0;
  private rpcNotificationCount = 0;
  private rpcMaxSyncDurationMs = 0;
  private rpcMaxListenerSyncMs = 0;
  private rpcMaxReleaseDelayMs = 0;
  private runtimeEventCount = 0;
  private runtimeEventTextChars = 0;
  private runtimeEventMaxListenerSyncMs = 0;
  private runtimeEventMaxListenerCount = 0;
  private maxEventLoopLagMs = 0;
  private disposed = false;

  public constructor(options: RuntimePipelineDiagnosticsOptions) {
    this.write = options.write;
    this.windowMs = options.windowMs ?? 5_000;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.probeIntervalMs = options.probeIntervalMs ?? 250;
    this.stallThresholdMs = options.stallThresholdMs ?? 200;
    this.scheduleFlush();
    this.scheduleHeartbeat();
    this.expectedProbeAt = performance.now() + this.probeIntervalMs;
    this.scheduleProbe();
  }

  public recordRpc(event: JsonRpcPipelineDiagnostic): void {
    if (event.type === "turn-released") {
      this.rpcMaxReleaseDelayMs = Math.max(
        this.rpcMaxReleaseDelayMs,
        event.releaseDelayMs
      );
      if (event.releaseDelayMs >= this.stallThresholdMs) {
        this.write({
          kind: "runtime-pipeline",
          severity: event.releaseDelayMs >= 1_000 ? "error" : "warning",
          source: "json-rpc-line-client",
          message: "JSON-RPC pipe turn release was delayed.",
          metrics: {
            firstReadSeq: event.firstReadSeq,
            lastReadSeq: event.lastReadSeq,
            readCount: event.readCount,
            releaseDelayMs: Math.round(event.releaseDelayMs)
          },
          context: {
            stage: "rpc-turn-release",
            methods: { ...this.rpcMethods },
            lastRead: this.lastRead
          }
        });
      }
      return;
    }

    this.lastRead = event;
    this.rpcReadCount += 1;
    this.rpcChunkBytes += event.chunkBytes;
    this.rpcParsedLineCount += event.parsedLineCount;
    this.rpcParseErrorCount += event.parseErrorCount;
    this.rpcNotificationCount += event.notificationCount;
    this.rpcMaxSyncDurationMs = Math.max(this.rpcMaxSyncDurationMs, event.syncDurationMs);
    this.rpcMaxListenerSyncMs = Math.max(
      this.rpcMaxListenerSyncMs,
      event.maxNotificationListenerSyncMs
    );
    for (const [method, count] of Object.entries(event.methods)) {
      this.rpcMethods[method] = (this.rpcMethods[method] ?? 0) + count;
    }
    if (event.syncDurationMs >= this.stallThresholdMs) {
      this.write({
        kind: "runtime-pipeline",
        severity: event.syncDurationMs >= 1_000 ? "error" : "warning",
        source: "json-rpc-line-client",
        message: "JSON-RPC pipe read occupied the main thread.",
        metrics: {
          readSeq: event.readSeq,
          chunkBytes: event.chunkBytes,
          parsedLineCount: event.parsedLineCount,
          notificationCount: event.notificationCount,
          syncDurationMs: Math.round(event.syncDurationMs),
          maxNotificationListenerSyncMs: Math.round(event.maxNotificationListenerSyncMs)
        },
        context: {
          stage: "rpc-read-stall",
          methods: event.methods,
          pendingRequestCount: event.pendingRequestCount
        }
      });
    }
  }

  public recordRuntimeEvent(
    eventType: string,
    textChars: number,
    listenerSyncMs: number,
    listenerCount: number
  ): void {
    this.runtimeEventCount += 1;
    this.runtimeEventTextChars += textChars;
    this.runtimeEventMaxListenerSyncMs = Math.max(
      this.runtimeEventMaxListenerSyncMs,
      listenerSyncMs
    );
    this.runtimeEventMaxListenerCount = Math.max(
      this.runtimeEventMaxListenerCount,
      listenerCount
    );
    increment(this.runtimeEventTypes, eventType);
  }

  public flush(): void {
    if (this.rpcReadCount > 0) {
      this.write({
        kind: "runtime-pipeline",
        severity:
          Math.max(this.rpcMaxSyncDurationMs, this.rpcMaxReleaseDelayMs) >=
          this.stallThresholdMs
            ? "warning"
            : "info",
        source: "json-rpc-line-client",
        message: "JSON-RPC pipe activity window.",
        metrics: {
          readCount: this.rpcReadCount,
          chunkBytes: this.rpcChunkBytes,
          parsedLineCount: this.rpcParsedLineCount,
          parseErrorCount: this.rpcParseErrorCount,
          notificationCount: this.rpcNotificationCount,
          maxSyncDurationMs: Math.round(this.rpcMaxSyncDurationMs),
          maxNotificationListenerSyncMs: Math.round(this.rpcMaxListenerSyncMs),
          maxReleaseDelayMs: Math.round(this.rpcMaxReleaseDelayMs)
        },
        context: {
          stage: "rpc-window",
          methods: { ...this.rpcMethods },
          lastRead: this.lastRead
        }
      });
      this.rpcReadCount = 0;
      this.rpcChunkBytes = 0;
      this.rpcParsedLineCount = 0;
      this.rpcParseErrorCount = 0;
      this.rpcNotificationCount = 0;
      this.rpcMaxSyncDurationMs = 0;
      this.rpcMaxListenerSyncMs = 0;
      this.rpcMaxReleaseDelayMs = 0;
      for (const key of Object.keys(this.rpcMethods)) delete this.rpcMethods[key];
    }

    if (this.runtimeEventCount > 0) {
      this.write({
        kind: "runtime-pipeline",
        severity:
          this.runtimeEventMaxListenerSyncMs >= this.stallThresholdMs
            ? "warning"
            : "info",
        source: "codex-app-server-runtime-port",
        message: "Runtime event fan-out activity window.",
        metrics: {
          count: this.runtimeEventCount,
          textChars: this.runtimeEventTextChars,
          maxListenerSyncMs: Math.round(this.runtimeEventMaxListenerSyncMs),
          maxListenerCount: this.runtimeEventMaxListenerCount
        },
        context: {
          stage: "runtime-event-window",
          byType: { ...this.runtimeEventTypes }
        }
      });
      this.runtimeEventCount = 0;
      this.runtimeEventTextChars = 0;
      this.runtimeEventMaxListenerSyncMs = 0;
      this.runtimeEventMaxListenerCount = 0;
      for (const key of Object.keys(this.runtimeEventTypes)) {
        delete this.runtimeEventTypes[key];
      }
    }
  }

  public dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.flush();
  }

  private scheduleFlush(): void {
    this.flushTimer = setTimeout(() => {
      this.flush();
      if (!this.disposed) this.scheduleFlush();
    }, this.windowMs);
    this.flushTimer.unref?.();
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = setTimeout(() => {
      this.writeHeartbeat("main-process-heartbeat", "info", this.maxEventLoopLagMs);
      this.maxEventLoopLagMs = 0;
      if (!this.disposed) this.scheduleHeartbeat();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private scheduleProbe(): void {
    this.probeTimer = setTimeout(() => {
      const current = performance.now();
      const lagMs = Math.max(0, current - this.expectedProbeAt);
      this.maxEventLoopLagMs = Math.max(this.maxEventLoopLagMs, lagMs);
      this.expectedProbeAt = current + this.probeIntervalMs;
      if (lagMs >= this.stallThresholdMs) {
        this.writeHeartbeat(
          "main-process-stall",
          lagMs >= 1_000 ? "error" : "warning",
          lagMs
        );
      }
      if (!this.disposed) this.scheduleProbe();
    }, this.probeIntervalMs);
    this.probeTimer.unref?.();
  }

  private writeHeartbeat(
    kind: "main-process-heartbeat" | "main-process-stall",
    severity: "info" | "warning" | "error",
    lagMs: number
  ): void {
    const memory = process.memoryUsage();
    this.write({
      kind: "runtime-pipeline",
      severity,
      source: "runtime-pipeline-diagnostics",
      message:
        kind === "main-process-stall"
          ? "Main process event loop stall detected."
          : "Main process performance heartbeat.",
      metrics: {
        eventLoopLagMs: Math.round(lagMs),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external
      },
      context: {
        stage:
          kind === "main-process-stall"
            ? "main-process-stall"
            : "main-process-heartbeat",
        lastRead: this.lastRead
      }
    });
  }
}
