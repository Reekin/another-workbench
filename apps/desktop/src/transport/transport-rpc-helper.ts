import type {
  WorkbenchClientApi,
  WorkbenchRpcMethod,
  WorkbenchRpcRequest,
  WorkbenchRpcResponse
} from "@another-workbench/shared";

type IdFactory = () => string;

type RpcRequestFor<M extends WorkbenchRpcMethod> = Extract<
  WorkbenchRpcRequest,
  { method: M }
>;

type RpcResponseFor<M extends WorkbenchRpcMethod> = Extract<
  WorkbenchRpcResponse,
  { method: M }
>;

type RpcSuccessResponseFor<M extends WorkbenchRpcMethod> = Extract<
  RpcResponseFor<M>,
  { ok: true }
>;

type RpcErrorResponseFor<M extends WorkbenchRpcMethod> = Extract<
  RpcResponseFor<M>,
  { ok: false }
>;

export type TransportRpcError = {
  method: string,
  requestId: string,
  code: string,
  details?: Record<string, unknown>
};

export type TransportRpcTiming = {
  method: string;
  requestId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ok: boolean;
  code?: string;
  paramsBytes?: number;
  responseBytes?: number;
};

export type TransportRpcHelperOptions = {
  now?: () => string;
  monotonicNow?: () => number;
  onRequestSettled?: (timing: TransportRpcTiming) => void;
};

const estimateJsonBytes = (value: unknown): number | undefined => {
  try {
    return JSON.stringify(value).length;
  } catch {
    return undefined;
  }
};

export const createTransportRpcHelper = (
  preloadApi: WorkbenchClientApi,
  createId: IdFactory,
  buildError: (input: TransportRpcError) => Error,
  options: TransportRpcHelperOptions = {}
) => ({
  async request<M extends WorkbenchRpcMethod>(
    method: M,
    params: RpcRequestFor<M>["params"]
  ): Promise<RpcSuccessResponseFor<M>["result"]> {
    const requestId = createId();
    const now = options.now ?? (() => new Date().toISOString());
    const monotonicNow =
      options.monotonicNow ??
      (() =>
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now());
    const startedAt = now();
    const startedMs = monotonicNow();
    const paramsBytes = estimateJsonBytes(params);

    const settle = (input: {
      ok: boolean;
      code?: string;
      response?: unknown;
    }): void => {
      options.onRequestSettled?.({
        method,
        requestId,
        startedAt,
        completedAt: now(),
        durationMs: Math.max(0, Math.round(monotonicNow() - startedMs)),
        ok: input.ok,
        code: input.code,
        paramsBytes,
        responseBytes: estimateJsonBytes(input.response)
      });
    };

    let response: RpcResponseFor<M> & {
      method: WorkbenchRpcMethod;
      ok: boolean;
      error?: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      result?: unknown;
    };

    try {
      response = (await preloadApi.request({
        id: requestId,
        method,
        params
      } as RpcRequestFor<M>)) as typeof response;
    } catch (error) {
      settle({
        ok: false,
        code: "IPC_INVOKE_FAILED"
      });
      throw error;
    }

    if (response.method !== method) {
      settle({
        ok: false,
        code: "IPC_METHOD_MISMATCH",
        response
      });
      throw buildError({
        method,
        code: "IPC_METHOD_MISMATCH",
        details: {
          expectedMethod: method,
          actualMethod: response.method
        },
        requestId
      });
    }

    if (!response.ok) {
      const error = (response as {
        error?: {
          code: string;
          message: string;
          details?: Record<string, unknown>;
        };
      }).error;
      settle({
        ok: false,
        code: error?.code ?? "IPC_REQUEST_FAILED",
        response
      });
      throw buildError({
        method,
        requestId,
        code: error?.code ?? "IPC_REQUEST_FAILED",
        details: {
          message: error?.message ?? "Workbench RPC request failed.",
          ...error?.details
        }
      });
    }

    settle({
      ok: true,
      response
    });

    return (response as {
      result: RpcSuccessResponseFor<M>["result"];
    }).result;
  }
});
