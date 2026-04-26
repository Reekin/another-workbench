import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ErrorLogWriteInputRpc, ErrorLogWriteResultRpc } from "@another-workbench/shared";

type Clock = () => string;
type IdFactory = () => string;

export type ErrorLogServiceOptions = {
  baseDir?: string;
  now?: Clock;
  createEntryId?: IdFactory;
};

export type ErrorLogEntry = {
  version: 1;
  entryId: string;
  occurredAt: string;
  severity: ErrorLogWriteInputRpc["severity"];
  message: string;
  source?: string;
  stack?: string;
  context?: Record<string, unknown>;
};

const defaultBaseDir = (): string => join(homedir(), ".another-workbench");

const createOpaqueEntryId = (): string =>
  `error-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const dayFromIso = (value: string): string => {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1] ?? "unknown-date";
};

const ensureJsonSerializable = (entry: ErrorLogEntry): ErrorLogEntry => {
  try {
    JSON.stringify(entry);
    return entry;
  } catch (error) {
    return {
      ...entry,
      context: {
        serializationError:
          error instanceof Error ? error.message : "Failed to serialize error context."
      }
    };
  }
};

export class ErrorLogService {
  private readonly baseDir: string;
  private readonly now: Clock;
  private readonly createEntryId: IdFactory;

  public constructor(options: ErrorLogServiceOptions = {}) {
    this.baseDir = options.baseDir ?? defaultBaseDir();
    this.now = options.now ?? (() => new Date().toISOString());
    this.createEntryId = options.createEntryId ?? createOpaqueEntryId;
  }

  public async write(input: ErrorLogWriteInputRpc): Promise<ErrorLogWriteResultRpc> {
    const occurredAt = input.occurredAt ?? this.now();
    const entryId = this.createEntryId();
    const logPath = join(this.baseDir, "logs", `errors-${dayFromIso(occurredAt)}.jsonl`);
    const entry = ensureJsonSerializable({
      version: 1,
      entryId,
      occurredAt,
      severity: input.severity ?? "error",
      message: input.message,
      source: input.source,
      stack: input.stack,
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
