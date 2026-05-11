import type {
  Attachment,
  BackgroundRunSnapshotRpc,
  CheckpointSnapshotRpc,
  ChatTreeSnapshotRpc,
  ChatSession,
  ChatInteractionCapabilitiesRpc,
  Command,
  DelegationSnapshotRpc,
  DiagnosticsWriteInputRpc,
  DiagnosticsWriteResultRpc,
  DiagnosticsSnapshotRpc,
  DomainSnapshot,
  EngineDefinitionRpc,
  EngineSurfaceRpc,
  ErrorLogWriteInputRpc,
  ErrorLogWriteResultRpc,
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
  TakeoverPresetDocumentRpc,
  TakeoverPresetSummaryRpc,
  TakeoverSessionStateRpc,
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

export type EngineSelectInput = {
  engineId: string;
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
    const detailMessage =
      typeof input.details?.message === "string" && input.details.message.length > 0
        ? `: ${input.details.message}`
        : "";
    super(`[${input.method}] ${input.code}${detailMessage}`);
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
    select: (input: EngineSelectInput) => Promise<{ selectedEngineId: string }>;
  };
  settings: {
    get: () => Promise<WorkbenchSettingsRpc>;
    update: (input: {
      defaultNewSessionEngineId?: string;
    }) => Promise<WorkbenchSettingsRpc>;
  };
  takeoverPresets: {
    list: () => Promise<{
      rootPath: string;
      presets: TakeoverPresetSummaryRpc[];
    }>;
    read: (presetId: string) => Promise<TakeoverPresetDocumentRpc>;
    upsert: (input: {
      presetId: string;
      prompt: string;
      displayName?: string;
    }) => Promise<TakeoverPresetDocumentRpc>;
    delete: (presetId: string) => Promise<{
      presetId: string;
      deleted: boolean;
    }>;
  };
  takeover: {
    getState: (sessionId: string) => Promise<TakeoverSessionStateRpc>;
    setManual: (input: {
      sessionId: string;
      presetId?: string;
      context?: string;
    }) => Promise<TakeoverSessionStateRpc>;
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
    activate: (sessionId: string) => Promise<{ sessionId: string }>;
    loadOlder: (input: {
      sessionId: string;
      beforeTurnId?: string;
      cursor?: string;
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
      expectedRevision?: number;
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
    write: (input: DiagnosticsWriteInputRpc) => Promise<DiagnosticsWriteResultRpc>;
  };
  backgroundRun: {
    get: (sessionId: string) => Promise<BackgroundRunSnapshotRpc>;
  };
  errorLog: {
    write: (input: ErrorLogWriteInputRpc) => Promise<ErrorLogWriteResultRpc>;
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
  const writeDiagnosticDirect = async (
    input: DiagnosticsWriteInputRpc
  ): Promise<DiagnosticsWriteResultRpc | undefined> => {
    const response = await preloadApi.request({
      id: createId(),
      method: "diagnostics.write",
      params: input
    });
    if (response.method === "diagnostics.write" && response.ok) {
      return response.result;
    }
    return undefined;
  };
  const writeDiagnosticBestEffort = (input: DiagnosticsWriteInputRpc): void => {
    void writeDiagnosticDirect(input).catch(() => undefined);
  };
  const eventPushStats = {
    count: 0,
    firstAt: "",
    lastAt: "",
    lastCursor: undefined as string | undefined,
    byType: {} as Record<string, number>
  };
  const flushEventPushStats = (reason: "interval" | "threshold" | "unsubscribe"): void => {
    if (eventPushStats.count === 0) {
      return;
    }
    const count = eventPushStats.count;
    const firstAt = eventPushStats.firstAt;
    const lastAt = eventPushStats.lastAt;
    const lastCursor = eventPushStats.lastCursor;
    const byType = eventPushStats.byType;
    eventPushStats.count = 0;
    eventPushStats.firstAt = "";
    eventPushStats.lastAt = "";
    eventPushStats.lastCursor = undefined;
    eventPushStats.byType = {};
    writeDiagnosticBestEffort({
      kind: "event-push-batch",
      severity: count >= 100 ? "warning" : "info",
      source: "desktop-transport",
      message: "Workbench event push batch.",
      occurredAt: lastAt || now(),
      cursor: lastCursor,
      metrics: {
        count,
        typeCount: Object.keys(byType).length
      },
      context: {
        reason,
        firstAt,
        lastAt,
        byType
      }
    });
  };
  const rpc = createTransportRpcHelper(
    preloadApi,
    createId,
    (input) => new DesktopTransportError(input),
    {
      now,
      onRequestSettled: (timing) => {
        if (timing.ok && timing.durationMs < 250) {
          return;
        }
        writeDiagnosticBestEffort({
          kind: "ipc-request",
          severity: timing.ok ? (timing.durationMs >= 1_000 ? "warning" : "info") : "error",
          source: "desktop-transport",
          message: `Workbench RPC ${timing.ok ? "completed" : "failed"}: ${timing.method}`,
          occurredAt: timing.completedAt,
          requestId: timing.requestId,
          metrics: {
            durationMs: timing.durationMs,
            paramsBytes: timing.paramsBytes,
            responseBytes: timing.responseBytes
          },
          context: {
            method: timing.method,
            startedAt: timing.startedAt,
            completedAt: timing.completedAt,
            ok: timing.ok,
            code: timing.code
          }
        });
      }
    }
  );

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

  const requestEngineSelect = async (
    input: EngineSelectInput
  ): Promise<{ selectedEngineId: string }> => {
    return rpc.request("engine.select", {
      engineId: input.engineId,
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

  const requestTakeoverPresetsList = async (): Promise<{
    rootPath: string;
    presets: TakeoverPresetSummaryRpc[];
  }> => {
    return rpc.request("takeoverPresets.list", {});
  };

  const requestTakeoverPresetRead = async (
    presetId: string
  ): Promise<TakeoverPresetDocumentRpc> => {
    const result = await rpc.request("takeoverPresets.read", { presetId });
    return result.preset;
  };

  const requestTakeoverPresetUpsert = async (input: {
    presetId: string;
    prompt: string;
    displayName?: string;
  }): Promise<TakeoverPresetDocumentRpc> => {
    const result = await rpc.request("takeoverPresets.upsert", input);
    return result.preset;
  };

  const requestTakeoverPresetDelete = async (
    presetId: string
  ): Promise<{ presetId: string; deleted: boolean }> => {
    return rpc.request("takeoverPresets.delete", { presetId });
  };

  const requestTakeoverState = async (
    sessionId: string
  ): Promise<TakeoverSessionStateRpc> => {
    const result = await rpc.request("takeover.getState", { sessionId });
    return result.state;
  };

  const requestTakeoverSetManual = async (input: {
    sessionId: string;
    presetId?: string;
    context?: string;
  }): Promise<TakeoverSessionStateRpc> => {
    const result = await rpc.request("takeover.setManual", input);
    return result.state;
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
      getSurface: requestEngineSurface,
      select: requestEngineSelect
    },
    settings: {
      get: requestSettingsGet,
      update: requestSettingsUpdate
    },
    takeoverPresets: {
      list: requestTakeoverPresetsList,
      read: requestTakeoverPresetRead,
      upsert: requestTakeoverPresetUpsert,
      delete: requestTakeoverPresetDelete
    },
    takeover: {
      getState: requestTakeoverState,
      setManual: requestTakeoverSetManual
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
      activate: (sessionId: string) =>
        rpc.request("sessionBrowser.activate", {
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
      jump: (input: { sessionId: string; nodeId: string; expectedRevision?: number }) =>
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
      },
      write: async (input: DiagnosticsWriteInputRpc) => {
        const result = await writeDiagnosticDirect(input);
        if (!result) {
          throw new DesktopTransportError({
            method: "diagnostics.write",
            code: "DIAGNOSTIC_LOG_FAILED",
            requestId: input.requestId ?? createId()
          });
        }
        return result;
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
    errorLog: {
      write: (input: ErrorLogWriteInputRpc) =>
        rpc.request("errorLog.write", input)
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
      subscribe: async (input: EventSubscribeInput) => {
        const flushIntervalId = globalThis.setInterval(
          () => flushEventPushStats("interval"),
          5_000
        );
        const subscription = await preloadApi.subscribe(
          {
            subscriptionId: input.subscriptionId,
            fromCursor: input.fromCursor,
            filter: input.filter
          },
          (push) => {
            const receivedAt = now();
            eventPushStats.count += 1;
            eventPushStats.firstAt = eventPushStats.firstAt || receivedAt;
            eventPushStats.lastAt = receivedAt;
            eventPushStats.lastCursor = push.envelope.cursor ?? eventPushStats.lastCursor;
            const eventType = push.envelope.event.type;
            eventPushStats.byType[eventType] = (eventPushStats.byType[eventType] ?? 0) + 1;
            if (eventPushStats.count >= 100) {
              flushEventPushStats("threshold");
            }
            input.onPush?.(push);
            input.onEnvelope(push.envelope);
          }
        );
        return {
          subscriptionId: subscription.subscriptionId,
          unsubscribe: async () => {
            globalThis.clearInterval(flushIntervalId);
            flushEventPushStats("unsubscribe");
            await subscription.unsubscribe();
          }
        };
      },
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
