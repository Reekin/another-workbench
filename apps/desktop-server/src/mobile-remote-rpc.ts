import {
  parseWorkbenchRpcRequest,
  parseWorkbenchRpcResponse,
  type CommandType,
  type SessionActionKindRpc,
  type WorkbenchRpcMethod,
  type WorkbenchRpcRequest,
  type WorkbenchRpcResponse
} from "@another-workbench/shared";
import type { WorkbenchRuntimeService } from "./runtime-service.js";
import type { WorkbenchShellService } from "./workbench-shell-service.js";
import {
  createWorkbenchRpcHandler,
  type WorkbenchRpcHandlerOptions
} from "./workbench-rpc-handler.js";

const allowedMethods = new Set<WorkbenchRpcMethod>([
  "engine.list",
  "engine.getSurface",
  "engine.listModels",
  "domain.snapshot",
  "session.list",
  "workspace.list",
  "sessionBrowser.listRoots",
  "sessionBrowser.listChildren",
  "sessionBrowser.getPath",
  "sessionBrowser.create",
  "sessionBrowser.open",
  "sessionBrowser.loadOlder",
  "sessionBrowser.getActions",
  "sessionBrowser.runAction",
  "chat.getCapabilities",
  "skills.list",
  "chatTree.get",
  "chatTree.jump",
  "delegation.get",
  "worktree.get",
  "checkpoint.get",
  "diagnostics.get",
  "backgroundRun.get",
  "codex.hookActivity.get",
  "codex.turnChanges.get",
  "runtime.command",
  "events.subscribe",
  "events.unsubscribe",
  "events.replay"
]);

const allowedCommandTypes = new Set<CommandType>([
  "createSession",
  "resumeSession",
  "archiveSession",
  "forkSession",
  "sendUserMessage",
  "steerTurn",
  "interruptTurn",
  "setThreadGoal",
  "clearThreadGoal",
  "respondApproval",
  "respondInteraction"
]);

const allowedSessionActions = new Set<SessionActionKindRpc>([
  "archive",
  "copy_awb_session_id",
  "copy_session_id",
  "fork",
  "pin",
  "refresh",
  "resume",
  "unpin"
]);

const deny = (
  request: WorkbenchRpcRequest,
  message: string
): WorkbenchRpcResponse =>
  parseWorkbenchRpcResponse({
    id: request.id,
    method: request.method,
    ok: false,
    error: {
      code: "MOBILE_REMOTE_METHOD_NOT_ALLOWED",
      message
    }
  });

const authorize = (request: WorkbenchRpcRequest): string | undefined => {
  if (!allowedMethods.has(request.method)) {
    return `${request.method} is not available through mobile remote control.`;
  }
  if (
    request.method === "runtime.command"
    && !allowedCommandTypes.has(request.params.envelope.command.type)
  ) {
    return `${request.params.envelope.command.type} is not an allowed mobile command.`;
  }
  if (
    request.method === "sessionBrowser.runAction"
    && !allowedSessionActions.has(request.params.action)
  ) {
    return `${request.params.action} is not an allowed mobile session action.`;
  }
  return undefined;
};

const filterMobileResponse = (
  request: WorkbenchRpcRequest,
  response: WorkbenchRpcResponse
): WorkbenchRpcResponse => {
  if (
    request.method !== "sessionBrowser.getActions"
    || response.method !== "sessionBrowser.getActions"
    || !response.ok
  ) {
    return response;
  }
  return parseWorkbenchRpcResponse({
    ...response,
    result: {
      actions: response.result.actions.filter((action) =>
        allowedSessionActions.has(action.action)
      )
    }
  });
};

export const createMobileRemoteRpcHandler = (
  service: WorkbenchRuntimeService | WorkbenchShellService,
  options: WorkbenchRpcHandlerOptions = {}
) => {
  const handler = createWorkbenchRpcHandler(service, options);
  return {
    async handleRequest(input: WorkbenchRpcRequest): Promise<WorkbenchRpcResponse> {
      const request = parseWorkbenchRpcRequest(input);
      const denial = authorize(request);
      if (denial) {
        return deny(request, denial);
      }
      return filterMobileResponse(request, await handler.handleRequest(request));
    },
    createEventPush: handler.createEventPush
  };
};
