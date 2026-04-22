import type {
  AgentDescriptor,
  Attachment,
  BackgroundRunSnapshotRpc,
  CheckpointSnapshotRpc,
  ChatTreeSnapshotRpc,
  ChatSession,
  ChatInteractionCapabilitiesRpc,
  Command,
  DelegationSnapshotRpc,
  DiagnosticsSnapshotRpc,
  DomainSnapshot,
  EngineDefinitionRpc,
  EngineSurfaceRpc,
  CodexTurnChangesResultRpc,
  CodexTurnChangesUndoResultRpc,
  FileActionKindRpc,
  FileActionResultRpc,
  FilePreviewRpc,
  SkillDescriptorRpc,
  SessionActionDescriptorRpc,
  SessionActionKindRpc,
  SessionActionResultRpc,
  SessionWindowRpc,
  WorkspaceFileSearchResultRpc,
  WorkbenchClientApi,
  WorkbenchEventPush,
  WorkbenchEventSubscriptionFilter,
  WorkbenchSettingsRpc,
  WorktreeSnapshotRpc,
  WorkspaceBrowserNodeRpc,
  WorkspaceRecordRpc,
  WorkbenchRpcResponse
} from "@another-workbench/shared";
import { safeParseWorkbenchRpcResponse } from "@another-workbench/shared";
import { createTransportRpcHelper } from "./transport-rpc-helper.js";

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
  engineId: string;
  conversationId?: string;
  workspaceId?: string;
  sessionProfile?: {
    modeId?: string;
    modelId?: string;
  };
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

