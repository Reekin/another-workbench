import { useEffect, useRef } from "react";
import type { DiagnosticsWriteInputRpc } from "@another-workbench/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";

type RendererDiagnosticsContext = {
  activeSessionId?: string;
  activeWorkspaceId?: string;
  eventCursor?: string;
};

type PerformanceWithMemory = Performance & {
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
};

const diagnosticId = `renderer-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 10)}`;
const heartbeatIntervalMs = 30_000;
const eventLoopProbeIntervalMs = 1_000;
const stallWarningThresholdMs = 1_000;
const inputDelayWarningThresholdMs = 250;
const longTaskWarningThresholdMs = 250;
const incidentCooldownMs = 60_000;
const maxDiagnosticBytes = 32 * 1024;

const nowIso = (): string => new Date().toISOString();

type DiagnosticTransport = Pick<DesktopTransport, "diagnostics">;

export type BoundedDiagnosticWriter = {
  write: (
    entry: DiagnosticsWriteInputRpc,
    options?: { cooldownKey?: string; cooldownMs?: number }
  ) => void;
  dispose: () => void;
};

const fitDiagnosticInput = (
  entry: DiagnosticsWriteInputRpc,
  maxBytes: number
): DiagnosticsWriteInputRpc => {
  if (new TextEncoder().encode(JSON.stringify(entry)).byteLength <= maxBytes) {
    return entry;
  }
  const trimmed = {
    ...entry,
    message: entry.message?.slice(0, 512),
    context: {
      truncated: true,
      reason: "Renderer diagnostic exceeded the configured byte limit."
    }
  };
  if (new TextEncoder().encode(JSON.stringify(trimmed)).byteLength <= maxBytes) {
    return trimmed;
  }
  return {
    ...trimmed,
    metrics: undefined
  };
};

export const createBoundedDiagnosticWriter = (input: {
  transport: DiagnosticTransport;
  getContext: () => RendererDiagnosticsContext;
  nowMs?: () => number;
  maxBytes?: number;
}): BoundedDiagnosticWriter => {
  const nowMs = input.nowMs ?? (() => Date.now());
  const cooldowns = new Map<string, number>();
  let disposed = false;
  let inFlight = false;
  let pending: DiagnosticsWriteInputRpc | undefined;
  let droppedByCooldown = 0;
  let droppedByOverwrite = 0;

  const drain = (): void => {
    if (disposed || inFlight || !pending) {
      return;
    }
    const queuedEntry = pending;
    pending = undefined;
    const context = input.getContext();
    const entry = fitDiagnosticInput(
      {
        diagnosticId,
        sessionId: context.activeSessionId,
        workspaceId: context.activeWorkspaceId,
        cursor: context.eventCursor,
        ...queuedEntry,
        metrics: {
          ...queuedEntry.metrics,
          droppedByCooldown,
          droppedByOverwrite
        }
      },
      input.maxBytes ?? maxDiagnosticBytes
    );
    droppedByCooldown = 0;
    droppedByOverwrite = 0;
    inFlight = true;
    void input.transport.diagnostics.write(entry).catch(() => undefined).finally(() => {
      inFlight = false;
      drain();
    });
  };

  return {
    write: (entry, options = {}) => {
      if (disposed) {
        return;
      }
      if (options.cooldownKey) {
        const currentMs = nowMs();
        const availableAt = cooldowns.get(options.cooldownKey) ?? 0;
        if (currentMs < availableAt) {
          droppedByCooldown += 1;
          return;
        }
        cooldowns.set(
          options.cooldownKey,
          currentMs + (options.cooldownMs ?? incidentCooldownMs)
        );
      }
      if (pending) {
        droppedByOverwrite += 1;
      }
      pending = entry;
      drain();
    },
    dispose: () => {
      disposed = true;
      pending = undefined;
      cooldowns.clear();
    }
  };
};

const getMemorySnapshot = (): Record<string, unknown> | undefined => {
  const memory = (window.performance as PerformanceWithMemory).memory;
  if (!memory) {
    return undefined;
  }
  return {
    usedJSHeapSize: memory.usedJSHeapSize,
    totalJSHeapSize: memory.totalJSHeapSize,
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
    usedHeapRatio:
      memory.jsHeapSizeLimit > 0
        ? Number((memory.usedJSHeapSize / memory.jsHeapSizeLimit).toFixed(4))
        : undefined
  };
};

const describeEventTarget = (target: EventTarget | null): Record<string, unknown> => {
  if (!(target instanceof Element)) {
    return {};
  }
  return {
    tagName: target.tagName.toLowerCase(),
    id: target.id || undefined,
    className:
      typeof target.className === "string"
        ? target.className.split(/\s+/).filter(Boolean).slice(0, 4).join(" ")
        : undefined,
    role: target.getAttribute("role") ?? undefined,
    ariaLabel: target.getAttribute("aria-label") ?? undefined
  };
};

