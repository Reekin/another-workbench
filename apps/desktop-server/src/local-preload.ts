import type {
  WorkbenchClientApi,
  WorkbenchRpcRequest,
  WorkbenchRpcResponse
} from "@another-workbench/shared";
import { createRemoteRpcHandler } from "./remote-protocol.js";
import type { WorkbenchRuntimeService } from "./runtime-service.js";
import type { WorkbenchShellService } from "./workbench-shell-service.js";

type IdFactory = () => string;

export type LocalDesktopPreloadOptions = {
  createSubscriptionId?: IdFactory;
};

const createOpaqueId = (): string =>
  `local-sub-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

export const createLocalDesktopPreloadApi = (
  service: WorkbenchRuntimeService | WorkbenchShellService,
  options: LocalDesktopPreloadOptions = {}
): WorkbenchClientApi => {
  const createSubscriptionId =
    options.createSubscriptionId ?? createOpaqueId;
  const rpc = createRemoteRpcHandler(service, {
    createSubscriptionId
  });

  return {
    request: async (request: WorkbenchRpcRequest): Promise<WorkbenchRpcResponse> =>
      rpc.handleRequest(request),
    subscribe: async (params, handler) => {
      const subscriptionId = params.subscriptionId ?? createSubscriptionId();
      const unsubscribe = service.subscribeFromCursor(
        (envelope) => {
          handler(rpc.createEventPush(subscriptionId, envelope));
        },
        {
          fromCursor: params.fromCursor,
          filter: params.filter
        }
      );

      return {
        subscriptionId,
        unsubscribe: async () => {
          unsubscribe();
        }
      };
    }
  };
};
