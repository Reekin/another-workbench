import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import {
  createRuntimeNotStartedError,
  createRuntimePortError,
  createRuntimeRequestTimeoutError,
  type RuntimeOperationOptions
} from "./runtime-lifecycle.js";

export type JsonRpcLineId = string | number;

export type JsonRpcLinePayload = {
  id?: JsonRpcLineId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: string | number;
    message?: string;
    data?: unknown;
  };
};

export type JsonRpcLineRequestPayload = JsonRpcLinePayload & {
  id: JsonRpcLineId;
  method: string;
};

export type JsonRpcLineNotificationPayload = JsonRpcLinePayload & {
  method: string;
};

export type JsonRpcPipelineDiagnostic =
  | {
      type: "read-completed";
      readSeq: number;
      chunkBytes: number;
      bufferedBytesBefore: number;
      bufferedBytesAfter: number;
      parsedLineCount: number;
      parseErrorCount: number;
      notificationCount: number;
      maxNotificationListenerSyncMs: number;
      syncDurationMs: number;
      pendingRequestCount: number;
      methods: Record<string, number>;
    }
  | {
      type: "turn-released";
      firstReadSeq: number;
      lastReadSeq: number;
      readCount: number;
      releaseDelayMs: number;
    };

export type JsonRpcLineClientOptions = {
  input?: Readable;
  output?: Writable;
  defaultTimeoutMs?: number;
  createRequestId?: () => JsonRpcLineId;
  diagnostics?: (event: JsonRpcPipelineDiagnostic) => void;
};

type Listener<T> = (event: T) => void | Promise<void>;

type PendingRequest = {
  id: JsonRpcLineId;
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
  abortListener: (() => void) | undefined;
  signal: AbortSignal | undefined;
};

type PendingWrite = {
  reject: (error: Error) => void;
};

type PendingReleaseProbe = {
  firstReadSeq: number;
  lastReadSeq: number;
  readCount: number;
  completedAt: number;
};

type ActiveReadDiagnostics = {
  readSeq: number;
  chunkBytes: number;
  bufferedBytesBefore: number;
  parsedLineCount: number;
  parseErrorCount: number;
  notificationCount: number;
  maxNotificationListenerSyncMs: number;
  methods: Record<string, number>;
};

const DEFAULT_TIMEOUT_MS = 30_000;

const localRequestId = (id: JsonRpcLineId): string => String(id);

export class JsonRpcLineClient {
  private input: Readable | undefined;
  private output: Writable | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly createRequestId: () => JsonRpcLineId;
  private readonly diagnostics: JsonRpcLineClientOptions["diagnostics"];
  private readonly requestListeners = new Set<Listener<JsonRpcLineRequestPayload>>();
  private readonly notificationListeners = new Set<
    Listener<JsonRpcLineNotificationPayload>
  >();
  private readonly protocolErrorListeners = new Set<Listener<Error>>();
  private readonly pendingById = new Map<string, PendingRequest>();
  private readonly pendingWrites = new Set<PendingWrite>();
  private buffer = "";
  private nextRequestId = 0;
  private nextReadSeq = 0;
  private activeReadDiagnostics: ActiveReadDiagnostics | undefined;
  private pendingReleaseProbe: PendingReleaseProbe | undefined;

  private readonly handleData = (chunk: Buffer | string): void => {
    if (!this.diagnostics) {
      this.consume(chunk);
      return;
    }

    const readSeq = ++this.nextReadSeq;
    const startedAt = performance.now();
    const activeRead: ActiveReadDiagnostics = {
      readSeq,
      chunkBytes:
        typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length,
      bufferedBytesBefore: Buffer.byteLength(this.buffer),
      parsedLineCount: 0,
      parseErrorCount: 0,
      notificationCount: 0,
      maxNotificationListenerSyncMs: 0,
      methods: {}
    };
    this.activeReadDiagnostics = activeRead;
    try {
      this.consume(chunk);
    } finally {
      this.activeReadDiagnostics = undefined;
      const completedAt = performance.now();
      this.diagnostics({
        type: "read-completed",
        ...activeRead,
        bufferedBytesAfter: Buffer.byteLength(this.buffer),
        syncDurationMs: completedAt - startedAt,
        pendingRequestCount: this.pendingById.size
      });
      this.scheduleReleaseProbe(readSeq, completedAt);
    }
  };

