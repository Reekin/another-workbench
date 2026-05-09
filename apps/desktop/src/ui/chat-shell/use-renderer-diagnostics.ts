import { useEffect, useRef } from "react";
import type { DiagnosticsWriteInputRpc } from "@another-workbench/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";

type RendererDiagnosticsContext = {
  activeSessionId?: string;
  activeWorkspaceId?: string;
  eventCursor?: string;
};

type RendererDiagnosticSample = {
  at: string;
  kind: DiagnosticsWriteInputRpc["kind"];
  metrics?: Record<string, unknown>;
  context?: Record<string, unknown>;
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
const maxRecentSamples = 120;
const heartbeatIntervalMs = 15_000;
const eventLoopProbeIntervalMs = 1_000;
const stallWarningThresholdMs = 1_000;
const inputDelayWarningThresholdMs = 250;
const longTaskWarningThresholdMs = 250;

const nowIso = (): string => new Date().toISOString();

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
  const samplesRef = useRef<RendererDiagnosticSample[]>([]);
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
    let disposed = false;

    const recordSample = (sample: RendererDiagnosticSample): void => {
      samplesRef.current = [...samplesRef.current.slice(-(maxRecentSamples - 1)), sample];
    };

    const writeDiagnostic = (entry: DiagnosticsWriteInputRpc): void => {
      if (disposed) {
        return;
      }
      const context = contextRef.current;
      void transport.diagnostics
        .write({
          diagnosticId,
          sessionId: context.activeSessionId,
          workspaceId: context.activeWorkspaceId,
          cursor: context.eventCursor,
          ...entry
        })
        .catch(() => undefined);
    };

    const writeBuffer = (reason: string): void => {
      writeDiagnostic({
        kind: "diagnostic-buffer",
        severity: "warning",
        source: "renderer-diagnostics",
        message: `Recent renderer diagnostic samples after ${reason}.`,
        occurredAt: nowIso(),
        context: {
          reason,
          samples: samplesRef.current
        }
      });
    };

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
        recordSample(sample);
        writeDiagnostic({
          kind: "renderer-stall",
          severity: "warning",
          source: "renderer-diagnostics",
          message: "Renderer event loop stall detected.",
          occurredAt: sample.at,
          metrics: sample.metrics,
          context: sample.context
        });
        writeBuffer("renderer-stall");
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
      recordSample({
        at: occurredAt,
        kind: "renderer-heartbeat",
        metrics,
        context: {
          href: window.location.href,
          visibilityState: document.visibilityState
        }
      });
      writeDiagnostic({
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
                recordSample(sample);
                writeDiagnostic({
                  kind: "renderer-long-task",
                  severity: "warning",
                  source: "renderer-diagnostics",
                  message: "Renderer long task detected.",
                  occurredAt: sample.at,
                  metrics: sample.metrics,
                  context: sample.context
                });
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
        recordSample(sample);
        if (delayMs >= inputDelayWarningThresholdMs) {
          writeDiagnostic({
            kind: "ui-input-delay",
            severity: "warning",
            source: "renderer-diagnostics",
            message: "User input waited too long for the next animation frame.",
            occurredAt: startedAt,
            metrics: sample.metrics,
            context: sample.context
          });
          writeBuffer("ui-input-delay");
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
      disposed = true;
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
