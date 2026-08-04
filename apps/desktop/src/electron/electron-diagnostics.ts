import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ElectronDiagnosticSeverity = "info" | "warning" | "error";

export type ElectronDiagnosticEntry = {
  version: 1;
  occurredAt: string;
  severity: ElectronDiagnosticSeverity;
  source: string;
  message: string;
  details?: Record<string, unknown>;
};

export type ElectronDiagnosticsLogger = {
  log: (input: {
    severity?: ElectronDiagnosticSeverity;
    source: string;
    message: string;
    details?: Record<string, unknown>;
  }) => void;
  logSync: (input: {
    severity?: ElectronDiagnosticSeverity;
    source: string;
    message: string;
    details?: Record<string, unknown>;
  }) => void;
};

type ElectronDiagnosticInput = Parameters<ElectronDiagnosticsLogger["log"]>[0];

type ElectronRunMarker = {
  version: 1;
  runId: string;
  pid: number;
  startedAt: string;
  executablePath: string;
};

export type ElectronRunJournal = {
  start: () => void;
  record: (message: string, details?: Record<string, unknown>) => void;
  finish: (reason: string, details?: Record<string, unknown>) => void;
};

export type RendererHealthSnapshot = {
  rootExists: boolean;
  rootChildCount: number;
  rootTextLength: number;
  bodyTextLength: number;
  readyState: string;
  href: string;
};

export type RenderProcessGoneDetails = {
  reason?: string;
  exitCode?: number;
};

export type LoadFailureDetails = {
  errorCode: number;
  isMainFrame?: boolean;
};

export type ChildProcessGoneDetails = {
  type?: string;
  reason?: string;
  exitCode?: number;
};

const defaultBaseDir = (): string => join(homedir(), ".another-workbench");

const dayFromIso = (value: string): string => {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1] ?? "unknown-date";
};

const sanitizeDetails = (
  details: Record<string, unknown> | undefined
): Record<string, unknown> | undefined => {
  if (!details) {
    return undefined;
  }
  try {
    JSON.stringify(details);
    return details;
  } catch (error) {
    return {
      serializationError:
        error instanceof Error ? error.message : "Failed to serialize details."
    };
  }
};

const createEntry = (
  input: ElectronDiagnosticInput,
  occurredAt: string
): ElectronDiagnosticEntry => ({
  version: 1,
  occurredAt,
  severity: input.severity ?? "info",
  source: input.source,
  message: input.message,
  details: sanitizeDetails(input.details)
});

const diagnosticsLogPath = (baseDir: string, occurredAt: string): string =>
  join(baseDir, "logs", `electron-${dayFromIso(occurredAt)}.jsonl`);

export const createElectronDiagnosticsLogger = (options: {
  baseDir?: string;
  now?: () => string;
} = {}): ElectronDiagnosticsLogger => {
  const baseDir = options.baseDir ?? defaultBaseDir();
  const now = options.now ?? (() => new Date().toISOString());

  const logSync = (input: ElectronDiagnosticInput): void => {
    try {
      const occurredAt = now();
      const logPath = diagnosticsLogPath(baseDir, occurredAt);
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(
        logPath,
        `${JSON.stringify(createEntry(input, occurredAt))}\n`,
        "utf8"
      );
    } catch {
      return;
    }
  };

  return {
    log: (input) => {
      const occurredAt = now();
      const entry = createEntry(input, occurredAt);
      const logPath = diagnosticsLogPath(baseDir, occurredAt);
      void mkdir(dirname(logPath), { recursive: true })
        .then(() => appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8"))
        .catch(() => undefined);
    },
    logSync
  };
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const createElectronRunJournal = (options: {
  logger: ElectronDiagnosticsLogger;
  baseDir?: string;
  now?: () => string;
  pid?: number;
  executablePath?: string;
  runId?: string;
  processExists?: (pid: number) => boolean;
}): ElectronRunJournal => {
  const baseDir = options.baseDir ?? defaultBaseDir();
  const now = options.now ?? (() => new Date().toISOString());
  const pid = options.pid ?? process.pid;
  const executablePath = options.executablePath ?? process.execPath;
  const runId = options.runId ?? `${pid}-${Date.now().toString(36)}`;
  const processExists = options.processExists ?? isProcessAlive;
  const markerDir = join(baseDir, "logs", "main-process-runs");
  const markerPath = join(markerDir, `${runId}.json`);
  let finished = false;

  const removeMarker = (path: string): void => {
    try {
      rmSync(path, { force: true });
    } catch {
      return;
    }
  };

  const record = (message: string, details?: Record<string, unknown>): void => {
    options.logger.logSync({
      source: "main-process-lifecycle",
      message,
      details: {
        runId,
        pid,
        executablePath,
        ...details
      }
    });
  };

  return {
    start: () => {
      try {
        mkdirSync(markerDir, { recursive: true });
        for (const name of readdirSync(markerDir)) {
          if (!name.endsWith(".json")) {
            continue;
          }
          const stalePath = join(markerDir, name);
          let marker: ElectronRunMarker;
          try {
            marker = JSON.parse(readFileSync(stalePath, "utf8")) as ElectronRunMarker;
          } catch {
            removeMarker(stalePath);
            continue;
          }
          if (marker.runId === runId || processExists(marker.pid)) {
            continue;
          }
          options.logger.logSync({
            severity: "error",
            source: "main-process-lifecycle",
            message: "Previous main process ended without a graceful shutdown.",
            details: marker
          });
          removeMarker(stalePath);
        }

        const marker: ElectronRunMarker = {
          version: 1,
          runId,
          pid,
          startedAt: now(),
          executablePath
        };
        writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, "utf8");
      } catch {
        options.logger.logSync({
          severity: "error",
          source: "main-process-lifecycle",
          message: "Failed to initialize main process run marker.",
          details: { runId, pid, executablePath }
        });
      }
      record("Main process started.");
    },
    record,
    finish: (reason, details) => {
      if (finished) {
        return;
      }
      finished = true;
      record("Main process exited.", { reason, ...details });
      removeMarker(markerPath);
    }
  };
};

export const isBlankRendererHealth = (snapshot: RendererHealthSnapshot): boolean =>
  snapshot.readyState === "complete" &&
  (!snapshot.rootExists ||
    (snapshot.rootChildCount === 0 &&
      snapshot.rootTextLength === 0 &&
      snapshot.bodyTextLength === 0));

export const shouldReloadForRenderProcessGone = (
  details: RenderProcessGoneDetails
): boolean => details.reason !== "clean-exit";

export const shouldReloadForLoadFailure = (details: LoadFailureDetails): boolean =>
  details.isMainFrame === true && details.errorCode !== -3;

export const shouldReloadForChildProcessGone = (
  details: ChildProcessGoneDetails
): boolean => {
  const processType = details.type?.toLowerCase() ?? "";
  return processType === "gpu" && details.reason !== "clean-exit";
};