  private scheduleReleaseProbe(readSeq: number, completedAt: number): void {
    if (this.pendingReleaseProbe) {
      this.pendingReleaseProbe.lastReadSeq = readSeq;
      this.pendingReleaseProbe.readCount += 1;
      return;
    }

    this.pendingReleaseProbe = {
      firstReadSeq: readSeq,
      lastReadSeq: readSeq,
      readCount: 1,
      completedAt
    };
    setImmediate(() => {
      const probe = this.pendingReleaseProbe;
      this.pendingReleaseProbe = undefined;
      if (!probe) {
        return;
      }
      this.diagnostics?.({
        type: "turn-released",
        firstReadSeq: probe.firstReadSeq,
        lastReadSeq: probe.lastReadSeq,
        readCount: probe.readCount,
        releaseDelayMs: performance.now() - probe.completedAt
      });
    });
  }

  private readonly handleInputError = (error: Error): void => {
    this.rejectAll(
      createRuntimePortError({
        code: "runtime_process_exited",
        message: "Runtime output stream failed.",
        retryable: true,
        cause: error
      })
    );
  };

  private readonly handleOutputError = (error: Error): void => {
    const writeError = createRuntimePortError({
        code: "runtime_write_failed",
        message: "Runtime input stream failed.",
        retryable: true,
        cause: error
    });
    this.rejectAll(writeError);
    this.rejectAllWrites(writeError);
  };

  public constructor(options: JsonRpcLineClientOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.diagnostics = options.diagnostics;
    this.createRequestId =
      options.createRequestId ??
      (() => {
        this.nextRequestId += 1;
        return String(this.nextRequestId);
      });
    if (options.input || options.output) {
      this.attach({
        input: options.input,
        output: options.output
      });
    }
  }

  public attach(inputOutput: {
    input?: Readable;
    output?: Writable;
  }): void {
    this.detachStreams();
    this.input = inputOutput.input;
    this.output = inputOutput.output;
    this.buffer = "";
    this.input?.on("data", this.handleData);
    this.input?.on("error", this.handleInputError);
    this.output?.on("error", this.handleOutputError);
  }

  public dispose(error?: Error): void {
    const disposalError =
      error ??
      createRuntimePortError({
        code: "runtime_process_exited",
        message: "Runtime line client was disposed.",
        retryable: true
      });
    this.rejectAll(disposalError);
    this.rejectAllWrites(disposalError);
    this.detachStreams();
  }

  public getPendingCount(): number {
    return this.pendingById.size;
  }

  public onRequest(listener: Listener<JsonRpcLineRequestPayload>): () => void {
    this.requestListeners.add(listener);
    return () => {
      this.requestListeners.delete(listener);
    };
  }

  public onNotification(
    listener: Listener<JsonRpcLineNotificationPayload>
  ): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  public onProtocolError(listener: Listener<Error>): () => void {
    this.protocolErrorListeners.add(listener);
    return () => {
      this.protocolErrorListeners.delete(listener);
    };
  }

