import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
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
  maxEntryBytes?: number;
  maxFileBytes?: number;
  maxFiles?: number;
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
const defaultMaxEntryBytes = 32 * 1024;
const defaultMaxFileBytes = 10 * 1024 * 1024;
const defaultMaxFiles = 3;

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

const fitEntryToBytes = (
  entry: DiagnosticLogEntry,
  maxEntryBytes: number
): DiagnosticLogEntry => {
  const serializable = ensureJsonSerializable(entry);
  if (Buffer.from(JSON.stringify(serializable), "utf8").length <= maxEntryBytes) {
    return serializable;
  }
  const withoutContext = {
    ...serializable,
    context: {
      truncated: true,
      reason: "Diagnostic entry exceeded the configured byte limit."
    }
  };
  if (Buffer.from(JSON.stringify(withoutContext), "utf8").length <= maxEntryBytes) {
    return withoutContext;
  }
  return {
    ...withoutContext,
    message: undefined,
    metrics: undefined
  };
};

type PendingWrite = {
  entry: DiagnosticLogEntry;
  line: string;
  logPath: string;
  resolve: (result: DiagnosticsWriteResultRpc) => void;
  reject: (error: unknown) => void;
};

export class DiagnosticLogService {
  private readonly baseDir: string;
  private readonly now: Clock;
  private readonly createEntryId: IdFactory;
  private readonly maxEntryBytes: number;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly pendingWrites: PendingWrite[] = [];
  private flushScheduled = false;
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(options: DiagnosticLogServiceOptions = {}) {
    this.baseDir = options.baseDir ?? defaultBaseDir();
    this.now = options.now ?? (() => new Date().toISOString());
    this.createEntryId = options.createEntryId ?? createOpaqueEntryId;
    this.maxEntryBytes = options.maxEntryBytes ?? defaultMaxEntryBytes;
    this.maxFileBytes = options.maxFileBytes ?? defaultMaxFileBytes;
    this.maxFiles = Math.max(1, options.maxFiles ?? defaultMaxFiles);
  }

  public async write(input: DiagnosticsWriteInputRpc): Promise<DiagnosticsWriteResultRpc> {
    const occurredAt = input.occurredAt ?? this.now();
    const entryId = this.createEntryId();
    const logPath = join(this.baseDir, "logs", `perf-${dayFromIso(occurredAt)}.jsonl`);
    const entry = fitEntryToBytes({
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
    }, this.maxEntryBytes);
    const line = `${JSON.stringify(entry)}\n`;

    return new Promise<DiagnosticsWriteResultRpc>((resolve, reject) => {
      this.pendingWrites.push({
        entry,
        line,
        logPath,
        resolve,
        reject
      });
      if (this.flushScheduled) {
        return;
      }
      this.flushScheduled = true;
      setImmediate(() => {
        this.flushScheduled = false;
        const batch = this.pendingWrites.splice(0, this.pendingWrites.length);
        this.writeChain = this.writeChain.then(() => this.flushBatch(batch));
      });
    });
  }

  private async flushBatch(batch: PendingWrite[]): Promise<void> {
    const groups = new Map<string, PendingWrite[]>();
    for (const pending of batch) {
      const group = groups.get(pending.logPath);
      if (group) {
        group.push(pending);
      } else {
        groups.set(pending.logPath, [pending]);
      }
    }
    for (const [logPath, pendingWrites] of groups) {
      try {
        await mkdir(dirname(logPath), { recursive: true });
        let content = "";
        let contentBytes = 0;
        const flushContent = async (): Promise<void> => {
          if (!content) {
            return;
          }
          await this.rotateIfNeeded(logPath, contentBytes);
          await appendFile(logPath, content, "utf8");
          content = "";
          contentBytes = 0;
        };
        for (const pending of pendingWrites) {
          const lineBytes = Buffer.from(pending.line, "utf8").length;
          if (content && contentBytes + lineBytes > this.maxFileBytes) {
            await flushContent();
          }
          content += pending.line;
          contentBytes += lineBytes;
        }
        await flushContent();
        for (const pending of pendingWrites) {
          pending.resolve({
            logged: true,
            entryId: pending.entry.entryId,
            logPath
          });
        }
      } catch (error) {
        for (const pending of pendingWrites) {
          pending.reject(error);
        }
      }
    }
  }

  private async rotateIfNeeded(logPath: string, incomingBytes: number): Promise<void> {
    let currentBytes = 0;
    try {
      currentBytes = (await stat(logPath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (currentBytes === 0 || currentBytes + incomingBytes <= this.maxFileBytes) {
      return;
    }
    const oldestPath = `${logPath}.${this.maxFiles - 1}`;
    if (this.maxFiles > 1) {
      await unlink(oldestPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
      for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
        await rename(`${logPath}.${index}`, `${logPath}.${index + 1}`).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") {
              throw error;
            }
          }
        );
      }
      await rename(logPath, `${logPath}.1`);
      return;
    }
    await unlink(logPath);
  }
}
