import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type ContentBlock,
  type ContentChunk,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
  type ToolCallContent,
  type ToolCallStatus,
} from "@agentclientprotocol/sdk";
import type {
  AdapterRuntimePort,
  AcpRuntimeEvent,
  AcpRuntimeRequest,
  AcpRuntimeResponse,
  AgentAdapterRuntimeConfig,
  RuntimeLifecycleState,
  RuntimeOperationOptions,
  RuntimeStartOptions,
  RuntimeStateListener,
  RuntimeStopOptions
} from "@another-workbench/adapters";
import { createRuntimeLifecycleController } from "@another-workbench/adapters";
import type { Attachment } from "@another-workbench/shared";
import { buildAcpPromptContent } from "./attachment-inputs.js";

type RuntimeListener = (event: AcpRuntimeEvent) => void;

type BackingSession = {
  workbenchSessionId: string;
  acpSessionId: string;
  cwd: string;
};

type ToolState = {
  toolCallId: string;
  toolName: string;
  status: ToolCallStatus;
  contentText: string;
};

type TurnState = {
  sessionId: string;
  turnId: string;
  assistantMessageId?: string;
  acpMessageId?: string;
  toolsById: Map<string, ToolState>;
};

type PendingApproval = {
  requestId: string;
  sessionId: string;
  turnId: string;
  request: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
};

type PiAcpSelectedConfig = {
  cwd?: string;
};

export type PiAcpRuntimePortOptions = {
  engineId?: string;
  commandPath?: string;
  commandArgs?: string[];
  piCommandPath?: string;
  resolveConversationIdBySessionId?: (sessionId: string) => string | undefined;
  now?: () => string;
};

const defaultNpxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

const quoteForWindowsShell = (value: string): string =>
  /[\s"]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;

const resolveSpawnCommand = (
  commandPath: string,
  commandArgs: string[]
): {
  command: string;
  args: string[];
  shell?: boolean;
} => {
  if (process.platform !== "win32") {
    return {
      command: commandPath,
      args: commandArgs
    };
  }

  if (!/\.(cmd|bat)$/iu.test(commandPath)) {
    return {
      command: commandPath,
      args: commandArgs
    };
  }

  const shellCommand = [commandPath, ...commandArgs]
    .map((part) => quoteForWindowsShell(part))
    .join(" ");

  return {
    command: process.env.ComSpec?.trim() || "cmd.exe",
    args: ["/d", "/s", "/c", shellCommand]
  };
};

const resolveDefaultPiAcpCommand = (): {
  commandPath: string;
  commandArgs: string[];
} => {
  const explicitPath =
    process.env.AWB_PI_ACP_BIN?.trim() || process.env.PI_ACP_BIN?.trim();

  if (explicitPath) {
    return {
      commandPath: explicitPath,
      commandArgs: []
    };
  }

  return {
    commandPath: defaultNpxCommand,
    commandArgs: ["-y", "pi-acp"]
  };
};

const toRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const resolveSelectedConfig = (
  config: AgentAdapterRuntimeConfig
): PiAcpSelectedConfig | undefined => {
  const metadata = toRecord(config.metadata);
  const selectedConfig = toRecord(metadata?.selectedConfig);
  if (!selectedConfig) {
    return undefined;
  }
  return {
    cwd:
      typeof selectedConfig.cwd === "string" && selectedConfig.cwd.trim().length > 0
        ? selectedConfig.cwd
        : undefined
  };
};

const normalizePromptText = (content: string): string => content.trim();

const contentBlockToText = (content: ContentBlock): string => {
  switch (content.type) {
    case "text":
      return content.text;
    case "resource_link":
      return content.title ?? content.name ?? content.uri;
    case "resource": {
      const embedded = toRecord(content.resource);
      if (typeof embedded?.text === "string") {
        return embedded.text;
      }
      return JSON.stringify(content.resource);
    }
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
  }
  return "[content]";
};

const contentChunkText = (chunk: ContentChunk): string =>
  contentBlockToText(chunk.content);

const toolContentToText = (content: ToolCallContent): string => {
  switch (content.type) {
    case "content":
      return contentBlockToText(content.content);
    case "diff":
      return [
        `Updated ${content.path}`,
        content.oldText ? `- ${content.oldText}` : undefined,
        content.newText ? `+ ${content.newText}` : undefined
      ]
        .filter(Boolean)
        .join("\n");
    case "terminal":
      return "";
    default:
      return "";
  }
};

const toolContentsToText = (contents: ToolCallContent[] | null | undefined): string =>
  (contents ?? [])
    .map((content) => toolContentToText(content))
    .filter((value) => value.length > 0)
    .join("\n");

const diffText = (previous: string, next: string): string => {
  if (!next) {
    return "";
  }
  if (!previous) {
    return next;
  }
  if (next.startsWith(previous)) {
    return next.slice(previous.length);
  }
  return next;
};

const summarizeUnknown = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const mapStopReason = (
  reason: StopReason
): "completed" | "interrupted" | "failed" => {
  switch (reason) {
    case "cancelled":
      return "interrupted";
    case "refusal":
      return "failed";
    default:
      return "completed";
  }
};

const mapToolStatus = (
  status: ToolCallStatus | null | undefined
): "completed" | "failed" | "cancelled" | undefined => {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
    case "in_progress":
    default:
      return undefined;
  }
};