export type ChatSteerInput = {
  sessionId: string;
  turnId: string;
  content: string;
  messageId?: string;
  attachments?: Attachment[];
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
  engine: {
    list: () => Promise<EngineDefinitionRpc[]>;
    getSurface: (engineId: string) => Promise<EngineSurfaceRpc>;
  };
  agent: {
    list: () => Promise<AgentDescriptor[]>;
    select: (input: AgentSelectInput) => Promise<{ selectedAgentId: string }>;
  };
  settings: {
    get: () => Promise<WorkbenchSettingsRpc>;
    update: (input: {
      defaultNewSessionEngineId?: string;
    }) => Promise<WorkbenchSettingsRpc>;
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
      engineId: string;
      conversationId?: string;
      sessionProfile?: {
        modeId?: string;
        modelId?: string;
      };
      metadata?: Record<string, unknown>;
    }) => Promise<{ sessionId: string; conversationId: string }>;
    open: (sessionId: string) => Promise<{ page: SessionWindowRpc }>;
    loadOlder: (input: {
      sessionId: string;
      beforeTurnId?: string;
      limit?: number;
    }) => Promise<{ page: SessionWindowRpc }>;
    getActions: (
      sessionId: string
    ) => Promise<{ actions: SessionActionDescriptorRpc[] }>;
    runAction: (input: SessionBrowserActionInput) => Promise<SessionActionResultRpc>;
  };
  chat: {
    send: (input: ChatSendInput) => Promise<CommandReceipt>;
    steer: (input: ChatSteerInput) => Promise<CommandReceipt>;
    interrupt: (input: ChatInterruptInput) => Promise<CommandReceipt>;
    getCapabilities: (sessionId: string) => Promise<ChatInteractionCapabilitiesRpc>;
  };
  skills: {
    list: (input?: {
      cwds?: string[];
      forceReload?: boolean;
    }) => Promise<SkillDescriptorRpc[]>;
  };
  chatTree: {
    get: (sessionId: string) => Promise<ChatTreeSnapshotRpc>;
    jump: (input: {
      sessionId: string;
      nodeId: string;
    }) => Promise<{ jumped: boolean }>;
  };
  delegation: {
    get: (sessionId: string) => Promise<DelegationSnapshotRpc>;
  };
  worktree: {
    get: (sessionId: string) => Promise<WorktreeSnapshotRpc>;
  };
  checkpoint: {
    get: (sessionId: string) => Promise<CheckpointSnapshotRpc>;
  };
  diagnostics: {
    get: (sessionId: string) => Promise<DiagnosticsSnapshotRpc>;
  };
  backgroundRun: {
    get: (sessionId: string) => Promise<BackgroundRunSnapshotRpc>;
  };
  file: {
    searchWorkspace: (input: {
      workspaceId: string;
      query: string;
      limit?: number;
    }) => Promise<WorkspaceFileSearchResultRpc[]>;
    getPreview: (path: string) => Promise<FilePreviewRpc>;
    runAction: (input: {
      path: string;
      action: FileActionKindRpc;
    }) => Promise<FileActionResultRpc>;
  };
  codex: {
    getTurnChanges: (input: {
      sessionId: string;
      turnId: string;
    }) => Promise<CodexTurnChangesResultRpc>;
    undoTurnChanges: (input: {
      sessionId: string;
      turnId: string;
    }) => Promise<CodexTurnChangesUndoResultRpc>;
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
  const rpc = createTransportRpcHelper(
    preloadApi,
    createId,
    (input) => new DesktopTransportError(input)
  );

  const requestAgentList = async (): Promise<AgentDescriptor[]> => {
    const result = await rpc.request("agent.list", {});
    return result.agents;
  };

  const requestEngineList = async (): Promise<EngineDefinitionRpc[]> => {
    const result = await rpc.request("engine.list", {});
    return result.engines;
  };

  const requestEngineSurface = async (
    engineId: string
  ): Promise<EngineSurfaceRpc> => {
    const result = await rpc.request("engine.getSurface", {
      engineId
    });
    return result.surface;
  };

  const requestAgentSelect = async (
    input: AgentSelectInput
  ): Promise<{ selectedAgentId: string }> => {
    return rpc.request("agent.select", {
      agentId: input.agentId,
      config: input.config
    });
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

  const requestSettingsGet = async (): Promise<WorkbenchSettingsRpc> => {
    return rpc.request("settings.get", {});
  };

  const requestSettingsUpdate = async (input: {
    defaultNewSessionEngineId?: string;
  }): Promise<WorkbenchSettingsRpc> => {
    return rpc.request("settings.update", input);
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
    const result = await rpc.request("session.list", {
      conversationId: input.conversationId,
      includeArchived: input.includeArchived ?? false
    });
    return result.sessions;
  };

  const requestWorkspaceList = async () => {
    return rpc.request("workspace.list", {});
  };

  const requestWorkspaceAdd = async (
    input: WorkspaceAddInput
  ): Promise<WorkspaceRecordRpc> => {
    const result = await rpc.request("workspace.add", input);
    return result.workspace;
  };

  const requestWorkspacePickDirectory = async (): Promise<{
    canceled: boolean;
    rootPath?: string;
  }> => {
    return rpc.request("workspace.pickDirectory", {});
  };

  const requestWorkspaceRemove = async (
    input: WorkspaceRemoveInput
  ): Promise<{ workspaceId: string; removed: boolean }> => {
    return rpc.request("workspace.remove", {
      workspaceId: input.workspaceId
    });
  };

  const requestSessionTree = async (workspaceId?: string): Promise<{
    workspaces: WorkspaceBrowserNodeRpc[];
  }> => {
    return rpc.request("sessionBrowser.listTree", {
      workspaceId
    });
  };

  return {
    engine: {
      list: requestEngineList,
      getSurface: requestEngineSurface
    },
    agent: {
      list: requestAgentList,
      select: requestAgentSelect
    },
    settings: {
      get: requestSettingsGet,
      update: requestSettingsUpdate
    },
    domain: {
      snapshot: requestDomainSnapshot
    },
    session: {
      create: (input: SessionCreateInput) =>
        sendCommand({
          type: "createSession",
          engineId: input.engineId,
          conversationId: input.conversationId,
          workspaceId: input.workspaceId,
          sessionProfile: input.sessionProfile,
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
      toggleExpanded: (workspaceId: string) =>
        rpc.request("workspace.toggleExpanded", {
          workspaceId
        }),
      select: (workspaceId: string) =>
        rpc.request("workspace.select", {
          workspaceId
        })
    },
    sessionBrowser: {
      listTree: requestSessionTree,
      reconcile: (workspaceId?: string) =>
        rpc.request("sessionBrowser.reconcile", {
          workspaceId
        }),
      toggleExpanded: (sessionId: string) =>
        rpc.request("sessionBrowser.toggleExpanded", {
          sessionId
        }),
      create: (input) => rpc.request("sessionBrowser.create", input),
      open: (sessionId: string) =>
        rpc.request("sessionBrowser.open", {
          sessionId
        }),
      loadOlder: (input) => rpc.request("sessionBrowser.loadOlder", input),
      getActions: (sessionId: string) =>
        rpc.request("sessionBrowser.getActions", {
          sessionId
        }),
      runAction: (input: SessionBrowserActionInput) =>
        rpc.request("sessionBrowser.runAction", input) as Promise<SessionActionResultRpc>
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
      steer: (input: ChatSteerInput) =>
        sendCommand({
          type: "steerTurn",
          sessionId: input.sessionId,
          turnId: input.turnId,
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
        }),
      getCapabilities: async (sessionId: string) => {
        const result = await rpc.request("chat.getCapabilities", {
          sessionId
        });
        return result.capabilities;
      }
    },
    skills: {
      list: async (input) => {
        const result = await rpc.request("skills.list", {
          cwds: input?.cwds,
          forceReload: input?.forceReload
        });
        return result.skills;
      }
    },
    chatTree: {
      get: async (sessionId: string) => {
        const result = await rpc.request("chatTree.get", {
          sessionId
        });
        return result.chatTree;
      },
      jump: (input: { sessionId: string; nodeId: string }) =>
        rpc.request("chatTree.jump", input)
    },
    delegation: {
      get: async (sessionId: string) => {
        const result = await rpc.request("delegation.get", {
          sessionId
        });
        return result.delegation;
      }
    },
    worktree: {
      get: async (sessionId: string) => {
        const result = await rpc.request("worktree.get", {
          sessionId
        });
        return result.worktree;
      }
    },
    checkpoint: {
      get: async (sessionId: string) => {
        const result = await rpc.request("checkpoint.get", {
          sessionId
        });
        return result.checkpoint;
      }
    },
    diagnostics: {
      get: async (sessionId: string) => {
        const result = await rpc.request("diagnostics.get", {
          sessionId
        });
        return result.diagnostics;
      }
    },
    backgroundRun: {
      get: async (sessionId: string) => {
        const result = await rpc.request("backgroundRun.get", {
          sessionId
        });
        return result.backgroundRun;
      }
    },
    file: {
      searchWorkspace: async (input) => {
        const result = await rpc.request("file.searchWorkspace", input);
        return result.results;
      },
      getPreview: async (path: string) => {
        const result = await rpc.request("file.getPreview", {
          path
        });
        return result.preview;
      },
      runAction: async (input) => {
        const result = await rpc.request("file.runAction", input);
        return result.result;
      }
    },
    codex: {
      getTurnChanges: async (input) => {
        return rpc.request("codex.turnChanges.get", input);
      },
      undoTurnChanges: async (input) => {
        return rpc.request("codex.turnChanges.undo", input);
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
        const result = await rpc.request("events.replay", {
          fromCursor: input.fromCursor,
          toCursor: input.toCursor,
          filter: input.filter
        });
        return {
          ...result,
          envelopes: result.envelopes ?? []
        };
      }
    }
  };
};