export const useRendererDiagnostics = (input: {
  transport?: DesktopTransport;
  activeSessionId?: string;
  activeWorkspaceId?: string;
  eventCursor?: string;
}): void => {
  const contextRef = useRef<RendererDiagnosticsContext>({});
  const lagStatsRef = useRef({
    maxLagMs: 0,
    sampleCount: 0,
    stallCount: 0
  });
  const longTaskStatsRef = useRef({
    count: 0,
    maxDurationMs: 0,
    totalDurationMs: 0
  });

  useEffect(() => {
    contextRef.current = {
      activeSessionId: input.activeSessionId,
      activeWorkspaceId: input.activeWorkspaceId,
      eventCursor: input.eventCursor
    };
  }, [input.activeSessionId, input.activeWorkspaceId, input.eventCursor]);

  useEffect(() => {
    if (!input.transport) {
      return;
    }
    const transport = input.transport;

    const writer = createBoundedDiagnosticWriter({
      transport,
      getContext: () => contextRef.current
    });

    let expectedTick = window.performance.now() + eventLoopProbeIntervalMs;
    const eventLoopIntervalId = window.setInterval(() => {
      const actual = window.performance.now();
      const lagMs = Math.max(0, Math.round(actual - expectedTick));
      expectedTick = actual + eventLoopProbeIntervalMs;
      lagStatsRef.current.sampleCount += 1;
      lagStatsRef.current.maxLagMs = Math.max(lagStatsRef.current.maxLagMs, lagMs);
      if (lagMs >= stallWarningThresholdMs) {
        lagStatsRef.current.stallCount += 1;
        const sample = {
          at: nowIso(),
          kind: "renderer-stall" as const,
          metrics: {
            lagMs,
            sampleCount: lagStatsRef.current.sampleCount,
            stallCount: lagStatsRef.current.stallCount
          },
          context: {
            href: window.location.href,
            visibilityState: document.visibilityState,
            memory: getMemorySnapshot()
          }
        };
        writer.write({
          kind: "renderer-stall",
          severity: "warning",
          source: "renderer-diagnostics",
          message: "Renderer event loop stall detected.",
          occurredAt: sample.at,
          metrics: sample.metrics,
          context: sample.context
        }, { cooldownKey: "renderer-stall" });
      }
    }, eventLoopProbeIntervalMs);

    const heartbeatIntervalId = window.setInterval(() => {
      const lagStats = lagStatsRef.current;
      const longTaskStats = longTaskStatsRef.current;
      const occurredAt = nowIso();
      const metrics = {
        maxLagMs: lagStats.maxLagMs,
        lagSampleCount: lagStats.sampleCount,
        stallCount: lagStats.stallCount,
        longTaskCount: longTaskStats.count,
        maxLongTaskDurationMs: Math.round(longTaskStats.maxDurationMs),
        totalLongTaskDurationMs: Math.round(longTaskStats.totalDurationMs),
        memory: getMemorySnapshot()
      };
      writer.write({
        kind: "renderer-heartbeat",
        severity:
          lagStats.stallCount > 0 || longTaskStats.maxDurationMs >= longTaskWarningThresholdMs
            ? "warning"
            : "info",
        source: "renderer-diagnostics",
        message: "Renderer performance heartbeat.",
        occurredAt,
        metrics,
        context: {
          href: window.location.href,
          visibilityState: document.visibilityState
        }
      });
      lagStatsRef.current = {
        maxLagMs: 0,
        sampleCount: 0,
        stallCount: 0
      };
      longTaskStatsRef.current = {
        count: 0,
        maxDurationMs: 0,
        totalDurationMs: 0
      };
    }, heartbeatIntervalMs);

    const observer =
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes.includes("longtask")
        ? new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              longTaskStatsRef.current.count += 1;
              longTaskStatsRef.current.totalDurationMs += entry.duration;
              longTaskStatsRef.current.maxDurationMs = Math.max(
                longTaskStatsRef.current.maxDurationMs,
                entry.duration
              );
              if (entry.duration >= longTaskWarningThresholdMs) {
                const sample = {
                  at: nowIso(),
                  kind: "renderer-long-task" as const,
                  metrics: {
                    durationMs: Math.round(entry.duration),
                    startTimeMs: Math.round(entry.startTime)
                  },
                  context: {
                    name: entry.name,
                    entryType: entry.entryType,
                    href: window.location.href,
                    memory: getMemorySnapshot()
                  }
                };
                writer.write({
                  kind: "renderer-long-task",
                  severity: "warning",
                  source: "renderer-diagnostics",
                  message: "Renderer long task detected.",
                  occurredAt: sample.at,
                  metrics: sample.metrics,
                  context: sample.context
                }, { cooldownKey: "renderer-long-task" });
              }
            }
          })
        : undefined;
    observer?.observe({
      entryTypes: ["longtask"]
    });

    const handleUserInput = (event: Event): void => {
      const startedAt = nowIso();
      const startedMs = window.performance.now();
      window.requestAnimationFrame(() => {
        const delayMs = Math.max(0, Math.round(window.performance.now() - startedMs));
        const target = describeEventTarget(event.target);
        const sample = {
          at: startedAt,
          kind: "ui-input-delay" as const,
          metrics: {
            delayMs
          },
          context: {
            eventType: event.type,
            target,
            href: window.location.href
          }
        };
        if (delayMs >= inputDelayWarningThresholdMs) {
          writer.write({
            kind: "ui-input-delay",
            severity: "warning",
            source: "renderer-diagnostics",
            message: "User input waited too long for the next animation frame.",
            occurredAt: startedAt,
            metrics: sample.metrics,
            context: sample.context
          }, { cooldownKey: "ui-input-delay" });
        }
      });
    };

    window.addEventListener("pointerdown", handleUserInput, {
      capture: true,
      passive: true
    });
    window.addEventListener("keydown", handleUserInput, {
      capture: true,
      passive: true
    });

    return () => {
      writer.dispose();
      window.clearInterval(eventLoopIntervalId);
      window.clearInterval(heartbeatIntervalId);
      observer?.disconnect();
      window.removeEventListener("pointerdown", handleUserInput, {
        capture: true
      });
      window.removeEventListener("keydown", handleUserInput, {
        capture: true
      });
    };
  }, [input.transport]);
};
