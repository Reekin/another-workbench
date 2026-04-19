import type {
  WorkbenchEventPush,
  WorkbenchRpcRequest,
  WorkbenchRpcResponse
} from "@another-workbench/shared";
import {
  parseWorkbenchEventPush,
  parseWorkbenchRpcRequest,
  parseWorkbenchRpcResponse
} from "@another-workbench/shared";
import type { WorkbenchRuntimeService } from "./runtime-service.js";
import type { WorkbenchShellService } from "./workbench-shell-service.js";

type Clock = () => string;
type IdFactory = () => string;

export type RemoteProtocolOptions = {
  now?: Clock;
  createSubscriptionId?: IdFactory;
};

const createOpaqueId = (): string =>
  `subscription-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

const toErrorResponse = (
  request: WorkbenchRpcRequest,
  code: string,
  message: string,
  details?: Record<string, unknown>
): WorkbenchRpcResponse =>
  parseWorkbenchRpcResponse({
    id: request.id,
    method: request.method,
    ok: false,
    error: {
      code,
      message,
      details
    }
  });

export const createRemoteRpcHandler = (
  service: WorkbenchRuntimeService | WorkbenchShellService,
  options: RemoteProtocolOptions = {}
) => {
  const now = options.now ?? (() => new Date().toISOString());
  const createSubscriptionId =
    options.createSubscriptionId ?? createOpaqueId;
  const shellService = (
    "listWorkspaces" in service ? service : undefined
  ) as WorkbenchShellService | undefined;

  return {
    async handleRequest(input: WorkbenchRpcRequest): Promise<WorkbenchRpcResponse> {
      const request = parseWorkbenchRpcRequest(input);
      try {
        switch (request.method) {
          case "agent.list":
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                agents: service.listAgents()
              }
            });
          case "agent.select":
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: service.selectAgent(request.params)
            });
          case "domain.snapshot":
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: service.getSnapshotResult()
            });
          case "session.list":
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                sessions: service.listSessions(request.params)
              }
            });
          case "workspace.list": {
            if (!shellService) {
              return toErrorResponse(
                request,
                "WORKSPACE_BROWSER_UNAVAILABLE",
                "Workspace browser APIs are unavailable for this runtime service."
              );
            }
            const result = await shellService.listWorkspaces();
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result
            });
          }
          case "workspace.pickDirectory": {
            if (!shellService) {
              return toErrorResponse(
                request,
                "WORKSPACE_BROWSER_UNAVAILABLE",
                "Workspace browser APIs are unavailable for this runtime service."
              );
            }
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.pickWorkspaceDirectory()
            });
          }
          case "workspace.add": {
            if (!shellService) {
              return toErrorResponse(
                request,
                "WORKSPACE_BROWSER_UNAVAILABLE",
                "Workspace browser APIs are unavailable for this runtime service."
              );
            }
            const workspace = await shellService.addWorkspace(request.params);
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                workspace
              }
            });
          }
          case "workspace.remove": {
            if (!shellService) {
              return toErrorResponse(
                request,
                "WORKSPACE_BROWSER_UNAVAILABLE",
                "Workspace browser APIs are unavailable for this runtime service."
              );
            }
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.removeWorkspace(request.params.workspaceId)
            });
          }
          case "workspace.toggleExpanded":
            if (!shellService) {
              return toErrorResponse(
                request,
                "WORKSPACE_BROWSER_UNAVAILABLE",
                "Workspace browser APIs are unavailable for this runtime service."
              );
            }
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.toggleWorkspaceExpanded(request.params.workspaceId)
            });
          case "workspace.select":
            if (!shellService) {
              return toErrorResponse(
                request,
                "WORKSPACE_BROWSER_UNAVAILABLE",
                "Workspace browser APIs are unavailable for this runtime service."
              );
            }
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.selectWorkspace(request.params.workspaceId)
            });
          case "sessionBrowser.listTree":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SESSION_BROWSER_UNAVAILABLE",
                "Session browser APIs are unavailable for this runtime service."
              );
            }
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.listSessionTree(request.params.workspaceId)
            });
          case "sessionBrowser.reconcile":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SESSION_BROWSER_UNAVAILABLE",
                "Session browser APIs are unavailable for this runtime service."
              );
            }
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.reconcileSessionBrowser(request.params.workspaceId)
            });
          case "sessionBrowser.toggleExpanded":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SESSION_BROWSER_UNAVAILABLE",
                "Session browser APIs are unavailable for this runtime service."
              );
            }
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.toggleSessionExpanded(request.params.sessionId)
            });
          case "sessionBrowser.create":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SESSION_BROWSER_UNAVAILABLE",
                "Session browser APIs are unavailable for this runtime service."
              );
            }
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.createBrowserSession(request.params)
            });
          case "sessionBrowser.open":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SESSION_BROWSER_UNAVAILABLE",
                "Session browser APIs are unavailable for this runtime service."
              );
            }
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.openSession(request.params.sessionId)
            });
          case "sessionBrowser.getActions":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SESSION_BROWSER_UNAVAILABLE",
                "Session browser APIs are unavailable for this runtime service."
              );
            }
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.getSessionActions(request.params.sessionId)
            });
          case "sessionBrowser.runAction":
            if (!shellService) {
              return toErrorResponse(
                request,
                "SESSION_BROWSER_UNAVAILABLE",
                "Session browser APIs are unavailable for this runtime service."
              );
            }
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.runSessionAction(request.params)
            });
          case "chatTree.get":
            if (!shellService) {
              return toErrorResponse(
                request,
                "CHAT_TREE_UNAVAILABLE",
                "Chat tree APIs are unavailable for this runtime service."
              );
            }
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                chatTree: await shellService.getChatTree(request.params.sessionId)
              }
            });
          case "chatTree.jump":
            if (!shellService) {
              return toErrorResponse(
                request,
                "CHAT_TREE_UNAVAILABLE",
                "Chat tree APIs are unavailable for this runtime service."
              );
            }
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: await shellService.jumpChatTree(request.params)
            });
          case "runtime.command": {
            const receipt = await service.executeCommand(request.params.envelope);
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: receipt
            });
          }
          case "events.replay": {
            const envelopes = service.replay({
              fromCursor: request.params.fromCursor,
              toCursor: request.params.toCursor,
              filter: request.params.filter
            });
            return parseWorkbenchRpcResponse({
              id: request.id,
              method: request.method,
              ok: true,
              result: {
                replayed: envelopes.length,
                fromCursor: request.params.fromCursor,
                toCursor: request.params.toCursor,
                envelopes
              }
            });
          }
          case "events.subscribe":
            return toErrorResponse(
              request,
              "REMOTE_EVENTS_REQUIRE_WEBSOCKET",
              "Remote event subscriptions must use the /events WebSocket endpoint.",
              {
                endpoint: "/events",
                subscriptionId:
                  request.params.subscriptionId ?? createSubscriptionId(),
                fromCursor: request.params.fromCursor
              }
            );
          case "events.unsubscribe":
            return toErrorResponse(
              request,
              "REMOTE_EVENTS_REQUIRE_WEBSOCKET",
              "Remote event unsubscription must close the /events WebSocket connection.",
              {
                endpoint: "/events",
                subscriptionId: request.params.subscriptionId
              }
            );
          default: {
            const exhaustive: never = request;
            return exhaustive;
          }
        }
      } catch (error) {
        return toErrorResponse(
          request,
          "REMOTE_REQUEST_FAILED",
          error instanceof Error ? error.message : "Unknown remote request error",
          {
            failedAt: now()
          }
        );
      }
    },

    createEventPush(
      subscriptionId: string,
      envelope: WorkbenchEventPush["envelope"]
    ): WorkbenchEventPush {
      return parseWorkbenchEventPush({
        channel: "workbench.events",
        subscriptionId,
        envelope
      });
    }
  };
};
