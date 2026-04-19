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

export const createTransportRpcHelper = (
  preloadApi: WorkbenchClientApi,
  createId: IdFactory,
  buildError: (input: TransportRpcError) => Error
) => ({
  async request<M extends WorkbenchRpcMethod>(
    method: M,
    params: RpcRequestFor<M>["params"]
  ): Promise<RpcSuccessResponseFor<M>["result"]> {
    const requestId = createId();
    const response = (await preloadApi.request({
      id: requestId,
      method,
      params
    } as RpcRequestFor<M>)) as RpcResponseFor<M> & {
      method: WorkbenchRpcMethod;
      ok: boolean;
      error?: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      result?: unknown;
    };

    if (response.method !== method) {
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

    return (response as {
      result: RpcSuccessResponseFor<M>["result"];
    }).result;
  }
});
