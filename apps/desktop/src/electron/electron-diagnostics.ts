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

export const createElectronDiagnosticsLogger = (options: {
  baseDir?: string;
  now?: () => string;
} = {}): ElectronDiagnosticsLogger => {
  const baseDir = options.baseDir ?? defaultBaseDir();
  const now = options.now ?? (() => new Date().toISOString());

  return {
    log: (input) => {
      const occurredAt = now();
      const entry: ElectronDiagnosticEntry = {
        version: 1,
        occurredAt,
        severity: input.severity ?? "info",
        source: input.source,
        message: input.message,
        details: sanitizeDetails(input.details)
      };
      const logPath = join(baseDir, "logs", `electron-${dayFromIso(occurredAt)}.jsonl`);
      void mkdir(dirname(logPath), { recursive: true })
        .then(() => appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8"))
        .catch(() => undefined);
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
