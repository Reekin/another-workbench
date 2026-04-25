import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import type { AdapterRuntimePort } from "@another-workbench/adapters";
import type {
  CodexRuntimeEvent,
  CodexRuntimeRequest,
  CodexRuntimeResponse
} from "@another-workbench/adapters";
import type { AgentAdapterRuntimeConfig } from "@another-workbench/adapters";
import type { Attachment, EventType } from "@another-workbench/shared";
import type { GetAuthStatusParams } from "./codex-app-server-generated/GetAuthStatusParams.js";
import type { GetAuthStatusResponse } from "./codex-app-server-generated/GetAuthStatusResponse.js";
import type { GitDiffToRemoteParams } from "./codex-app-server-generated/GitDiffToRemoteParams.js";
import type { GitDiffToRemoteResponse } from "./codex-app-server-generated/GitDiffToRemoteResponse.js";
import type { AskForApproval } from "./codex-app-server-generated/v2/AskForApproval.js";
import type { SandboxMode } from "./codex-app-server-generated/v2/SandboxMode.js";
import type { ReasoningEffort } from "./codex-app-server-generated/ReasoningEffort.js";
import type { ServiceTier } from "./codex-app-server-generated/ServiceTier.js";
import type { ThreadStartResponse } from "./codex-app-server-generated/v2/ThreadStartResponse.js";
import type { Thread } from "./codex-app-server-generated/v2/Thread.js";
import type { ThreadArchiveParams } from "./codex-app-server-generated/v2/ThreadArchiveParams.js";
import type { ThreadChatTreeReadParams } from "./codex-app-server-generated/v2/ThreadChatTreeReadParams.js";
import type { ThreadChatTreeReadResponse } from "./codex-app-server-generated/v2/ThreadChatTreeReadResponse.js";
import type { ThreadChatTreeSetCurrentParams } from "./codex-app-server-generated/v2/ThreadChatTreeSetCurrentParams.js";
import type { ThreadListParams } from "./codex-app-server-generated/v2/ThreadListParams.js";
import type { ThreadListResponse } from "./codex-app-server-generated/v2/ThreadListResponse.js";
import type { ThreadReadParams } from "./codex-app-server-generated/v2/ThreadReadParams.js";
import type { ThreadReadResponse } from "./codex-app-server-generated/v2/ThreadReadResponse.js";
import type { ThreadResumeParams } from "./codex-app-server-generated/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "./codex-app-server-generated/v2/ThreadResumeResponse.js";
import type { TurnSteerParams } from "./codex-app-server-generated/v2/TurnSteerParams.js";
import type { TurnStartResponse } from "./codex-app-server-generated/v2/TurnStartResponse.js";
import type { ThreadItem } from "./codex-app-server-generated/v2/ThreadItem.js";
import type { SkillsListParams } from "./codex-app-server-generated/v2/SkillsListParams.js";
import type { SkillsListResponse } from "./codex-app-server-generated/v2/SkillsListResponse.js";
import { buildCodexTurnInput } from "./attachment-inputs.js";
import {
  type RecordedCodexTurnChanges,
  getRecordedCodexTurnChanges,
  recordCodexTurnChangesFromFileUpdate,
  recordCodexTurnChangesFromUnifiedDiff
} from "./engine-extensions/codex/turn-changes-store.js";

type RuntimeListener = (event: CodexRuntimeEvent) => void;

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type JsonRpcPayload = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code?: string | number;
    message?: string;
    data?: Record<string, unknown>;
  };
};

type PendingApproval = {
  requestId: string;
  rawRequestId: string | number;
  sessionId: string;
  turnId: string;
  itemId: string;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/permissions/requestApproval";
  title: string;
  details?: string;
  availableDecisions?: string[];
};

type PendingApprovalResolution = {
  action: "approve" | "deny" | "defer";
};

type CodexSelectedConfig = {
  model?: string;
  modelProvider?: string;
  approvalPolicy?: AskForApproval;
  sandbox?: SandboxMode;
  cwd?: string;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: ServiceTier;
};

export type CodexAppServerRuntimePortOptions = {
  engineId?: string;
  commandPath?: string;
  commandArgs?: string[];
  resolveConversationIdBySessionId?: (sessionId: string) => string | undefined;
  recordTurnChanges?: (input: RecordedCodexTurnChanges) => void;
  now?: () => string;
};