const preferredOptionId = (
  request: RequestPermissionRequest,
  action: "approve" | "deny" | "defer"
): RequestPermissionResponse => {
  if (action === "defer") {
    return {
      outcome: {
        outcome: "cancelled"
      }
    };
  }

  const preferredKinds =
    action === "approve"
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];

  for (const kind of preferredKinds) {
    const match = request.options.find((option) => option.kind === kind);
    if (match) {
      return {
        outcome: {
          outcome: "selected",
          optionId: match.optionId
        }
      };
    }
  }

  const fallback =
    action === "approve" ? request.options[0] : request.options.at(-1);

  if (!fallback) {
    return {
      outcome: {
        outcome: "cancelled"
      }
    };
  }

  return {
    outcome: {
      outcome: "selected",
      optionId: fallback.optionId
    }
  };
};

class PiAcpRuntimePort
  implements
    AdapterRuntimePort<AcpRuntimeRequest, AcpRuntimeResponse, AcpRuntimeEvent>
{
  private readonly engineId: string;
  private readonly commandPath: string;
  private readonly commandArgs: string[];
  private readonly piCommandPath: string | undefined;
  private readonly resolveConversationIdBySessionId:
    | ((sessionId: string) => string | undefined)
    | undefined;
  private readonly now: () => string;
  private readonly listeners = new Set<RuntimeListener>();
  private readonly lifecycle = createRuntimeLifecycleController();
  private readonly backingSessionByWorkbenchId = new Map<string, BackingSession>();
  private readonly workbenchSessionIdByAcpId = new Map<string, string>();
  private readonly turnStateBySessionId = new Map<string, TurnState>();
  private readonly pendingApprovalByRequestId = new Map<string, PendingApproval>();
  private process: ChildProcessWithoutNullStreams | undefined;
  private connection: ClientSideConnection | undefined;
  private startConfig: AgentAdapterRuntimeConfig = {};
  private sequence = 0;

  public constructor(options: PiAcpRuntimePortOptions = {}) {
    const resolvedCommand = resolveDefaultPiAcpCommand();
    this.engineId = options.engineId ?? "pi-acp";
    this.commandPath = options.commandPath ?? resolvedCommand.commandPath;
    this.commandArgs = options.commandArgs ?? resolvedCommand.commandArgs;
    this.piCommandPath =
      options.piCommandPath ??
      process.env.AWB_PI_BIN?.trim() ??
      process.env.PI_ACP_PI_COMMAND?.trim() ??
      process.env.PI_BIN?.trim();
    this.resolveConversationIdBySessionId =
      options.resolveConversationIdBySessionId;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public getState(): RuntimeLifecycleState {
    return this.lifecycle.getState();
  }

  public async start(
    config: AgentAdapterRuntimeConfig = {},
    _options: RuntimeStartOptions = {}
  ): Promise<void> {
    if (this.connection) {
      return;
    }

    this.lifecycle.setState("starting");
    this.startConfig = config;
    try {
      const spawnCommand = resolveSpawnCommand(this.commandPath, this.commandArgs);
      const child = spawn(spawnCommand.command, spawnCommand.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(config.env ?? {}),
          ...(this.piCommandPath ? { PI_ACP_PI_COMMAND: this.piCommandPath } : {})
        }
      });

      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", (error) => reject(error));
      });

      this.process = child;
      child.stderr.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : String(chunk);
        const trimmed = text.trim();
        if (!trimmed) {
          return;
        }
        this.emitEvent("runtime.error", {
          code: "PI_ACP_STDERR",
          message: trimmed,
          recoverable: true
        });
      });
      child.on("exit", (code, signal) => {
        this.process = undefined;
        this.connection = undefined;
        const state = this.lifecycle.getState();
        if (state !== "stopping" && state !== "stopped") {
          this.lifecycle.setState("failed");
        }
        this.emitEvent("runtime.error", {
          code: "PI_ACP_EXIT",
          message: `pi-acp exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          recoverable: false
        });
      });

      const client: Client = {
        requestPermission: async (request) => this.handlePermissionRequest(request),
        sessionUpdate: async (notification) => this.handleSessionUpdate(notification)
      };

      const input = Writable.toWeb(child.stdin);
      const output = Readable.toWeb(child.stdout);
      const stream = ndJsonStream(input, output);
      const connection = new ClientSideConnection(() => client, stream);

      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION
      });

      this.connection = connection;
      this.lifecycle.setState("ready");
      void connection.closed.then(() => {
        this.connection = undefined;
        const state = this.lifecycle.getState();
        if (state !== "stopping" && state !== "stopped") {
          this.lifecycle.setState("failed");
        }
      });
    } catch (error) {
      this.lifecycle.setState("failed");
      throw error;
    }
  }

  public async stop(_options: RuntimeStopOptions = {}): Promise<void> {
    this.lifecycle.setState("stopping");
    this.cancelPendingApprovalsForSession();
    this.backingSessionByWorkbenchId.clear();
    this.workbenchSessionIdByAcpId.clear();
    this.turnStateBySessionId.clear();
    this.pendingApprovalByRequestId.clear();

    const child = this.process;
    this.process = undefined;
    this.connection = undefined;
    if (!child) {
      this.lifecycle.setState("stopped");
      return;
    }
    child.kill();
    this.lifecycle.setState("stopped");
  }

  public async request(
    payload: AcpRuntimeRequest,
    _options: RuntimeOperationOptions = {}
  ): Promise<AcpRuntimeResponse> {
    switch (payload.method) {
      case "agent.initialize":
        return {
          id: payload.id,
          ok: true,
          result: {
            accepted: true
          }
        };
      case "turn.send":
        return this.handlePrompt(payload);
      case "turn.steer":
        return {
          id: payload.id,
          ok: false,
          error: {
            code: "ACP_STEER_UNSUPPORTED",
            message: "ACP runtime does not support turn steering."
          }
        };
      case "turn.interrupt":
        return this.handleCancel(payload);
      case "approval.respond":
        return this.handleApprovalResolution(payload);
      default:
        return {
          id: payload.id,
          ok: false,
          error: {
            code: "ACP_UNSUPPORTED_METHOD",
            message: `Unsupported ACP runtime method: ${payload.method}`
          }
        };
    }
  }

  public subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public subscribeState(listener: RuntimeStateListener): () => void {
    return this.lifecycle.subscribe(listener);
  }

  private async handlePrompt(
    payload: AcpRuntimeRequest
  ): Promise<AcpRuntimeResponse> {
    const sessionId = String(payload.params.sessionId ?? "");
    const content = String(payload.params.content ?? "");
    const attachments = Array.isArray(payload.params.attachments)
      ? (payload.params.attachments as Attachment[])
      : [];
    const cwd =
      typeof payload.params.cwd === "string" && payload.params.cwd.trim().length > 0
        ? payload.params.cwd
        : undefined;
    if (!sessionId) {
      return {
        id: payload.id,
        ok: false,
        error: {
          code: "ACP_BAD_PROMPT",
          message: "turn.send requires sessionId."
        }
      };
    }

    try {
      const backingSession = await this.ensureBackingSession(sessionId, cwd);
      const turnState: TurnState = {
        sessionId,
        turnId: `acp-turn-${randomUUID()}`,
        toolsById: new Map()
      };
      this.turnStateBySessionId.set(sessionId, turnState);
      this.emitSessionUpdated(sessionId, "running");
      this.emitEvent("turn.started", {
        sessionId,
        turnId: turnState.turnId
      });

      const response = await this.requireConnection().prompt({
        sessionId: backingSession.acpSessionId,
        prompt: buildAcpPromptContent(normalizePromptText(content), attachments)
      });

      this.completeTurn(turnState, response.stopReason);
      return {
        id: payload.id,
        ok: true,
        result: {
          accepted: true,
          stopReason: response.stopReason
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const turnState = this.turnStateBySessionId.get(sessionId);
      if (turnState) {
        this.emitEvent("runtime.error", {
          sessionId,
          turnId: turnState.turnId,
          code: "ACP_PROMPT_FAILED",
          message,
          recoverable: false
        });
        this.completeTurn(turnState, "refusal");
      } else {
        this.emitEvent("runtime.error", {
          sessionId,
          code: "ACP_PROMPT_FAILED",
          message,
          recoverable: false
        });
      }
      this.emitSessionUpdated(sessionId, "error");
      return {
        id: payload.id,
        ok: false,
        error: {
          code: "ACP_PROMPT_FAILED",
          message
        }
      };
    }
  }

  private async handleCancel(
    payload: AcpRuntimeRequest
  ): Promise<AcpRuntimeResponse> {
    const sessionId = String(payload.params.sessionId ?? "");
    const backingSession = this.backingSessionByWorkbenchId.get(sessionId);
    if (!backingSession) {
      return {
        id: payload.id,
        ok: false,
        error: {
          code: "ACP_UNKNOWN_SESSION",
          message: `Unknown ACP-backed session: ${sessionId}`
        }
      };
    }

    await this.requireConnection().cancel({
      sessionId: backingSession.acpSessionId
    });
    this.cancelPendingApprovalsForSession(sessionId);

    return {
      id: payload.id,
      ok: true,
      result: {
        accepted: true
      }
    };
  }

  private async handleApprovalResolution(
    payload: AcpRuntimeRequest
  ): Promise<AcpRuntimeResponse> {
    const sessionId = String(payload.params.sessionId ?? "");
    const requestId = String(payload.params.requestId ?? "");
    const action = String(payload.params.action ?? "defer") as
      | "approve"
      | "deny"
      | "defer";
    const pending = this.pendingApprovalByRequestId.get(requestId);

    if (!pending || pending.sessionId !== sessionId) {
      return {
        id: payload.id,
        ok: false,
        error: {
          code: "ACP_UNKNOWN_APPROVAL",
          message: `Unknown ACP approval request: ${requestId}`
        }
      };
    }

    this.pendingApprovalByRequestId.delete(requestId);
    pending.resolve(preferredOptionId(pending.request, action));
    this.emitEvent("approval.resolved", {
      sessionId: pending.sessionId,
      turnId: pending.turnId,
      requestId,
      action,
      engineId: this.engineId
    });
    this.emitSessionUpdated(
      pending.sessionId,
      action === "defer" ? "idle" : "running"
    );

    return {
      id: payload.id,
      ok: true,
      result: {
        accepted: true
      }
    };
  }

  private async ensureBackingSession(
    workbenchSessionId: string,
    cwdOverride?: string
  ): Promise<BackingSession> {
    const existing = this.backingSessionByWorkbenchId.get(workbenchSessionId);
    if (existing) {
      return existing;
    }

    const cwd = this.resolveSessionCwd(cwdOverride);
    const response = await this.requireConnection().newSession({
      cwd,
      mcpServers: []
    });

    const session: BackingSession = {
      workbenchSessionId,
      acpSessionId: response.sessionId,
      cwd
    };
    this.backingSessionByWorkbenchId.set(workbenchSessionId, session);
    this.workbenchSessionIdByAcpId.set(response.sessionId, workbenchSessionId);
    return session;
  }

  private resolveSessionCwd(cwdOverride?: string): string {
    const selectedConfig = resolveSelectedConfig(this.startConfig);
    return (
      cwdOverride ??
      selectedConfig?.cwd ??
      this.startConfig.cwd ??
      process.cwd()
    );
  }

  private async handlePermissionRequest(
    request: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const workbenchSessionId = this.workbenchSessionIdByAcpId.get(request.sessionId);
    if (!workbenchSessionId) {
      return {
        outcome: {
          outcome: "cancelled"
        }
      };
    }

    const turnState = this.turnStateBySessionId.get(workbenchSessionId);
    if (!turnState) {
      return {
        outcome: {
          outcome: "cancelled"
        }
      };
    }

    const requestId = `acp-approval-${randomUUID()}`;
    const details = [
      request.toolCall.title ? `Tool: ${request.toolCall.title}` : undefined,
      summarizeUnknown(request.toolCall.rawInput)
    ]
      .filter(Boolean)
      .join("\n\n");

    this.emitEvent("approval.requested", {
      sessionId: workbenchSessionId,
      turnId: turnState.turnId,
      requestId,
      approvalKind: "tool",
      title: request.toolCall.title ?? "Approve ACP tool call",
      details: details || undefined,
      engineId: this.engineId
    });
    this.emitSessionUpdated(workbenchSessionId, "awaiting_approval");

    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pendingApprovalByRequestId.set(requestId, {
        requestId,
        sessionId: workbenchSessionId,
        turnId: turnState.turnId,
        request,
        resolve: (response) => resolve(response)
      });
    });
  }

  private async handleSessionUpdate(
    notification: SessionNotification
  ): Promise<void> {
    const workbenchSessionId = this.workbenchSessionIdByAcpId.get(notification.sessionId);
    if (!workbenchSessionId) {
      return;
    }

    const turnState = this.turnStateBySessionId.get(workbenchSessionId);
    if (!turnState) {
      return;
    }

    this.applySessionUpdate(workbenchSessionId, turnState, notification.update);
  }

  private applySessionUpdate(
    sessionId: string,
    turnState: TurnState,
    update: SessionUpdate
  ): void {
    if (update.sessionUpdate !== "agent_message_chunk") {
      this.breakActiveAssistantMessage(sessionId, turnState);
    }

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.ingestAgentMessageChunk(sessionId, turnState, update);
        return;
      case "tool_call":
        this.ingestToolCall(sessionId, turnState, update);
        return;
      case "tool_call_update":
        this.ingestToolCallUpdate(sessionId, turnState, update);
        return;
      case "session_info_update":
        this.emitSessionUpdated(sessionId, "running", {
          title: update.title ?? undefined,
          updatedAt: update.updatedAt ?? undefined
        });
        return;
      default:
        return;
    }
  }

  private breakActiveAssistantMessage(
    sessionId: string,
    turnState: TurnState
  ): void {
    if (!turnState.assistantMessageId) {
      return;
    }

    this.emitEvent("message.completed", {
      sessionId,
      turnId: turnState.turnId,
      messageId: turnState.assistantMessageId,
      engineId: this.engineId
    });
    turnState.assistantMessageId = undefined;
    turnState.acpMessageId = undefined;
  }

  private ingestAgentMessageChunk(
    sessionId: string,
    turnState: TurnState,
    update: Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }>
  ): void {
    const acpMessageId =
      typeof update.messageId === "string" && update.messageId.length > 0
        ? update.messageId
        : undefined;
    if (!turnState.assistantMessageId || turnState.acpMessageId !== acpMessageId) {
      if (turnState.assistantMessageId) {
        this.emitEvent("message.completed", {
          sessionId,
          turnId: turnState.turnId,
          messageId: turnState.assistantMessageId,
          engineId: this.engineId
        });
      }

      turnState.acpMessageId = acpMessageId;
      turnState.assistantMessageId = `acp-message-${acpMessageId ?? randomUUID()}`;
      this.emitEvent("message.started", {
        sessionId,
        turnId: turnState.turnId,
        messageId: turnState.assistantMessageId,
        role: "assistant",
        engineId: this.engineId
      });
    }

    const delta = contentChunkText(update);
    if (!delta) {
      return;
    }

    this.emitEvent("message.delta", {
      sessionId,
      turnId: turnState.turnId,
      messageId: turnState.assistantMessageId,
      delta,
      engineId: this.engineId
    });
  }

  private ingestToolCall(
    sessionId: string,
    turnState: TurnState,
    update: Extract<SessionUpdate, { sessionUpdate: "tool_call" }>
  ): void {
    const existing = turnState.toolsById.get(update.toolCallId);
    const toolName = update.title || update.kind || "tool";
    const inputSummary = summarizeUnknown(update.rawInput);

    if (!existing) {
      turnState.toolsById.set(update.toolCallId, {
        toolCallId: update.toolCallId,
        toolName,
        status: update.status ?? "pending",
        contentText: toolContentsToText(update.content)
      });
      this.emitEvent("tool.started", {
        sessionId,
        turnId: turnState.turnId,
        toolCallId: update.toolCallId,
        toolName,
        inputSummary,
        engineId: this.engineId
      });
    }

    const contentText = toolContentsToText(update.content);
    if (contentText) {
      this.emitEvent("tool.delta", {
        sessionId,
        turnId: turnState.turnId,
        toolCallId: update.toolCallId,
        delta: contentText,
        engineId: this.engineId
      });
    }

    const completedStatus = mapToolStatus(update.status);
    if (completedStatus) {
      this.emitEvent("tool.completed", {
        sessionId,
        turnId: turnState.turnId,
        toolCallId: update.toolCallId,
        status: completedStatus,
        outputSummary:
          contentText || summarizeUnknown(update.rawOutput),
        engineId: this.engineId
      });
      turnState.toolsById.delete(update.toolCallId);
    }
  }

  private ingestToolCallUpdate(
    sessionId: string,
    turnState: TurnState,
    update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>
  ): void {
    const existing = turnState.toolsById.get(update.toolCallId);
    if (!existing) {
      turnState.toolsById.set(update.toolCallId, {
        toolCallId: update.toolCallId,
        toolName: update.title || update.kind || "tool",
        status: update.status ?? "pending",
        contentText: ""
      });
      this.emitEvent("tool.started", {
        sessionId,
        turnId: turnState.turnId,
        toolCallId: update.toolCallId,
        toolName: update.title || update.kind || "tool",
        inputSummary: summarizeUnknown(update.rawInput),
        engineId: this.engineId
      });
    }

    const current = turnState.toolsById.get(update.toolCallId)!;
    const nextText = toolContentsToText(update.content);
    const delta = diffText(current.contentText, nextText);
    if (delta) {
      this.emitEvent("tool.delta", {
        sessionId,
        turnId: turnState.turnId,
        toolCallId: update.toolCallId,
        delta,
        engineId: this.engineId
      });
      current.contentText = nextText;
    } else if (nextText) {
      current.contentText = nextText;
    }

    if (update.title) {
      current.toolName = update.title;
    }
    if (update.status) {
      current.status = update.status;
    }

    const completedStatus = mapToolStatus(update.status);
    if (completedStatus) {
      this.emitEvent("tool.completed", {
        sessionId,
        turnId: turnState.turnId,
        toolCallId: update.toolCallId,
        status: completedStatus,
        outputSummary:
          current.contentText || summarizeUnknown(update.rawOutput),
        engineId: this.engineId
      });
      turnState.toolsById.delete(update.toolCallId);
    }
  }

  private completeTurn(turnState: TurnState, stopReason: StopReason): void {
    this.breakActiveAssistantMessage(turnState.sessionId, turnState);

    const finishReason = mapStopReason(stopReason);
    if (finishReason !== "completed") {
      for (const toolState of turnState.toolsById.values()) {
        this.emitEvent("tool.completed", {
          sessionId: turnState.sessionId,
          turnId: turnState.turnId,
          toolCallId: toolState.toolCallId,
          status: finishReason === "interrupted" ? "cancelled" : "failed",
          outputSummary: toolState.contentText || undefined,
          engineId: this.engineId
        });
      }
    }

    this.emitEvent("turn.completed", {
      sessionId: turnState.sessionId,
      turnId: turnState.turnId,
      finishReason
    });

    this.emitSessionUpdated(
      turnState.sessionId,
      finishReason === "failed" ? "error" : "idle"
    );
    this.turnStateBySessionId.delete(turnState.sessionId);
  }

  private emitSessionUpdated(
    sessionId: string,
    status: "idle" | "running" | "awaiting_approval" | "error" | "completed",
    metadata?: Record<string, unknown>
  ): void {
    const conversationId = this.resolveConversationIdBySessionId?.(sessionId);
    if (!conversationId) {
      return;
    }
    this.emitEvent("session.updated", {
      conversationId,
      sessionId,
      status,
      metadata
    });
  }

  private cancelPendingApprovalsForSession(sessionId?: string): void {
    for (const [requestId, pending] of this.pendingApprovalByRequestId.entries()) {
      if (sessionId && pending.sessionId !== sessionId) {
        continue;
      }

      pending.resolve({
        outcome: {
          outcome: "cancelled"
        }
      });
      this.pendingApprovalByRequestId.delete(requestId);
      this.emitEvent("approval.resolved", {
        sessionId: pending.sessionId,
        turnId: pending.turnId,
        requestId,
        action: "defer",
        engineId: this.engineId
      });
    }
  }

  private requireConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new Error("pi-acp connection is not started.");
    }
    return this.connection;
  }

  private emitEvent(
    event: AcpRuntimeEvent["event"],
    payload: Record<string, unknown>
  ): void {
    this.sequence += 1;
    const runtimeEvent: AcpRuntimeEvent = {
      event,
      payload,
      eventId: `pi-acp-runtime-${this.sequence}`,
      cursor: String(this.sequence),
      occurredAt: this.now()
    };
    for (const listener of this.listeners) {
      listener(runtimeEvent);
    }
  }

}

export const createPiAcpRuntimePort = (
  options: PiAcpRuntimePortOptions = {}
): AdapterRuntimePort<AcpRuntimeRequest, AcpRuntimeResponse, AcpRuntimeEvent> =>
  new PiAcpRuntimePort(options);
