import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  DiagnosticsWriteInputRpc,
  DiagnosticsWriteResultRpc
} from "@another-workbench/shared";

type Clock = () => string;
type IdFactory = () => string;

export type DiagnosticLogServiceOptions = {
  baseDir?: string;
  now?: Clock;
  createEntryId?: IdFactory;
};

export type DiagnosticLogEntry = {
  version: 1;
  entryId: string;
  occurredAt: string;
  severity: DiagnosticsWriteInputRpc["severity"];
  kind: DiagnosticsWriteInputRpc["kind"];
  source?: string;
  message?: string;
  diagnosticId?: string;
  sessionId?: string;
  workspaceId?: string;
  cursor?: string;
  requestId?: string;
  metrics?: Record<string, unknown>;
  context?: Record<string, unknown>;
};

const defaultBaseDir = (): string => join(homedir(), ".another-workbench");

const createOpaqueEntryId = (): string =>
  `diagnostic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const dayFromIso = (value: string): string => {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1] ?? "unknown-date";
};

const ensureJsonSerializable = (entry: DiagnosticLogEntry): DiagnosticLogEntry => {
  try {
    JSON.stringify(entry);
    return entry;
  } catch (error) {
    return {
      ...entry,
      metrics: undefined,
      context: {
        serializationError:
          error instanceof Error ? error.message : "Failed to serialize diagnostic entry."
      }
    };
  }
};

export class DiagnosticLogService {
  private readonly baseDir: string;
  private readonly now: Clock;
  private readonly createEntryId: IdFactory;

  public constructor(options: DiagnosticLogServiceOptions = {}) {
    this.baseDir = options.baseDir ?? defaultBaseDir();
    this.now = options.now ?? (() => new Date().toISOString());
    this.createEntryId = options.createEntryId ?? createOpaqueEntryId;
  }

  public async write(input: DiagnosticsWriteInputRpc): Promise<DiagnosticsWriteResultRpc> {
    const occurredAt = input.occurredAt ?? this.now();
    const entryId = this.createEntryId();
    const logPath = join(this.baseDir, "logs", `perf-${dayFromIso(occurredAt)}.jsonl`);
    const entry = ensureJsonSerializable({
      version: 1,
      entryId,
      occurredAt,
      severity: input.severity ?? "info",
      kind: input.kind,
      source: input.source,
      message: input.message,
      diagnosticId: input.diagnosticId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      cursor: input.cursor,
      requestId: input.requestId,
      metrics: input.metrics,
      context: input.context
    });

    await mkdir(dirname(logPath), {
      recursive: true
    });
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");

    return {
      logged: true,
      entryId,
      logPath
    };
  }
}