  public request(
    method: string,
    params?: unknown,
    options: RuntimeOperationOptions = {}
  ): Promise<unknown> {
    if (!this.output || this.output.destroyed || this.output.writableEnded) {
      return Promise.reject(
        createRuntimeNotStartedError({
          method
        })
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(this.createAbortError(method));
    }

    const id = this.createRequestId();
    const requestId = localRequestId(id);
    if (this.pendingById.has(requestId)) {
      return Promise.reject(
        createRuntimePortError({
          code: "runtime_protocol_error",
          message: `JSON-RPC request id collision: ${requestId}.`,
          retryable: false,
          details: {
            requestId,
            method
          }
        })
      );
    }

    const payload: JsonRpcLinePayload = {
      id,
      method,
      ...(params === undefined ? {} : { params })
    };

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        id,
        method,
        resolve,
        reject,
        timeout: undefined,
        abortListener: undefined,
        signal: options.signal
      };
      this.pendingById.set(requestId, pending);
      this.installPendingGuards(requestId, pending, options);
      void this.writePayload(payload, options).catch((error: Error) => {
        this.rejectPending(requestId, this.createWriteError(error, method, id));
      });
    });
  }

  public notify(
    method: string,
    params?: unknown,
    options: RuntimeOperationOptions = {}
  ): Promise<void> {
    if (options.signal?.aborted) {
      return Promise.reject(this.createAbortError(method));
    }
    return this.write(
      {
        method,
        ...(params === undefined ? {} : { params })
      },
      options
    );
  }

  public respond(
    id: JsonRpcLineId,
    result: unknown,
    options: RuntimeOperationOptions = {}
  ): Promise<void> {
    if (options.signal?.aborted) {
      return Promise.reject(this.createAbortError("response"));
    }
    return this.write(
      {
        id,
        result
      },
      options
    );
  }

  public respondError(
    id: JsonRpcLineId,
    error: NonNullable<JsonRpcLinePayload["error"]>,
    options: RuntimeOperationOptions = {}
  ): Promise<void> {
    if (options.signal?.aborted) {
      return Promise.reject(this.createAbortError("response"));
    }
    return this.write(
      {
        id,
        error
      },
      options
    );
  }

  public write(
    payload: JsonRpcLinePayload,
    options: RuntimeOperationOptions = {}
  ): Promise<void> {
    if (options.signal?.aborted) {
      return Promise.reject(this.createAbortError(payload.method ?? "write"));
    }
    return this.writePayload(payload, options);
  }

  public rejectAll(error: Error): void {
    for (const requestId of [...this.pendingById.keys()]) {
      this.rejectPending(requestId, error);
    }
  }

  public rejectAllWrites(error: Error): void {
    for (const pendingWrite of [...this.pendingWrites]) {
      pendingWrite.reject(error);
    }
  }

  private detachStreams(): void {
    this.input?.off("data", this.handleData);
    this.input?.off("error", this.handleInputError);
    this.output?.off("error", this.handleOutputError);
    this.input = undefined;
    this.output = undefined;
    this.buffer = "";
  }

  private consume(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : String(chunk);
    for (;;) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line.trim()) {
        continue;
      }
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    if (this.activeReadDiagnostics) {
      this.activeReadDiagnostics.parsedLineCount += 1;
    }
    let payload: JsonRpcLinePayload;
    try {
      payload = JSON.parse(line) as JsonRpcLinePayload;
    } catch (error) {
      if (this.activeReadDiagnostics) {
        this.activeReadDiagnostics.parseErrorCount += 1;
        this.incrementActiveMethod("<parse-error>");
      }
      this.emitProtocolError(
        createRuntimePortError({
          code: "runtime_protocol_error",
          message:
            error instanceof Error ? error.message : "Failed to parse JSON line.",
          retryable: true,
          details: {
            rawLine: line
          },
          cause: error
        })
      );
      return;
    }

    this.incrementActiveMethod(
      typeof payload.method === "string" ? payload.method : "<response>"
    );

    if (typeof payload.method === "string" && payload.id !== undefined) {
      this.emitRequest(payload as JsonRpcLineRequestPayload);
      return;
    }
    if (typeof payload.method === "string") {
      if (this.activeReadDiagnostics) {
        this.activeReadDiagnostics.notificationCount += 1;
      }
      this.emitNotification(payload as JsonRpcLineNotificationPayload);
      return;
    }
    if (payload.id !== undefined) {
      this.handleResponse(payload);
    }
  }

  private handleResponse(payload: JsonRpcLinePayload): void {
    const requestId = localRequestId(payload.id as JsonRpcLineId);
    const pending = this.pendingById.get(requestId);
    if (!pending) {
      return;
    }
    if (payload.error) {
      this.rejectPending(
        requestId,
        createRuntimePortError({
          code: "runtime_protocol_error",
          message: payload.error.message ?? "JSON-RPC request failed.",
          retryable: false,
          details: {
            requestId,
            method: pending.method,
            jsonRpcCode: payload.error.code,
            data: payload.error.data
          }
        })
      );
      return;
    }
    this.resolvePending(requestId, payload.result);
  }

  private installPendingGuards(
    requestId: string,
    pending: PendingRequest,
    options: RuntimeOperationOptions
  ): void {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    if (timeoutMs > 0) {
      pending.timeout = setTimeout(() => {
        this.rejectPending(
          requestId,
          createRuntimeRequestTimeoutError(timeoutMs, {
            requestId,
            method: pending.method
          })
        );
      }, timeoutMs);
    }

    if (options.signal) {
      const onAbort = () => {
        this.rejectPending(requestId, this.createAbortError(pending.method));
      };
      pending.abortListener = onAbort;
      options.signal.addEventListener("abort", onAbort, {
        once: true
      });
    }
  }

  private resolvePending(requestId: string, value: unknown): void {
    const pending = this.pendingById.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingById.delete(requestId);
    this.clearPendingGuards(pending);
    pending.resolve(value);
  }

  private rejectPending(requestId: string, error: Error): void {
    const pending = this.pendingById.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingById.delete(requestId);
    this.clearPendingGuards(pending);
    pending.reject(error);
  }

  private clearPendingGuards(pending: PendingRequest): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
  }

  private writePayload(
    payload: JsonRpcLinePayload,
    options: RuntimeOperationOptions = {}
  ): Promise<void> {
    const output = this.output;
    if (!output || output.destroyed || output.writableEnded) {
      return Promise.reject(createRuntimeNotStartedError());
    }
    if (options.signal?.aborted) {
      return Promise.reject(this.createAbortError(payload.method ?? "write"));
    }

    const line = `${JSON.stringify(payload)}\n`;
    return new Promise((resolve, reject) => {
      let settled = false;
      let abortListener: (() => void) | undefined;
      let pendingWrite: PendingWrite | undefined;
      const settle = (error?: Error | null) => {
        if (settled) {
          return;
        }
        settled = true;
        output.off("drain", onDrain);
        output.off("error", onError);
        if (pendingWrite) {
          this.pendingWrites.delete(pendingWrite);
        }
        if (options.signal && abortListener) {
          options.signal.removeEventListener("abort", abortListener);
        }
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      const onDrain = () => settle();
      const onError = (error: Error) => settle(error);
      abortListener = () => settle(this.createAbortError(payload.method ?? "write"));
      pendingWrite = {
        reject: (error) => settle(error)
      };
      this.pendingWrites.add(pendingWrite);

      output.once("error", onError);
      if (options.signal) {
        options.signal.addEventListener("abort", abortListener, {
          once: true
        });
      }

      let accepted: boolean;
      try {
        accepted = output.write(line, (error?: Error | null) => {
          if (error) {
            settle(error);
            return;
          }
          if (accepted) {
            settle();
          }
        });
      } catch (error) {
        settle(error instanceof Error ? error : new Error("Runtime write failed."));
        return;
      }

      if (!accepted) {
        output.once("drain", onDrain);
      }
    });
  }

  private createAbortError(method: string): Error {
    return createRuntimePortError({
      code: "runtime_request_aborted",
      message: "Runtime request was aborted.",
      retryable: true,
      details: {
        method
      }
    });
  }

  private createWriteError(
    error: Error,
    method: string,
    id: JsonRpcLineId
  ): Error {
    return createRuntimePortError({
      code: "runtime_write_failed",
      message: "Failed to write JSON-RPC request to runtime.",
      retryable: true,
      details: {
        requestId: localRequestId(id),
        method
      },
      cause: error
    });
  }

  private emitRequest(payload: JsonRpcLineRequestPayload): void {
    for (const listener of this.requestListeners) {
      void Promise.resolve(listener(payload)).catch((error: unknown) => {
        this.emitProtocolError(
          error instanceof Error
            ? error
            : new Error("JSON-RPC request listener failed.")
        );
      });
    }
  }

  private emitNotification(payload: JsonRpcLineNotificationPayload): void {
    const startedAt = this.activeReadDiagnostics ? performance.now() : 0;
    for (const listener of this.notificationListeners) {
      void Promise.resolve(listener(payload)).catch((error: unknown) => {
        this.emitProtocolError(
          error instanceof Error
            ? error
            : new Error("JSON-RPC notification listener failed.")
        );
      });
    }
    if (this.activeReadDiagnostics) {
      this.activeReadDiagnostics.maxNotificationListenerSyncMs = Math.max(
        this.activeReadDiagnostics.maxNotificationListenerSyncMs,
        performance.now() - startedAt
      );
    }
  }

  private incrementActiveMethod(method: string): void {
    if (!this.activeReadDiagnostics) {
      return;
    }
    this.activeReadDiagnostics.methods[method] =
      (this.activeReadDiagnostics.methods[method] ?? 0) + 1;
  }

  private emitProtocolError(error: Error): void {
    for (const listener of this.protocolErrorListeners) {
      void Promise.resolve(listener(error));
    }
  }
}