const resolveDefaultCodexCommandPath = (): string => {
  const envCandidates = [
    process.env.AWB_CODEX_BIN,
    process.env.CODEX_BIN,
    process.env.CODEX_PATH
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));

  for (const candidate of envCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const localCandidates = [
    "I:/codex-branch/codex.exe",
    "I:/codex-branch/codex/codex.exe"
  ];
  for (const candidate of localCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return process.platform === "win32" ? "codex.exe" : "codex";
};

const localRequestId = (value: string | number): string => String(value);

const chunkText = (value: string): string[] => {
  if (!value) {
    return [];
  }
  return value.split(/(?<=\n)/g).filter((chunk) => chunk.length > 0);
};

const mapFinishReason = (
  status: string | undefined
): "completed" | "interrupted" | "failed" => {
  switch (status) {
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "completed";
  }
};

const mapSessionStatus = (
  status: Record<string, unknown> | undefined
): "idle" | "running" | "awaiting_approval" | "error" | "completed" => {
  if (!status || typeof status.type !== "string") {
    return "idle";
  }

  switch (status.type) {
    case "active":
      return "running";
    case "systemError":
      return "error";
    case "idle":
      return "idle";
    default:
      return "idle";
  }
};

const resolveApprovalDecision = (
  approval: PendingApproval,
  action: "approve" | "deny" | "defer"
): string => {
  const available = new Set(approval.availableDecisions ?? []);

  if (action === "approve") {
    if (available.has("accept")) {
      return "accept";
    }
    if (available.has("acceptForSession")) {
      return "acceptForSession";
    }
    return "accept";
  }

  if (action === "deny") {
    if (available.has("decline")) {
      return "decline";
    }
    if (available.has("cancel")) {
      return "cancel";
    }
    return "decline";
  }

  return "cancel";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isTextThreadItem = (
  item: ThreadItem | Record<string, unknown>
): item is Extract<ThreadItem, { type: "agentMessage" }> =>
  isRecord(item) && item.type === "agentMessage" && typeof item.id === "string";

const isFinalAnswerMessageItem = (
  item: Extract<ThreadItem, { type: "agentMessage" }>
): boolean => item.phase === "final_answer";

const isCommandExecutionThreadItem = (
  item: ThreadItem | Record<string, unknown>
): item is Extract<ThreadItem, { type: "commandExecution" }> =>
  isRecord(item) && item.type === "commandExecution" && typeof item.id === "string";

const isFileChangeThreadItem = (
  item: ThreadItem | Record<string, unknown>
): item is Extract<ThreadItem, { type: "fileChange" }> =>
  isRecord(item) && item.type === "fileChange" && typeof item.id === "string";

const isCollabAgentToolCallThreadItem = (
  item: ThreadItem | Record<string, unknown>
): item is Extract<ThreadItem, { type: "collabAgentToolCall" }> =>
  isRecord(item) && item.type === "collabAgentToolCall" && typeof item.id === "string";

const discoveredCodexSessionId = (threadId: string): string => `codex-thread:${threadId}`;

const mapCollabToolLabel = (
  tool: Extract<ThreadItem, { type: "collabAgentToolCall" }>["tool"]
): string => {
  switch (tool) {
    case "spawnAgent":
      return "subagent.spawn";
    case "sendInput":
      return "subagent.message";
    case "resumeAgent":
      return "subagent.resume";
    case "wait":
      return "subagent.wait";
    case "closeAgent":
      return "subagent.close";
    default:
      return `subagent.${tool}`;
  }
};

const mapCollabAgentStatus = (
  status: string | undefined
): "idle" | "running" | "awaiting_approval" | "error" | "completed" => {
  switch (status) {
    case "pendingInit":
    case "running":
      return "running";
    case "completed":
    case "shutdown":
      return "completed";
    case "errored":
      return "error";
    case "interrupted":
    case "notFound":
    default:
      return "idle";
  }
};

const summarizeCollabInput = (
  item: Extract<ThreadItem, { type: "collabAgentToolCall" }>
): string | undefined => {
  const parts = [
    item.prompt?.trim(),
    item.model ? `model: ${item.model}` : undefined,
    item.reasoningEffort ? `reasoning: ${item.reasoningEffort}` : undefined,
    item.receiverThreadIds.length > 0
      ? `targets: ${item.receiverThreadIds.join(", ")}`
      : undefined
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join("\n") : undefined;
};

const summarizeCollabOutput = (
  item: Extract<ThreadItem, { type: "collabAgentToolCall" }>
): string | undefined => {
  const lines = item.receiverThreadIds.map((threadId) => {
    const state = item.agentsStates[threadId];
    if (!state) {
      return `${threadId}: unknown`;
    }
    return state.message?.trim()
      ? `${threadId}: ${state.status} — ${state.message.trim()}`
      : `${threadId}: ${state.status}`;
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
};

export class CodexAppServerRuntimePort
  implements
    AdapterRuntimePort<CodexRuntimeRequest, CodexRuntimeResponse, CodexRuntimeEvent>
{
  private readonly engineId: string;
  private readonly commandPath: string;
  private readonly commandArgs: string[];
  private readonly resolveConversationIdBySessionId:
    | ((sessionId: string) => string | undefined)
    | undefined;
  private readonly now: () => string;
  private readonly listeners = new Set<RuntimeListener>();
  private readonly pendingRpcById = new Map<string, PendingRpc>();
  private readonly threadIdBySessionId = new Map<string, string>();
  private readonly sessionIdByThreadId = new Map<string, string>();
  private readonly pendingApprovalsById = new Map<string, PendingApproval>();
  private readonly pendingApprovalResolutionsById = new Map<
    string,
    PendingApprovalResolution
  >();
  private process: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private sequence = 0;
  private requestCounter = 0;
  private startConfig: AgentAdapterRuntimeConfig = {};
  private readonly recordTurnChanges: ((input: RecordedCodexTurnChanges) => void) | undefined;

  public constructor(options: CodexAppServerRuntimePortOptions = {}) {
    this.engineId = options.engineId ?? "codex";
    this.commandPath = options.commandPath ?? resolveDefaultCodexCommandPath();
    this.commandArgs = options.commandArgs ?? ["app-server"];
    this.resolveConversationIdBySessionId =
      options.resolveConversationIdBySessionId;
    this.recordTurnChanges = options.recordTurnChanges;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async start(config: AgentAdapterRuntimeConfig = {}): Promise<void> {
    if (this.process) {
      return;
    }

    this.startConfig = config;
    const child = spawn(this.commandPath, this.commandArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(config.env ?? {})
      }
    });

    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      this.consumeStdout(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      const trimmed = chunk.trim();
      if (!trimmed) {
        return;
      }
      this.emitEvent("runtime.error", {
        code: "CODEX_APP_SERVER_STDERR",
        message: trimmed,
        recoverable: true
      });
    });
    child.on("exit", (code, signal) => {
      this.process = undefined;
      this.emitEvent("runtime.error", {
        code: "CODEX_APP_SERVER_EXIT",
        message: `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        recoverable: false
      });
      for (const pending of this.pendingRpcById.values()) {
        pending.reject(new Error("codex app-server exited before responding."));
      }
      this.pendingRpcById.clear();
    });

    await this.rpc("initialize", {
      clientInfo: {
        name: "another-workbench",
        title: "Another Workbench",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.write({
      method: "initialized"
    });
  }

  public async stop(): Promise<void> {
    this.pendingRpcById.clear();
    this.pendingApprovalsById.clear();
    this.pendingApprovalResolutionsById.clear();
    this.threadIdBySessionId.clear();
    this.sessionIdByThreadId.clear();

    const child = this.process;
    this.process = undefined;
    if (!child) {
      return;
    }
    child.kill();
  }

  public async request(payload: CodexRuntimeRequest): Promise<CodexRuntimeResponse> {
    switch (payload.method) {
      case "initialize":
        return {
          id: payload.id,
          ok: true,
          result: {
            accepted: true
          }
        };
      case "turn/start":
        await this.handleTurnStart(payload);
        return {
          id: payload.id,
          ok: true,
          result: {
            accepted: true
          }
        };
      case "turn/steer":
        await this.handleTurnSteer(payload);
        return {
          id: payload.id,
          ok: true,
          result: {
            accepted: true
          }
        };
      case "turn/interrupt":
        await this.handleTurnInterrupt(payload);
        return {
          id: payload.id,
          ok: true,
          result: {
            accepted: true
          }
        };
      case "approval/respond":
        await this.handleApprovalResponse(payload);
        return {
          id: payload.id,
          ok: true,
          result: {
            accepted: true
          }
        };
      default:
        return {
          id: payload.id,
          ok: true,
          result: {
            accepted: true
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

  public getThreadIdForSession(sessionId: string): string | undefined {
    return this.threadIdBySessionId.get(sessionId);
  }

  public attachThreadToSession(sessionId: string, threadId: string): void {
    const previousThreadId = this.threadIdBySessionId.get(sessionId);
    if (previousThreadId && previousThreadId !== threadId) {
      this.sessionIdByThreadId.delete(previousThreadId);
    }
    this.threadIdBySessionId.set(sessionId, threadId);
    this.sessionIdByThreadId.set(threadId, sessionId);
  }

  public async listThreads(
    params: Partial<ThreadListParams> = {}
  ): Promise<ThreadListResponse> {
    await this.start(this.startConfig);
    return (await this.rpc("thread/list", {
      cursor: params.cursor ?? null,
      limit: params.limit ?? null,
      sortKey: params.sortKey ?? null,
      modelProviders: params.modelProviders ?? null,
      sourceKinds: params.sourceKinds ?? null,
      archived: params.archived ?? null,
      cwd: params.cwd ?? null,
      searchTerm: params.searchTerm ?? null
    })) as ThreadListResponse;
  }

  public async readThread(
    threadId: string,
    includeTurns = false
  ): Promise<Thread> {
    await this.start(this.startConfig);
    const result = (await this.rpc("thread/read", {
      threadId,
      includeTurns
    } satisfies ThreadReadParams)) as ThreadReadResponse;
    return result.thread;
  }

  public async resumeThread(threadId: string): Promise<Thread> {
    await this.start(this.startConfig);
    const selected = this.resolveSelectedConfig();
    const result = (await this.rpc("thread/resume", {
      threadId,
      persistExtendedHistory: true,
      cwd: selected.cwd ?? this.startConfig.cwd ?? null,
      model: selected.model ?? null,
      modelProvider: selected.modelProvider ?? null,
      serviceTier: selected.serviceTier ?? null,
      approvalPolicy: selected.approvalPolicy ?? null,
      sandbox: selected.sandbox ?? null
    } satisfies ThreadResumeParams)) as ThreadResumeResponse;
    return result.thread;
  }

  public async readChatTree(threadId: string): Promise<ThreadChatTreeReadResponse> {
    await this.start(this.startConfig);
    return (await this.rpc("thread/chatTree/read", {
      threadId
    } satisfies ThreadChatTreeReadParams)) as ThreadChatTreeReadResponse;
  }

  public async readChatTreeForSession(
    sessionId: string
  ): Promise<ThreadChatTreeReadResponse | undefined> {
    const threadId = this.threadIdBySessionId.get(sessionId);
    if (!threadId) {
      return undefined;
    }
    return this.readChatTree(threadId);
  }

  public async setCurrentChatTreeNode(
    threadId: string,
    nodeId: string
  ): Promise<void> {
    await this.start(this.startConfig);
    await this.rpc("thread/chatTree/current/set", {
      threadId,
      nodeId
    } satisfies ThreadChatTreeSetCurrentParams);
  }

  public async setCurrentChatTreeNodeForSession(
    sessionId: string,
    nodeId: string
  ): Promise<boolean> {
    const threadId = this.threadIdBySessionId.get(sessionId);
    if (!threadId) {
      return false;
    }
    await this.setCurrentChatTreeNode(threadId, nodeId);
    return true;
  }

  public async archiveThreadForSession(sessionId: string): Promise<boolean> {
    const threadId = this.threadIdBySessionId.get(sessionId);
    if (!threadId) {
      return false;
    }
    await this.archiveThread(threadId);
    return true;
  }

  public async archiveThread(threadId: string): Promise<void> {
    await this.start(this.startConfig);
    await this.rpc("thread/archive", {
      threadId
    } satisfies ThreadArchiveParams);
  }

  public async readAuthStatus(): Promise<GetAuthStatusResponse> {
    await this.start(this.startConfig);
    return (await this.rpc("getAuthStatus", {
      includeToken: false,
      refreshToken: false
    } satisfies GetAuthStatusParams)) as GetAuthStatusResponse;
  }

  public async readGitDiffToRemote(cwd: string): Promise<GitDiffToRemoteResponse> {
    await this.start(this.startConfig);
    return (await this.rpc("gitDiffToRemote", {
      cwd
    } satisfies GitDiffToRemoteParams)) as GitDiffToRemoteResponse;
  }

  public async listSkills(
    params: Partial<SkillsListParams> = {}
  ): Promise<SkillsListResponse> {
    await this.start(this.startConfig);
    const payload: SkillsListParams = {
      forceReload: params.forceReload ?? false
    };
    if (params.cwds) {
      payload.cwds = params.cwds;
    }
    if (params.perCwdExtraUserRoots) {
      payload.perCwdExtraUserRoots = params.perCwdExtraUserRoots;
    }
    return (await this.rpc("skills/list", payload)) as SkillsListResponse;
  }

  private async handleTurnStart(payload: CodexRuntimeRequest): Promise<void> {
    const sessionId = String(payload.params.sessionId ?? "");
    const content = String(payload.params.content ?? "");
    const attachments = Array.isArray(payload.params.attachments)
      ? (payload.params.attachments as Attachment[])
      : [];
    const cwd =
      typeof payload.params.cwd === "string" && payload.params.cwd.trim().length > 0
        ? payload.params.cwd
        : undefined;
    const threadId = await this.ensureThreadForSession(sessionId, cwd);
    const input = buildCodexTurnInput(content, attachments);

    const result = (await this.rpc("turn/start", {
      threadId,
      input
    })) as TurnStartResponse;

    if (result?.turn?.id) {
      this.emitEvent("turn.started", {
        sessionId,
        turnId: result.turn.id
      });
    }
  }

  private async handleTurnSteer(payload: CodexRuntimeRequest): Promise<void> {
    const sessionId = String(payload.params.sessionId ?? "");
    const expectedTurnId = String(payload.params.turnId ?? "");
    const content = String(payload.params.content ?? "");
    const attachments = Array.isArray(payload.params.attachments)
      ? (payload.params.attachments as Attachment[])
      : [];
    const threadId = this.threadIdBySessionId.get(sessionId);
    if (!threadId || !expectedTurnId) {
      return;
    }
    const input = buildCodexTurnInput(content, attachments);
    await this.rpc("turn/steer", {
      threadId,
      input,
      expectedTurnId
    } satisfies TurnSteerParams);
  }

  private async handleTurnInterrupt(payload: CodexRuntimeRequest): Promise<void> {
    const sessionId = String(payload.params.sessionId ?? "");
    const threadId = this.threadIdBySessionId.get(sessionId);
    const turnId = String(payload.params.turnId ?? "");
    if (!threadId || !turnId) {
      return;
    }
    await this.rpc("turn/interrupt", {
      threadId,
      turnId
    });
  }

  private async handleApprovalResponse(payload: CodexRuntimeRequest): Promise<void> {
    const requestId = String(payload.params.requestId ?? "");
    const approval = this.pendingApprovalsById.get(requestId);
    if (!approval) {
      return;
    }

    const action = String(payload.params.action ?? "defer") as
      | "approve"
      | "deny"
      | "defer";

    const result =
      approval.method === "item/permissions/requestApproval"
        ? {
            permissions: {},
            scope: action === "approve" ? "session" : "turn"
          }
        : {
            decision: resolveApprovalDecision(approval, action)
          };

    this.write({
      id: approval.rawRequestId,
      result
    });
    this.pendingApprovalResolutionsById.set(requestId, { action });
  }

  private async ensureThreadForSession(
    sessionId: string,
    cwd?: string
  ): Promise<string> {
    const existing = this.threadIdBySessionId.get(sessionId);
    if (existing) {
      return existing;
    }

    const selected = this.resolveSelectedConfig();
    const threadStartParams: Record<string, unknown> = {
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: true
    };

    const resolvedCwd = cwd ?? selected.cwd ?? this.startConfig.cwd;
    if (resolvedCwd) {
      threadStartParams.cwd = resolvedCwd;
    }
    if (selected.model !== undefined) {
      threadStartParams.model = selected.model;
    }
    if (selected.modelProvider !== undefined) {
      threadStartParams.modelProvider = selected.modelProvider;
    }
    if (selected.serviceTier !== undefined) {
      threadStartParams.serviceTier = selected.serviceTier;
    }
    if (selected.approvalPolicy !== undefined) {
      threadStartParams.approvalPolicy = selected.approvalPolicy;
    }
    if (selected.sandbox !== undefined) {
      threadStartParams.sandbox = selected.sandbox;
    }

    const result = (await this.rpc("thread/start", threadStartParams)) as ThreadStartResponse;

    const threadId = result.thread.id;
    this.threadIdBySessionId.set(sessionId, threadId);
    this.sessionIdByThreadId.set(threadId, sessionId);
    return threadId;
  }

  private resolveSelectedConfig(): CodexSelectedConfig {
    const metadata = this.startConfig.metadata;
    if (!metadata || !isRecord(metadata.selectedConfig)) {
      return {};
    }
    return metadata.selectedConfig as CodexSelectedConfig;
  }

  private consumeStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line.trim()) {
        continue;
      }

      let payload: JsonRpcPayload;
      try {
        payload = JSON.parse(line) as JsonRpcPayload;
      } catch (error) {
        this.emitEvent("runtime.error", {
          code: "CODEX_APP_SERVER_BAD_JSON",
          message: error instanceof Error ? error.message : "Failed to parse JSON line",
          recoverable: true,
          details: {
            rawLine: line
          }
        });
        continue;
      }

      if (typeof payload.method === "string" && payload.id !== undefined) {
        this.handleServerRequest(payload);
        continue;
      }

      if (typeof payload.method === "string") {
        this.handleNotification(payload.method, payload.params ?? {});
        continue;
      }

      if (payload.id !== undefined) {
        const requestId = localRequestId(payload.id);
        const pending = this.pendingRpcById.get(requestId);
        if (!pending) {
          continue;
        }
        this.pendingRpcById.delete(requestId);
        if (payload.error?.message) {
          pending.reject(new Error(payload.error.message));
        } else {
          pending.resolve(payload.result);
        }
      }
    }
  }

  private handleServerRequest(payload: JsonRpcPayload): void {
    const method = payload.method;
    const rawRequestId = payload.id;
    if (rawRequestId === undefined || !method) {
      return;
    }
    const params = isRecord(payload.params) ? payload.params : {};
    const threadId = String(params.threadId ?? "");
    const sessionId = this.sessionIdByThreadId.get(threadId) ?? threadId;
    const requestId = localRequestId(rawRequestId);

    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval": {
        const turnId = String(params.turnId ?? "");
        const itemId = String(params.itemId ?? requestId);
        const title =
          method === "item/fileChange/requestApproval"
            ? "Approve file change"
            : method === "item/permissions/requestApproval"
              ? "Approve additional permissions"
              : "Approve command execution";
        const details = [
          typeof params.reason === "string" ? params.reason : undefined,
          typeof params.command === "string" ? params.command : undefined
        ]
          .filter((value): value is string => Boolean(value))
          .join("\n\n");
        const availableDecisions = Array.isArray(params.availableDecisions)
          ? params.availableDecisions.filter(
              (value): value is string => typeof value === "string"
            )
          : undefined;

        this.pendingApprovalsById.set(requestId, {
          requestId,
          rawRequestId,
          sessionId,
          turnId,
          itemId,
          method,
          title,
          details: details || undefined,
          availableDecisions
        });

        this.emitEvent("session.updated", {
          conversationId:
            this.resolveConversationIdBySessionId?.(sessionId) ?? sessionId,
          sessionId,
          status: "awaiting_approval"
        });
        this.emitEvent("approval.requested", {
          sessionId,
          turnId,
          requestId,
          approvalKind:
            method === "item/fileChange/requestApproval"
              ? "file_change"
              : method === "item/permissions/requestApproval"
                ? "custom"
                : "command",
          title,
          details: details || undefined,
          engineId: this.engineId
        });
        return;
      }
      default:
        this.write({
          id: rawRequestId,
          error: {
            code: "UNSUPPORTED_SERVER_REQUEST",
            message: `Unsupported server request: ${method}`
          }
        });
        this.emitEvent("runtime.error", {
          sessionId,
          code: "UNSUPPORTED_SERVER_REQUEST",
          message: `Unsupported server request: ${method}`,
          recoverable: true
        });
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "thread/status/changed": {
        const threadId = String(params.threadId ?? "");
        const sessionId = this.sessionIdByThreadId.get(threadId);
        if (!sessionId) {
          return;
        }
        this.emitEvent("session.updated", {
          conversationId:
            this.resolveConversationIdBySessionId?.(sessionId) ?? sessionId,
          sessionId,
          status: mapSessionStatus(
            isRecord(params.status) ? params.status : undefined
          )
        });
        return;
      }
      case "turn/started": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const turn = isRecord(params.turn) ? params.turn : undefined;
        if (!sessionId || !turn || typeof turn.id !== "string") {
          return;
        }
        this.emitEvent("turn.started", {
          sessionId,
          turnId: turn.id
        });
        return;
      }
      case "turn/completed": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const turn = isRecord(params.turn) ? params.turn : undefined;
        if (!sessionId || !turn || typeof turn.id !== "string") {
          return;
        }
        this.emitEvent("turn.completed", {
          sessionId,
          turnId: turn.id,
          finishReason: mapFinishReason(
            typeof turn.status === "string" ? turn.status : undefined
          )
        });
        return;
      }
      case "turn/diff/updated": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
        const diff = typeof params.diff === "string" ? params.diff : undefined;
        if (!sessionId || !turnId || diff === undefined) {
          return;
        }
        recordCodexTurnChangesFromUnifiedDiff({
          sessionId,
          turnId,
          diff
        });
        const record = getRecordedCodexTurnChanges(sessionId, turnId);
        if (record) {
          this.recordTurnChanges?.(record);
        }
        return;
      }
      case "item/started":
      case "item/completed": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
        const item = isRecord(params.item) ? (params.item as ThreadItem) : undefined;
        if (!sessionId || !turnId || !item) {
          return;
        }
        this.handleItemLifecycle(method, sessionId, turnId, item);
        return;
      }
      case "item/agentMessage/delta": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
        const messageId = typeof params.itemId === "string" ? params.itemId : undefined;
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!sessionId || !turnId || !messageId || !delta) {
          return;
        }
        this.emitEvent("message.delta", {
          sessionId,
          turnId,
          messageId,
          delta,
          engineId: this.engineId
        });
        return;
      }
      case "item/commandExecution/outputDelta": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
        const toolCallId = typeof params.itemId === "string" ? params.itemId : undefined;
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!sessionId || !turnId || !toolCallId || !delta) {
          return;
        }
        this.emitEvent("tool.delta", {
          sessionId,
          turnId,
          toolCallId,
          delta,
          engineId: this.engineId
        });
        this.emitEvent("terminal.output", {
          sessionId,
          turnId,
          terminalId: toolCallId,
          chunk: delta,
          engineId: this.engineId
        });
        return;
      }
      case "serverRequest/resolved":
        this.handleServerRequestResolved(params);
        return;
      case "error": {
        const sessionId = this.resolveSessionIdFromThreadId(params.threadId);
        const error = isRecord(params.error) ? params.error : undefined;
        const codexErrorInfo = error?.codexErrorInfo;
        const additionalDetails = error?.additionalDetails;
        this.emitEvent("runtime.error", {
          sessionId,
          turnId: typeof params.turnId === "string" ? params.turnId : undefined,
          code:
            typeof codexErrorInfo === "string"
              ? codexErrorInfo
              : typeof params.code === "string"
                ? params.code
                : "CODEX_APP_SERVER_ERROR",
          message:
            typeof error?.message === "string"
              ? error.message
              : typeof params.message === "string"
                ? params.message
              : "Unknown codex app-server error",
          recoverable: false,
          details:
            typeof additionalDetails === "string" && additionalDetails
              ? { additionalDetails }
              : undefined
        });
        return;
      }
      default:
        return;
    }
  }

  private handleServerRequestResolved(params: Record<string, unknown>): void {
    const rawRequestId = params.requestId;
    if (typeof rawRequestId !== "string" && typeof rawRequestId !== "number") {
      return;
    }
    const requestId = localRequestId(rawRequestId);
    if (!requestId) {
      return;
    }

    const approval = this.pendingApprovalsById.get(requestId);
    const resolution = this.pendingApprovalResolutionsById.get(requestId);
    if (!approval || !resolution) {
      return;
    }

    this.pendingApprovalsById.delete(requestId);
    this.pendingApprovalResolutionsById.delete(requestId);

    this.emitEvent("approval.resolved", {
      sessionId: approval.sessionId,
      turnId: approval.turnId,
      requestId,
      action: resolution.action,
      engineId: this.engineId
    });
  }

  private handleItemLifecycle(
    method: "item/started" | "item/completed",
    sessionId: string,
    turnId: string,
    item: ThreadItem
  ): void {
    if (isTextThreadItem(item)) {
      this.emitEvent(method === "item/started" ? "message.started" : "message.completed", {
        sessionId,
        turnId,
        messageId: item.id,
        role: "assistant",
        ...(method === "item/completed" ? { finalText: item.text } : {}),
        ...(method === "item/completed" && isFinalAnswerMessageItem(item)
          ? { isFinalForTurn: true }
          : {}),
        engineId: this.engineId
      });
      return;
    }

    if (isCommandExecutionThreadItem(item)) {
      if (method === "item/started") {
        this.emitEvent("tool.started", {
          sessionId,
          turnId,
          toolCallId: item.id,
          toolName: "commandExecution",
          inputSummary: item.command,
          engineId: this.engineId
        });
        this.emitEvent("terminal.started", {
          sessionId,
          turnId,
          terminalId: item.id,
          toolCallId: item.id,
          engineId: this.engineId
        });
        return;
      }

      const completedStatus =
        item.status === "failed"
          ? "failed"
          : item.status === "declined"
            ? "cancelled"
            : "completed";
      this.emitEvent("terminal.completed", {
        sessionId,
        turnId,
        terminalId: item.id,
        exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined,
        engineId: this.engineId
      });
      this.emitEvent("tool.completed", {
        sessionId,
        turnId,
        toolCallId: item.id,
        status: completedStatus,
        outputSummary:
          typeof item.aggregatedOutput === "string"
            ? item.aggregatedOutput
            : undefined,
          engineId: this.engineId
      });
      return;
    }

    if (isFileChangeThreadItem(item)) {
      recordCodexTurnChangesFromFileUpdate({
        sessionId,
        turnId,
        changes: item.changes
      });
      const record = getRecordedCodexTurnChanges(sessionId, turnId);
      if (record) {
        this.recordTurnChanges?.(record);
      }
      return;
    }

    if (isCollabAgentToolCallThreadItem(item)) {
      this.syncCollabAgentSessions(sessionId, turnId, item);

      if (method === "item/started") {
        this.emitEvent("tool.started", {
          sessionId,
          turnId,
          toolCallId: item.id,
          toolName: mapCollabToolLabel(item.tool),
          inputSummary: summarizeCollabInput(item),
          engineId: this.engineId
        });
        return;
      }

      this.emitEvent("tool.completed", {
        sessionId,
        turnId,
        toolCallId: item.id,
        status: item.status === "failed" ? "failed" : "completed",
        outputSummary: summarizeCollabOutput(item),
        engineId: this.engineId
      });
    }
  }

  private syncCollabAgentSessions(
    parentSessionId: string,
    turnId: string,
    item: Extract<ThreadItem, { type: "collabAgentToolCall" }>
  ): void {
    const conversationId = this.resolveConversationIdBySessionId?.(parentSessionId);
    if (!conversationId) {
      return;
    }

    for (const receiverThreadId of item.receiverThreadIds) {
      const childSessionId = discoveredCodexSessionId(receiverThreadId);
      this.attachThreadToSession(childSessionId, receiverThreadId);

      const childState = item.agentsStates[receiverThreadId];

      if (item.tool === "spawnAgent") {
        this.emitEvent("session.created", {
          conversationId,
          sessionId: childSessionId,
          engineId: this.engineId,
          status: mapCollabAgentStatus(childState?.status),
          relation: {
            relationId: `subagent:${parentSessionId}:${childSessionId}`,
            parentSessionId,
            childSessionId,
            relationType: "subagent",
            sourceTurnId: turnId,
            createdAt: this.now()
          }
        });
      }

      this.emitEvent("session.updated", {
        conversationId,
        sessionId: childSessionId,
        status: mapCollabAgentStatus(childState?.status),
        metadata: {
          providerKind: "codex-thread",
          providerSessionId: receiverThreadId
        }
      });
    }
  }

  private resolveSessionIdFromThreadId(rawThreadId: unknown): string | undefined {
    if (typeof rawThreadId !== "string") {
      return undefined;
    }
    return this.sessionIdByThreadId.get(rawThreadId);
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = String(++this.requestCounter);
    const result = new Promise<unknown>((resolve, reject) => {
      this.pendingRpcById.set(id, { resolve, reject });
    });
    this.write({
      id,
      method,
      params
    });
    return result;
  }

  private write(payload: JsonRpcPayload): void {
    const child = this.process;
    if (!child) {
      throw new Error("codex app-server is not started.");
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private emitEvent(method: EventType, params: Record<string, unknown>): void {
    this.sequence += 1;
    const event: CodexRuntimeEvent = {
      method,
      params,
      eventId: `codex-runtime-${this.sequence}`,
      cursor: String(this.sequence),
      occurredAt: this.now()
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export const createCodexAppServerRuntimePort = (
  options: CodexAppServerRuntimePortOptions = {}
): CodexAppServerRuntimePort =>
  new CodexAppServerRuntimePort(options);
