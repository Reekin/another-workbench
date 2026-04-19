import type {
  AgentDescriptor,
  Attachment,
  ChatTreeSnapshotRpc,
  ChatSession,
  Command,
  DomainSnapshot,
  SessionActionDescriptorRpc,
  SessionActionKindRpc,
  SessionActionResultRpc,
  WorkbenchClientApi,
  WorkbenchEventPush,
  WorkbenchEventSubscriptionFilter,
  WorkspaceBrowserNodeRpc,
  WorkspaceRecordRpc,
  WorkbenchRpcResponse
} from "@another-workbench/shared";
import { safeParseWorkbenchRpcResponse } from "@another-workbench/shared";

const createOpaqueId = (): string =>
  `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

type Clock = () => string;
type IdFactory = () => string;

export type CommandReceipt = {
  commandId: string;
  commandType: Command["type"];
  accepted: boolean;
};

export type AgentSelectInput = {
  agentId: string;
  config?: Record<string, unknown>;
};

export type SessionCreateInput = {
  agentId: string;
  conversationId?: string;
  workspaceId?: string;
  metadata?: Record<string, unknown>;
};

export type SessionListInput = {
  conversationId?: string;
  includeArchived?: boolean;
};

export type SessionForkInput = {
  sessionId: string;
  fromTurnId?: string;
};

export type WorkspaceAddInput = {
  rootPath: string;
  label?: string;
};

export type WorkspaceRemoveInput = {
  workspaceId: string;
};

export type ChatSendInput = {
  sessionId: string;
  content: string;
  messageId?: string;
  attachments?: Attachment[];
};

export type ChatInterruptInput = {
  sessionId: string;
  turnId: string;
  reason?: string;
};

export type ApprovalRespondInput = {
  sessionId: string;
  requestId: string;
  action: "approve" | "deny" | "defer";
  note?: string;
};

export type EventSubscribeInput = {
  filter?: WorkbenchEventSubscriptionFilter;
  fromCursor?: string;
  subscriptionId?: string;
  onEnvelope: (push: WorkbenchEventPush["envelope"]) => void;
  onPush?: (push: WorkbenchEventPush) => void;
};

export type EventReplayInput = {
  fromCursor: string;
  toCursor?: string;
  filter?: WorkbenchEventSubscriptionFilter;
};

export type EventReplayResult = {
  replayed: number;
  fromCursor: string;
  toCursor?: string;
  envelopes: WorkbenchEventPush["envelope"][];
};

export type SessionBrowserActionInput = {
  sessionId: string;
  action: SessionActionKindRpc;
};

export type DesktopTransportErrorLike = {
  method: string;
  code: string;
  details?: Record<string, unknown>;
  requestId: string;
};

export class DesktopTransportError extends Error {
  public readonly method: string;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;
  public readonly requestId: string;

  public constructor(input: DesktopTransportErrorLike) {
    super(`[${input.method}] ${input.code}`);
    this.name = "DesktopTransportError";
    this.method = input.method;
    this.code = input.code;
    this.details = input.details;
    this.requestId = input.requestId;
  }
}

export type DesktopTransport = {
  agent: {
    list: () => Promise<AgentDescriptor[]>;
    select: (input: AgentSelectInput) => Promise<{ selectedAgentId: string }>;
  };
  domain: {
    snapshot: () => Promise<{ snapshot: DomainSnapshot; cursor?: string }>;
  };
  session: {
    create: (input: SessionCreateInput) => Promise<CommandReceipt>;
    list: (input?: SessionListInput) => Promise<ChatSession[]>;
    resume: (sessionId: string) => Promise<CommandReceipt>;
    archive: (sessionId: string) => Promise<CommandReceipt>;
    fork: (input: SessionForkInput) => Promise<CommandReceipt>;
  };
  workspace: {
    list: () => Promise<{
      workspaces: WorkspaceRecordRpc[];
      lastActiveWorkspaceId?: string;
      lastActiveSessionId?: string;
    }>;
    pickDirectory: () => Promise<{
      canceled: boolean;
      rootPath?: string;
    }>;
    add: (input: WorkspaceAddInput) => Promise<WorkspaceRecordRpc>;
    remove: (input: WorkspaceRemoveInput) => Promise<{
      workspaceId: string;
      removed: boolean;
    }>;
    toggleExpanded: (
      workspaceId: string
    ) => Promise<{ workspaceId: string; expanded: boolean }>;
    select: (
      workspaceId: string
    ) => Promise<{ workspaceId: string; activeSessionId?: string }>;
  };
  sessionBrowser: {
    listTree: (workspaceId?: string) => Promise<{ workspaces: WorkspaceBrowserNodeRpc[] }>;
    reconcile: (workspaceId?: string) => Promise<{
      workspaces: number;
      sessions: number;
      relations: number;
    }>;
    toggleExpanded: (
      sessionId: string
    ) => Promise<{ sessionId: string; expanded: boolean }>;
    create: (input: {
      workspaceId: string;
      agentId: string;
      conversationId?: string;
      metadata?: Record<string, unknown>;
    }) => Promise<{ sessionId: string; conversationId: string }>;
    open: (sessionId: string) => Promise<{ sessionId: string }>;
    getActions: (
      sessionId: string
    ) => Promise<{ actions: SessionActionDescriptorRpc[] }>;
    runAction: (input: SessionBrowserActionInput) => Promise<SessionActionResultRpc>;
  };
  chat: {
    send: (input: ChatSendInput) => Promise<CommandReceipt>;
    interrupt: (input: ChatInterruptInput) => Promise<CommandReceipt>;
  };
  chatTree: {
    get: (sessionId: string) => Promise<ChatTreeSnapshotRpc>;
    jump: (input: {
      sessionId: string;
      nodeId: string;
    }) => Promise<{ jumped: boolean }>;
  };
  approval: {
    respond: (input: ApprovalRespondInput) => Promise<CommandReceipt>;
  };
  events: {
    subscribe: (
      input: EventSubscribeInput
    ) => Promise<{ subscriptionId: string; unsubscribe: () => Promise<void> }>;
    replay: (input: EventReplayInput) => Promise<EventReplayResult>;
  };
};

export type DesktopTransportOptions = {
  createId?: IdFactory;
  now?: Clock;
};

const toTransportError = (
  method: string,
  requestId: string,
  error: { code: string; message: string; details?: Record<string, unknown> }
): DesktopTransportError =>
  new DesktopTransportError({
    method,
    requestId,
    code: error.code,
    details: {
      message: error.message,
      ...error.details
    }
  });

export const createDesktopTransport = (
  preloadApi: WorkbenchClientApi,
  options: DesktopTransportOptions = {}
): DesktopTransport => {
  const createId = options.createId ?? createOpaqueId;
  const now = options.now ?? (() => new Date().toISOString());

  const requestAgentList = async (): Promise<AgentDescriptor[]> => {
    const requestId = createId();
    const response = await preloadApi.request({
      id: requestId,
      method: "agent.list",
      params: {}
    });
    if (response.method !== "agent.list") {
      throw new DesktopTransportError({
        method: "agent.list",
        code: "IPC_METHOD_MISMATCH",
        details: {
          expectedMethod: "agent.list",
          actualMethod: response.method
        },
        requestId
      });
    }
    if (!response.ok) {
      throw toTransportError("agent.list", requestId, response.error);
    }
    const result = response.result as Extract<
      WorkbenchRpcResponse,
      { method: "agent.list"; ok: true }
    >["result"];
    return result.agents;
  };

  const requestAgentSelect = async (
    input: AgentSelectInput
  ): Promise<{ selectedAgentId: string }> => {
    const requestId = createId();
    const response = await preloadApi.request({
      id: requestId,
      method: "agent.select",
      params: {
        agentId: input.agentId,
        config: input.config
      }
    });
    if (response.method !== "agent.select") {
      throw new DesktopTransportError({
        method: "agent.select",
        code: "IPC_METHOD_MISMATCH",
        details: {
          expectedMethod: "agent.select",
          actualMethod: response.method
        },
        requestId
      });
    }
    if (!response.ok) {
      throw toTransportError("agent.select", requestId, response.error);
    }
    return response.result as Extract<
      WorkbenchRpcResponse,
      { method: "agent.select"; ok: true }
    >["result"];
  };

  const requestDomainSnapshot = async (): Promise<{
    snapshot: DomainSnapshot;
    cursor?: string;
  }> => {
    const requestId = createId();
    const rawResponse = await (preloadApi.request as (request: unknown) => Promise<unknown>)({
      id: requestId,
      method: "domain.snapshot",
      params: {}
    });
    const parsed = safeParseWorkbenchRpcResponse(rawResponse);
    if (!parsed.success) {
      throw new DesktopTransportError({
        method: "domain.snapshot",
        code: "IPC_RESPONSE_INVALID",
        details: {
          requestId
        },
        requestId
      });
    }
    const response = parsed.data as
      | {
          id: string;
          method: "domain.snapshot";
          ok: true;
          result: {
            snapshot: DomainSnapshot;
            cursor?: string;
          };
        }
      | {
          id: string;
          method: string;
          ok: false;
          error: {
            code: string;
            message: string;
            details?: Record<string, unknown>;
          };
        };
    if (response.method !== "domain.snapshot") {
      throw new DesktopTransportError({
        method: "domain.snapshot",
        code: "IPC_METHOD_MISMATCH",
        details: {
          expectedMethod: "domain.snapshot",
          actualMethod: response.method
        },
        requestId
      });
    }
    if (!response.ok) {
      throw toTransportError("domain.snapshot", requestId, response.error);
    }
    return response.result;
  };

  const sendCommand = async (command: Command): Promise<CommandReceipt> => {
    const requestId = createId();
    const response = await preloadApi.request({
      id: requestId,
      method: "runtime.command",
      params: {
        envelope: {
          commandId: createId(),
          issuedAt: now(),
          command
        }
      }
    });
    if (response.method !== "runtime.command") {
      throw new DesktopTransportError({
        method: "runtime.command",
        code: "IPC_METHOD_MISMATCH",
        details: {
          expectedMethod: "runtime.command",
          actualMethod: response.method
        },
        requestId
      });
    }
    if (!response.ok) {
      throw toTransportError("runtime.command", requestId, response.error);
    }
    return response.result as Extract<
      WorkbenchRpcResponse,
      { method: "runtime.command"; ok: true }
    >["result"];
  };

  const requestSessionList = async (
    input: SessionListInput = {}
  ): Promise<ChatSession[]> => {
    const requestId = createId();
    const response = await preloadApi.request({
      id: requestId,
      method: "session.list",
      params: {
        conversationId: input.conversationId,
        includeArchived: input.includeArchived ?? false
      }
    });
    if (response.method !== "session.list") {
      throw new DesktopTransportError({
        method: "session.list",
        code: "IPC_METHOD_MISMATCH",
        details: {
          expectedMethod: "session.list",
          actualMethod: response.method
        },
        requestId
      });
    }
    if (!response.ok) {
      throw toTransportError("session.list", requestId, response.error);
    }
    return (response.result as Extract<
      WorkbenchRpcResponse,
      { method: "session.list"; ok: true }
    >["result"]).sessions;
  };

  const requestWorkspaceList = async () => {
    const requestId = createId();
    const response = await preloadApi.request({
      id: requestId,
      method: "workspace.list",
      params: {}
    });
    if (response.method !== "workspace.list") {
      throw new DesktopTransportError({
        method: "workspace.list",
        code: "IPC_METHOD_MISMATCH",
        details: {
          expectedMethod: "workspace.list",
          actualMethod: response.method
        },
        requestId
      });
    }
    if (!response.ok) {
      throw toTransportError("workspace.list", requestId, response.error);
    }
    return response.result as Extract<
      WorkbenchRpcResponse,
      { method: "workspace.list"; ok: true }
    >["result"];
  };

  const requestWorkspaceAdd = async (
    input: WorkspaceAddInput
  ): Promise<WorkspaceRecordRpc> => {
    const requestId = createId();
    const response = await preloadApi.request({
      id: requestId,
      method: "workspace.add",
      params: input
    });
    if (response.method !== "workspace.add") {
      throw new DesktopTransportError({
        method: "workspace.add",
        code: "IPC_METHOD_MISMATCH",
        details: {
          expectedMethod: "workspace.add",
          actualMethod: response.method
        },
        requestId
      });
    }
    if (!response.ok) {
      throw toTransportError("workspace.add", requestId, response.error);
    }
    return (response.result as Extract<
      WorkbenchRpcResponse,
      { method: "workspace.add"; ok: true }
    >["result"]).workspace;
  };

  const requestWorkspacePickDirectory = async (): Promise<{
    canceled: boolean;
    rootPath?: string;
  }> => {
    const requestId = createId();
    const response = await preloadApi.request({
      id: requestId,
      method: "workspace.pickDirectory",
      params: {}
    });
    if (response.method !== "workspace.pickDirectory") {
      throw new DesktopTransportError({
        method: "workspace.pickDirectory",
        code: "IPC_METHOD_MISMATCH",
        details: {
          expectedMethod: "workspace.pickDirectory",
          actualMethod: response.method
        },
        requestId
      });
    }
    if (!response.ok) {
      throw toTransportError("workspace.pickDirectory", requestId, response.error);
    }
    return response.result as Extract<
      WorkbenchRpcResponse,
      { method: "workspace.pickDirectory"; ok: true }
    >["result"];
  };

  const requestWorkspaceRemove = async (
    input: WorkspaceRemoveInput
  ): Promise<{ workspaceId: string; removed: boolean }> => {
    const requestId = createId();
    const response = await preloadApi.request({
      id: requestId,
      method: "workspace.remove",
      params: {
        workspaceId: input.workspaceId
      }
    });
    if (response.method !== "workspace.remove") {
      throw new DesktopTransportError({
        method: "workspace.remove",
        code: "IPC_METHOD_MISMATCH",
        details: {
          expectedMethod: "workspace.remove",
          actualMethod: response.method
        },
        requestId
      });
    }
    if (!response.ok) {
      throw toTransportError("workspace.remove", requestId, response.error);
    }
    return response.result as Extract<
      WorkbenchRpcResponse,
      { method: "workspace.remove"; ok: true }
    >["result"];
  };

  const requestSessionTree = async (workspaceId?: string): Promise<{
    workspaces: WorkspaceBrowserNodeRpc[];
  }> => {
    const requestId = createId();
    const response = await preloadApi.request({
      id: requestId,
      method: "sessionBrowser.listTree",
      params: {
        workspaceId
      }
    });
    if (response.method !== "sessionBrowser.listTree") {
      throw new DesktopTransportError({
        method: "sessionBrowser.listTree",
        code: "IPC_METHOD_MISMATCH",
        details: {
          expectedMethod: "sessionBrowser.listTree",
          actualMethod: response.method
        },
        requestId
      });
    }
    if (!response.ok) {
      throw toTransportError("sessionBrowser.listTree", requestId, response.error);
    }
    return response.result as Extract<
      WorkbenchRpcResponse,
      { method: "sessionBrowser.listTree"; ok: true }
    >["result"];
  };

  return {
    agent: {
      list: requestAgentList,
      select: requestAgentSelect
    },
    domain: {
      snapshot: requestDomainSnapshot
    },
    session: {
      create: (input: SessionCreateInput) =>
        sendCommand({
          type: "createSession",
          agentId: input.agentId,
          conversationId: input.conversationId,
          workspaceId: input.workspaceId,
          metadata: input.metadata
        }),
      list: requestSessionList,
      resume: (sessionId: string) =>
        sendCommand({
          type: "resumeSession",
          sessionId
        }),
      archive: (sessionId: string) =>
        sendCommand({
          type: "archiveSession",
          sessionId
        }),
      fork: (input: SessionForkInput) =>
        sendCommand({
          type: "forkSession",
          sessionId: input.sessionId,
          fromTurnId: input.fromTurnId
        })
    },
    workspace: {
      list: requestWorkspaceList,
      pickDirectory: requestWorkspacePickDirectory,
      add: requestWorkspaceAdd,
      remove: requestWorkspaceRemove,
      toggleExpanded: async (workspaceId: string) => {
        const requestId = createId();
        const response = await preloadApi.request({
          id: requestId,
          method: "workspace.toggleExpanded",
          params: {
            workspaceId
          }
        });
        if (response.method !== "workspace.toggleExpanded") {
          throw new DesktopTransportError({
            method: "workspace.toggleExpanded",
            code: "IPC_METHOD_MISMATCH",
            details: {
              expectedMethod: "workspace.toggleExpanded",
              actualMethod: response.method
            },
            requestId
          });
        }
        if (!response.ok) {
          throw toTransportError(
            "workspace.toggleExpanded",
            requestId,
            response.error
          );
        }
        return response.result as Extract<
          WorkbenchRpcResponse,
          { method: "workspace.toggleExpanded"; ok: true }
        >["result"];
      },
      select: async (workspaceId: string) => {
        const requestId = createId();
        const response = await preloadApi.request({
          id: requestId,
          method: "workspace.select",
          params: {
            workspaceId
          }
        });
        if (response.method !== "workspace.select") {
          throw new DesktopTransportError({
            method: "workspace.select",
            code: "IPC_METHOD_MISMATCH",
            details: {
              expectedMethod: "workspace.select",
              actualMethod: response.method
            },
            requestId
          });
        }
        if (!response.ok) {
          throw toTransportError("workspace.select", requestId, response.error);
        }
        return response.result as Extract<
          WorkbenchRpcResponse,
          { method: "workspace.select"; ok: true }
        >["result"];
      }
    },
    sessionBrowser: {
      listTree: requestSessionTree,
      reconcile: async (workspaceId?: string) => {
        const requestId = createId();
        const response = await preloadApi.request({
          id: requestId,
          method: "sessionBrowser.reconcile",
          params: {
            workspaceId
          }
        });
        if (response.method !== "sessionBrowser.reconcile") {
          throw new DesktopTransportError({
            method: "sessionBrowser.reconcile",
            code: "IPC_METHOD_MISMATCH",
            details: {
              expectedMethod: "sessionBrowser.reconcile",
              actualMethod: response.method
            },
            requestId
          });
        }
        if (!response.ok) {
          throw toTransportError("sessionBrowser.reconcile", requestId, response.error);
        }
        return response.result as Extract<
          WorkbenchRpcResponse,
          { method: "sessionBrowser.reconcile"; ok: true }
        >["result"];
      },
      toggleExpanded: async (sessionId: string) => {
        const requestId = createId();
        const response = await preloadApi.request({
          id: requestId,
          method: "sessionBrowser.toggleExpanded",
          params: {
            sessionId
          }
        });
        if (response.method !== "sessionBrowser.toggleExpanded") {
          throw new DesktopTransportError({
            method: "sessionBrowser.toggleExpanded",
            code: "IPC_METHOD_MISMATCH",
            details: {
              expectedMethod: "sessionBrowser.toggleExpanded",
              actualMethod: response.method
            },
            requestId
          });
        }
        if (!response.ok) {
          throw toTransportError(
            "sessionBrowser.toggleExpanded",
            requestId,
            response.error
          );
        }
        return response.result as Extract<
          WorkbenchRpcResponse,
          { method: "sessionBrowser.toggleExpanded"; ok: true }
        >["result"];
      },
      create: async (input) => {
        const requestId = createId();
        const response = await preloadApi.request({
          id: requestId,
          method: "sessionBrowser.create",
          params: input
        });
        if (response.method !== "sessionBrowser.create") {
          throw new DesktopTransportError({
            method: "sessionBrowser.create",
            code: "IPC_METHOD_MISMATCH",
            details: {
              expectedMethod: "sessionBrowser.create",
              actualMethod: response.method
            },
            requestId
          });
        }
        if (!response.ok) {
          throw toTransportError(
            "sessionBrowser.create",
            requestId,
            response.error
          );
        }
        return response.result as Extract<
          WorkbenchRpcResponse,
          { method: "sessionBrowser.create"; ok: true }
        >["result"];
      },
      open: async (sessionId: string) => {
        const requestId = createId();
        const response = await preloadApi.request({
          id: requestId,
          method: "sessionBrowser.open",
          params: {
            sessionId
          }
        });
        if (response.method !== "sessionBrowser.open") {
          throw new DesktopTransportError({
            method: "sessionBrowser.open",
            code: "IPC_METHOD_MISMATCH",
            details: {
              expectedMethod: "sessionBrowser.open",
              actualMethod: response.method
            },
            requestId
          });
        }
        if (!response.ok) {
          throw toTransportError("sessionBrowser.open", requestId, response.error);
        }
        return response.result as Extract<
          WorkbenchRpcResponse,
          { method: "sessionBrowser.open"; ok: true }
        >["result"];
      },
      getActions: async (sessionId: string) => {
        const requestId = createId();
        const response = await preloadApi.request({
          id: requestId,
          method: "sessionBrowser.getActions",
          params: {
            sessionId
          }
        });
        if (response.method !== "sessionBrowser.getActions") {
          throw new DesktopTransportError({
            method: "sessionBrowser.getActions",
            code: "IPC_METHOD_MISMATCH",
            details: {
              expectedMethod: "sessionBrowser.getActions",
              actualMethod: response.method
            },
            requestId
          });
        }
        if (!response.ok) {
          throw toTransportError(
            "sessionBrowser.getActions",
            requestId,
            response.error
          );
        }
        return response.result as Extract<
          WorkbenchRpcResponse,
          { method: "sessionBrowser.getActions"; ok: true }
        >["result"];
      },
      runAction: async (input: SessionBrowserActionInput) => {
        const requestId = createId();
        const response = await preloadApi.request({
          id: requestId,
          method: "sessionBrowser.runAction",
          params: input
        });
        if (response.method !== "sessionBrowser.runAction") {
          throw new DesktopTransportError({
            method: "sessionBrowser.runAction",
            code: "IPC_METHOD_MISMATCH",
            details: {
              expectedMethod: "sessionBrowser.runAction",
              actualMethod: response.method
            },
            requestId
          });
        }
        if (!response.ok) {
          throw toTransportError(
            "sessionBrowser.runAction",
            requestId,
            response.error
          );
        }
        return response.result as SessionActionResultRpc;
      }
    },
    chat: {
      send: (input: ChatSendInput) =>
        sendCommand({
          type: "sendUserMessage",
          sessionId: input.sessionId,
          content: input.content,
          messageId: input.messageId ?? createId(),
          attachments: input.attachments ?? []
        }),
      interrupt: (input: ChatInterruptInput) =>
        sendCommand({
          type: "interruptTurn",
          sessionId: input.sessionId,
          turnId: input.turnId,
          reason: input.reason
        })
    },
    chatTree: {
      get: async (sessionId: string) => {
        const requestId = createId();
        const response = await preloadApi.request({
          id: requestId,
          method: "chatTree.get",
          params: {
            sessionId
          }
        });
        if (response.method !== "chatTree.get") {
          throw new DesktopTransportError({
            method: "chatTree.get",
            code: "IPC_METHOD_MISMATCH",
            details: {
              expectedMethod: "chatTree.get",
              actualMethod: response.method
            },
            requestId
          });
        }
        if (!response.ok) {
          throw toTransportError("chatTree.get", requestId, response.error);
        }
        return (response.result as Extract<
          WorkbenchRpcResponse,
          { method: "chatTree.get"; ok: true }
        >["result"]).chatTree;
      },
      jump: async (input: { sessionId: string; nodeId: string }) => {
        const requestId = createId();
        const response = await preloadApi.request({
          id: requestId,
          method: "chatTree.jump",
          params: input
        });
        if (response.method !== "chatTree.jump") {
          throw new DesktopTransportError({
            method: "chatTree.jump",
            code: "IPC_METHOD_MISMATCH",
            details: {
              expectedMethod: "chatTree.jump",
              actualMethod: response.method
            },
            requestId
          });
        }
        if (!response.ok) {
          throw toTransportError("chatTree.jump", requestId, response.error);
        }
        return response.result as Extract<
          WorkbenchRpcResponse,
          { method: "chatTree.jump"; ok: true }
        >["result"];
      }
    },
    approval: {
      respond: (input: ApprovalRespondInput) =>
        sendCommand({
          type: "respondApproval",
          sessionId: input.sessionId,
          requestId: input.requestId,
          action: input.action,
          note: input.note
        })
    },
    events: {
      subscribe: async (input: EventSubscribeInput) =>
        preloadApi.subscribe(
          {
            subscriptionId: input.subscriptionId,
            fromCursor: input.fromCursor,
            filter: input.filter
          },
          (push) => {
            input.onPush?.(push);
            input.onEnvelope(push.envelope);
          }
        ),
      replay: async (input: EventReplayInput) => {
        const requestId = createId();
        const response = await preloadApi.request({
          id: requestId,
          method: "events.replay",
          params: {
            fromCursor: input.fromCursor,
            toCursor: input.toCursor,
            filter: input.filter
          }
        });
        if (response.method !== "events.replay") {
          throw new DesktopTransportError({
            method: "events.replay",
            code: "IPC_METHOD_MISMATCH",
            details: {
              expectedMethod: "events.replay",
              actualMethod: response.method
            },
            requestId
          });
        }
        if (!response.ok) {
          throw toTransportError("events.replay", requestId, response.error);
        }
        const result = response.result as Extract<
          WorkbenchRpcResponse,
          { method: "events.replay"; ok: true }
        >["result"];
        return {
          ...result,
          envelopes: result.envelopes ?? []
        };
      }
    }
  };
};
