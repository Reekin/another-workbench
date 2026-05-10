import type {
  ChatSession,
  TakeoverPresetSummaryRpc
} from "@another-workbench/shared";
import type { HostToolRegistration, HostToolResult } from "./host-tools.js";
import {
  createSmartTakeoverHostTool,
  createSubmitTakeoverVerdictHostTool,
  type SmartTakeoverRequest,
  type TakeoverVerdictRequest
} from "./smart-takeover-tool.js";
import { TakeoverPresetStore } from "./takeover-preset-store.js";
import type { WorkbenchRuntimeService } from "./runtime-service.js";

type Clock = () => string;
type IdFactory = () => string;

type TakeoverToolArgs = {
  action?: "help" | "start";
  helpTopic?: "overview" | "presets" | "brief" | "loop" | "result";
  presetId?: string;
  brief?: string;
  customPrompt?: string;
  successCriteria?: string[];
  focusFiles?: string[];
  timeoutMs?: number;
};

type TakeoverVerdictPayload = {
  verdict: "complete" | "incomplete";
  response: string;
};

type TakeoverRun = {
  runId: string;
  parentSessionId: string;
  takeoverSessionId?: string;
  presetId: string;
  createdAt: string;
  source: "tool" | "manual";
};

type TakeoverConfig = {
  presetId: string;
  args: TakeoverToolArgs;
  requestedBy?: SmartTakeoverRequest["requestedBy"];
  sourceTurnId?: string;
  sourceToolCallId?: string;
  source: TakeoverRun["source"];
};

export type TakeoverSessionState = {
  sessionId: string;
  role: "none" | "managed" | "takeover-agent";
  active: boolean;
  manualPresetId?: string;
  presetId?: string;
  takeoverSessionId?: string;
};

export type SmartTakeoverServiceOptions = {
  runtimeService: WorkbenchRuntimeService;
  presetStore: TakeoverPresetStore;
  now?: Clock;
  createId?: IdFactory;
  defaultTimeoutMs?: number;
};

const createOpaqueId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

const textResult = (text: string, success = true): HostToolResult => ({
  contentItems: [
    {
      type: "inputText",
      text
    }
  ],
  success
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string");
};

const parseTakeoverArgs = (value: unknown): TakeoverToolArgs => {
  if (!isRecord(value)) {
    return {};
  }
  return {
    action:
      value.action === "help" || value.action === "start"
        ? value.action
        : undefined,
    helpTopic:
      value.helpTopic === "overview" ||
      value.helpTopic === "presets" ||
      value.helpTopic === "brief" ||
      value.helpTopic === "loop" ||
      value.helpTopic === "result"
        ? value.helpTopic
        : undefined,
    presetId: typeof value.presetId === "string" ? value.presetId : undefined,
    brief: typeof value.brief === "string" ? value.brief : undefined,
    customPrompt:
      typeof value.customPrompt === "string" ? value.customPrompt : undefined,
    successCriteria: stringArray(value.successCriteria),
    focusFiles: stringArray(value.focusFiles),
    timeoutMs:
      typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs)
        ? value.timeoutMs
        : undefined
  };
};

const parseVerdict = (
  value: unknown
): TakeoverVerdictPayload | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const verdict = value.verdict;
  if (verdict !== "complete" && verdict !== "incomplete") {
    return undefined;
  }
  if (typeof value.response !== "string") {
    return undefined;
  }
  return {
    verdict,
    response: value.response
  };
};

const parseFallbackVerdict = (
  finalText: string | undefined
): TakeoverVerdictPayload | undefined => {
  if (!finalText) {
    return undefined;
  }
  const match = finalText.match(
    /TAKEOVER_VERDICT:\s*(complete|incomplete)/i
  );
  if (!match) {
    return undefined;
  }
  const verdict = match[1].toLowerCase() as TakeoverVerdictPayload["verdict"];
  return {
    verdict,
    response: finalText.trim()
  };
};

export class SmartTakeoverService {
  private readonly runtimeService: WorkbenchRuntimeService;
  private readonly presetStore: TakeoverPresetStore;
  private readonly now: Clock;
  private readonly createId: IdFactory;
  private readonly defaultTimeoutMs: number;
  private readonly runsById = new Map<string, TakeoverRun>();
  private readonly runIdByTakeoverSessionId = new Map<string, string>();
  private readonly runIdByParentSessionId = new Map<string, string>();
  private readonly takeoverConfigByParentSessionId = new Map<string, TakeoverConfig>();
  private readonly pendingLaunchUnsubscribesByParentSessionId = new Map<
    string,
    () => void
  >();
  private readonly pendingVerdictResolvers = new Map<
    string,
    (verdict: TakeoverVerdictPayload) => void
  >();
  private readonly pendingVerdictRejecters = new Map<
    string,
    (error: Error) => void
  >();

  public constructor(options: SmartTakeoverServiceOptions) {
    this.runtimeService = options.runtimeService;
    this.presetStore = options.presetStore;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => createOpaqueId("takeover"));
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10 * 60 * 1000;
  }

  public createHostTools(): HostToolRegistration[] {
    return [
      createSmartTakeoverHostTool({
        isAvailable: (context) =>
          !this.isActiveTakeoverRun(context.sessionId) &&
          !this.isActiveParentRun(context.sessionId),
        onRequest: (request) => this.handleSmartTakeover(request)
      }),
      createSubmitTakeoverVerdictHostTool({
        isAvailable: (context) => this.isActiveTakeoverRun(context.sessionId),
        onSubmit: (request) => this.handleVerdict(request)
      })
    ];
  }

  public isTakeoverSession(sessionId: string): boolean {
    const takeover = this.resolveTakeoverMetadata(sessionId);
    return takeover?.role === "takeover-agent";
  }

  public isActiveTakeoverRun(sessionId: string): boolean {
    const runId = this.runIdByTakeoverSessionId.get(sessionId);
    return Boolean(runId && this.pendingVerdictResolvers.has(runId));
  }

  public isActiveParentRun(sessionId: string): boolean {
    const runId = this.runIdByParentSessionId.get(sessionId);
    return Boolean(runId && this.pendingVerdictResolvers.has(runId));
  }

  public isTakeoverEnabled(sessionId: string): boolean {
    return this.takeoverConfigByParentSessionId.has(sessionId);
  }

  public getSessionState(sessionId: string): TakeoverSessionState {
    const takeoverRunId = this.runIdByTakeoverSessionId.get(sessionId);
    const takeoverRun = takeoverRunId ? this.runsById.get(takeoverRunId) : undefined;
    const takeoverMetadata = this.resolveTakeoverMetadata(sessionId);
    if (takeoverMetadata?.role === "takeover-agent") {
      return {
        sessionId,
        role: "takeover-agent",
        active: Boolean(takeoverRunId && this.pendingVerdictResolvers.has(takeoverRunId)),
        presetId: takeoverRun?.presetId ?? takeoverMetadata.presetId
      };
    }

    const parentRunId = this.runIdByParentSessionId.get(sessionId);
    const parentRun = parentRunId ? this.runsById.get(parentRunId) : undefined;
    const config = this.takeoverConfigByParentSessionId.get(sessionId);
    if (parentRun || config) {
      return {
        sessionId,
        role: "managed",
        active: Boolean(parentRunId && this.pendingVerdictResolvers.has(parentRunId)),
        manualPresetId: config?.presetId,
        presetId: parentRun?.presetId ?? config?.presetId,
        takeoverSessionId: parentRun?.takeoverSessionId
      };
    }

    return {
      sessionId,
      role: "none",
      active: false
    };
  }

  public async setManualTakeover(input: {
    sessionId: string;
    presetId?: string;
  }): Promise<TakeoverSessionState> {
    if (!input.presetId) {
      this.takeoverConfigByParentSessionId.delete(input.sessionId);
      this.cancelPendingLaunch(input.sessionId);
      const activeRunId = this.runIdByParentSessionId.get(input.sessionId);
      if (activeRunId) {
        this.cancelRun(activeRunId, "Manual takeover was disabled.");
      }
      return this.getSessionState(input.sessionId);
    }

    await this.enableTakeover({
      parentSessionId: input.sessionId,
      args: {
        action: "start",
        presetId: input.presetId,
        brief:
          "Manual takeover was enabled from Another Workbench. Inspect the current session and reply as the delegated virtual user."
      },
      source: "manual"
    });
    return this.getSessionState(input.sessionId);
  }

  public getSessionMarker(
    sessionId: string
  ): { takeoverStatus?: "managed" | "agent"; takeoverPresetId?: string } {
    const state = this.getSessionState(sessionId);
    if (state.role === "takeover-agent") {
      return {
        takeoverStatus: "agent",
        takeoverPresetId: state.presetId
      };
    }
    if (state.role === "managed") {
      return {
        takeoverStatus: "managed",
        takeoverPresetId: state.presetId ?? state.manualPresetId
      };
    }
    return {};
  }

  private resolveRunIdForTakeoverSession(sessionId: string): string | undefined {
    return this.runIdByTakeoverSessionId.get(sessionId);
  }

  private resolveTakeoverMetadata(
    sessionId: string
  ): { role?: string; runId?: string; presetId?: string } | undefined {
    const takeover = this.runtimeService.getSession(sessionId)?.metadata?.takeover;
    if (!isRecord(takeover)) {
      return undefined;
    }
    return {
      role: typeof takeover.role === "string" ? takeover.role : undefined,
      runId: typeof takeover.runId === "string" ? takeover.runId : undefined,
      presetId:
        typeof takeover.presetId === "string" ? takeover.presetId : undefined
    };
  }

  private finalizeRun(runId: string): void {
    this.pendingVerdictResolvers.delete(runId);
    this.pendingVerdictRejecters.delete(runId);
    const run = this.runsById.get(runId);
    if (run?.takeoverSessionId) {
      this.runIdByTakeoverSessionId.delete(run.takeoverSessionId);
    }
    if (
      run?.parentSessionId &&
      this.runIdByParentSessionId.get(run.parentSessionId) === runId
    ) {
      this.runIdByParentSessionId.delete(run.parentSessionId);
    }
    this.runsById.delete(runId);
  }

  private cancelRun(runId: string, reason: string): void {
    const rejecter = this.pendingVerdictRejecters.get(runId);
    if (rejecter) {
      rejecter(new Error(reason));
      return;
    }
    this.finalizeRun(runId);
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(message));
      }, timeoutMs);
      promise.then(resolve, reject).finally(() => clearTimeout(timeout));
    });
  }

  private async handleSmartTakeover(
    request: SmartTakeoverRequest
  ): Promise<HostToolResult> {
    const args = parseTakeoverArgs(request.arguments);
    if (
      args.action === "help" ||
      (!args.action && !args.brief && !args.customPrompt && !args.presetId)
    ) {
      return textResult(await this.buildHelp(args.helpTopic));
    }
    try {
      const existingConfig = this.takeoverConfigByParentSessionId.get(
        request.parentSessionId
      );
      if (existingConfig) {
        return textResult(
          `SmartTakeover is already enabled for session ${request.parentSessionId}. It will run after the current response is complete.`
        );
      }
      return textResult(
        await this.enableTakeover({
          parentSessionId: request.parentSessionId,
          args: {
            ...args,
            action: "start"
          },
          requestedBy: request.requestedBy,
          sourceTurnId: request.sourceTurnId,
          sourceToolCallId: request.sourceToolCallId,
          source: "tool"
        })
      );
    } catch (error) {
      return textResult(
        `SmartTakeover failed: ${(error as Error).message}`,
        false
      );
    }
  }

  private async handleVerdict(
    request: TakeoverVerdictRequest
  ): Promise<HostToolResult> {
    const runId = this.resolveRunIdForTakeoverSession(request.takeoverSessionId);
    const verdict = parseVerdict(request.arguments);
    const run = runId ? this.runsById.get(runId) : undefined;
    if (
      !verdict ||
      !runId ||
      !run ||
      (run?.takeoverSessionId &&
        run.takeoverSessionId !== request.takeoverSessionId)
    ) {
      return textResult(
        "SubmitTakeoverVerdict failed: this session must be an active takeover run and provide verdict complete/incomplete plus response.",
        false
      );
    }
    const resolver = this.pendingVerdictResolvers.get(runId);
    if (!resolver) {
      return textResult(
        `SubmitTakeoverVerdict failed: takeover run ${runId} is not pending.`,
        false
      );
    }
    resolver(verdict);
    return textResult(
      `Takeover verdict accepted: ${verdict.verdict}.`
    );
  }

  private async enableTakeover(input: {
    parentSessionId: string;
    args: TakeoverToolArgs;
    requestedBy?: SmartTakeoverRequest["requestedBy"];
    sourceTurnId?: string;
    sourceToolCallId?: string;
    source: TakeoverRun["source"];
  }): Promise<string> {
    const parentSession = this.runtimeService.getSession(input.parentSessionId);
    if (!parentSession) {
      throw new Error(`Parent session not found: ${input.parentSessionId}`);
    }
    const presetId = input.args.presetId ?? "review";
    await this.presetStore.read(presetId);

    const existingRunId = this.runIdByParentSessionId.get(parentSession.sessionId);
    const existingRun = existingRunId ? this.runsById.get(existingRunId) : undefined;
    this.takeoverConfigByParentSessionId.set(parentSession.sessionId, {
      presetId,
      args: {
        ...input.args,
        action: "start",
        presetId
      },
      requestedBy: input.requestedBy,
      sourceTurnId: input.sourceTurnId,
      sourceToolCallId: input.sourceToolCallId,
      source: input.source
    });
    this.cancelPendingLaunch(parentSession.sessionId);
    if (existingRunId && this.pendingVerdictResolvers.has(existingRunId)) {
      this.cancelRun(
        existingRunId,
        existingRun?.presetId === presetId
          ? "Takeover was reconfigured."
          : "Takeover preset changed."
      );
    }
    this.startOrScheduleConfiguredRun(parentSession.sessionId);
    return `SmartTakeover enabled for session ${parentSession.sessionId}. It will run after the current response is complete.`;
  }

  private async launchTakeover(
    request: SmartTakeoverRequest,
    args: TakeoverToolArgs,
    source: TakeoverRun["source"],
    shouldContinue: () => boolean = () => true
  ): Promise<{
    runId: string;
    run: TakeoverRun;
    takeoverSession: ChatSession;
    verdictPromise: Promise<TakeoverVerdictPayload>;
  }> {
    const parentSession = this.runtimeService.getSession(request.parentSessionId);
    if (!parentSession) {
      throw new Error(`Parent session not found: ${request.parentSessionId}`);
    }
    const presetId = args.presetId ?? "review";
    const preset = await this.presetStore.read(presetId);
    if (!shouldContinue()) {
      throw new Error("Takeover launch cancelled.");
    }
    const snapshot = this.runtimeService.getSnapshot();
    const conversation = snapshot.conversations.find(
      (item) => item.conversationId === parentSession.conversationId
    );
    const workspaceRegistry = this.runtimeService.getWorkspaceRegistry();
    await workspaceRegistry?.ready();
    const workspace = conversation?.workspaceId
      ? workspaceRegistry
          ?.getState()
          .workspaces.find((item) => item.workspaceId === conversation.workspaceId)
      : undefined;
    if (!shouldContinue()) {
      throw new Error("Takeover launch cancelled.");
    }
    const workspacePath =
      workspace?.absolutePath ??
      (typeof parentSession.metadata?.cwd === "string"
        ? parentSession.metadata.cwd
        : undefined);
    const existingRunId = this.runIdByParentSessionId.get(parentSession.sessionId);
    if (existingRunId && this.pendingVerdictResolvers.has(existingRunId)) {
      throw new Error(
        `Takeover is already active for parent session ${parentSession.sessionId}.`
      );
    }

    const runId = this.createId();
    const run: TakeoverRun = {
      runId,
      parentSessionId: parentSession.sessionId,
      presetId,
      createdAt: this.now(),
      source
    };
    this.runsById.set(runId, run);
    this.runIdByParentSessionId.set(parentSession.sessionId, runId);

    let verdictPromise: Promise<TakeoverVerdictPayload> | undefined;
    try {
      const takeoverSession = await this.runtimeService.createRelatedSession({
        parentSessionId: parentSession.sessionId,
        engineId: parentSession.engineId,
        relationType: "subagent",
        sourceTurnId: request.sourceTurnId,
        workspaceId: conversation?.workspaceId,
        metadata: {
          cwd: workspacePath,
          takeover: {
            runId,
            parentSessionId: parentSession.sessionId,
            sourceTurnId: request.sourceTurnId,
            sourceToolCallId: request.sourceToolCallId,
            presetId,
            role: "takeover-agent"
          }
        }
      });
      run.takeoverSessionId = takeoverSession.sessionId;
      this.runIdByTakeoverSessionId.set(takeoverSession.sessionId, runId);
      if (!shouldContinue()) {
        throw new Error("Takeover launch cancelled.");
      }

      const cursor = this.runtimeService.getSnapshotResult().cursor;
      const timeoutMs = args.timeoutMs ?? this.defaultTimeoutMs;
      verdictPromise = this.waitForVerdict({
        runId,
        takeoverSessionId: takeoverSession.sessionId,
        fromCursor: cursor,
        timeoutMs
      });
      if (!shouldContinue()) {
        throw new Error("Takeover launch cancelled.");
      }
      const receipt = await this.withTimeout(
        this.runtimeService.executeCommand({
          commandId: this.createId(),
          issuedAt: this.now(),
          command: {
            type: "sendUserMessage",
            sessionId: takeoverSession.sessionId,
            messageId: this.createId(),
            content: this.composeTakeoverPrompt({
              parentSession,
              takeoverSession,
              workspacePath,
              presetPrompt: preset.prompt,
              args,
              request
            }),
            attachments: [],
            cwd: workspacePath
          }
        }),
        timeoutMs,
        `Takeover session did not accept the initial prompt within ${timeoutMs}ms.`
      );
      if (!receipt.accepted) {
        throw new Error("Takeover session rejected the initial prompt.");
      }

      return {
        runId,
        takeoverSession,
        run,
        verdictPromise
      };
    } catch (error) {
      if (verdictPromise) {
        this.cancelRun(runId, (error as Error).message);
        await verdictPromise.catch(() => undefined);
      } else {
        this.finalizeRun(runId);
      }
      throw error;
    }
  }

  private startOrScheduleConfiguredRun(parentSessionId: string): void {
    const parentSession = this.runtimeService.getSession(parentSessionId);
    if (!parentSession) {
      this.takeoverConfigByParentSessionId.delete(parentSessionId);
      this.cancelPendingLaunch(parentSessionId);
      return;
    }
    if (this.runIdByParentSessionId.has(parentSessionId)) {
      return;
    }
    if (parentSession.status === "running" || parentSession.status === "awaiting_approval") {
      this.scheduleConfiguredRunAfterParentTurn(
        parentSessionId,
        this.runtimeService.getSnapshotResult().cursor
      );
      return;
    }
    void this.startConfiguredRun(parentSessionId);
  }

  private startConfiguredRun(parentSessionId: string): void {
    void this.runConfiguredTakeover(parentSessionId);
  }

  private async runConfiguredTakeover(parentSessionId: string): Promise<void> {
    const config = this.takeoverConfigByParentSessionId.get(parentSessionId);
    const parentSession = this.runtimeService.getSession(parentSessionId);
    if (!config || !parentSession || this.runIdByParentSessionId.has(parentSessionId)) {
      return;
    }
    const isCurrentConfig = (): boolean =>
      this.takeoverConfigByParentSessionId.get(parentSessionId) === config;
    const providerHandle = this.runtimeService.resolveProviderSessionHandle(parentSessionId);
    try {
      if (!isCurrentConfig()) {
        return;
      }
      const launch = await this.launchTakeover(
        {
          parentSessionId,
          requestedBy: config.requestedBy ?? {
            engineId: parentSession.engineId,
            providerSessionId: providerHandle?.providerSessionId ?? parentSessionId
          },
          sourceTurnId: config.sourceTurnId,
          sourceToolCallId: config.sourceToolCallId,
          arguments: config.args
        },
        config.args,
        config.source,
        isCurrentConfig
      );
      if (!isCurrentConfig()) {
        return;
      }
      const verdict = await launch.verdictPromise;
      await this.forwardTakeoverVerdictToParent(launch.run, verdict);
    } catch {
      if (this.takeoverConfigByParentSessionId.get(parentSessionId) === config) {
        this.takeoverConfigByParentSessionId.delete(parentSessionId);
        this.cancelPendingLaunch(parentSessionId);
      }
    }
  }

  private async forwardTakeoverVerdictToParent(
    run: TakeoverRun,
    verdict: TakeoverVerdictPayload
  ): Promise<void> {
    const config = this.takeoverConfigByParentSessionId.get(run.parentSessionId);
    if (config?.presetId !== run.presetId) {
      return;
    }
    const parentSession = this.runtimeService.getSession(run.parentSessionId);
    if (!parentSession) {
      this.takeoverConfigByParentSessionId.delete(run.parentSessionId);
      this.cancelPendingLaunch(run.parentSessionId);
      return;
    }
    const cursor = this.runtimeService.getSnapshotResult().cursor;
    const receipt = await this.runtimeService.executeCommand({
      commandId: this.createId(),
      issuedAt: this.now(),
      command: {
        type: "sendUserMessage",
        sessionId: run.parentSessionId,
        messageId: this.createId(),
        content: verdict.response,
        attachments: []
      }
    });
    if (!receipt.accepted) {
      this.takeoverConfigByParentSessionId.delete(run.parentSessionId);
      this.cancelPendingLaunch(run.parentSessionId);
      return;
    }
    if (verdict.verdict === "complete") {
      this.takeoverConfigByParentSessionId.delete(run.parentSessionId);
      this.cancelPendingLaunch(run.parentSessionId);
      return;
    }
    if (verdict.verdict === "incomplete") {
      this.scheduleConfiguredRunAfterParentTurn(run.parentSessionId, cursor);
    }
  }

  private scheduleConfiguredRunAfterParentTurn(
    parentSessionId: string,
    fromCursor: string | undefined
  ): void {
    if (this.pendingLaunchUnsubscribesByParentSessionId.has(parentSessionId)) {
      return;
    }
    const unsubscribe = this.runtimeService.subscribeFromCursor(
      (envelope) => {
        const event = envelope.event;
        if (
          event.type === "turn.completed" &&
          event.sessionId === parentSessionId &&
          !event.turnId.startsWith("user-turn-")
        ) {
          this.cancelPendingLaunch(parentSessionId);
          this.startOrScheduleConfiguredRun(parentSessionId);
        }
      },
      {
        fromCursor,
        filter: {
          sessionId: parentSessionId,
          eventTypes: ["turn.completed"]
        }
      }
    );
    this.pendingLaunchUnsubscribesByParentSessionId.set(parentSessionId, unsubscribe);
  }

  private cancelPendingLaunch(parentSessionId: string): void {
    const unsubscribe = this.pendingLaunchUnsubscribesByParentSessionId.get(parentSessionId);
    if (!unsubscribe) {
      return;
    }
    this.pendingLaunchUnsubscribesByParentSessionId.delete(parentSessionId);
    unsubscribe();
  }

  private async buildHelp(
    topic: TakeoverToolArgs["helpTopic"]
  ): Promise<string> {
    const { rootPath, presets } = await this.presetStore.list();
    const presetLines = this.renderPresetLines(presets);
    const sections: Record<string, string> = {
      overview: `SmartTakeover enables takeover mode for this session. After the parent agent finishes its current response, Another Workbench starts a takeover agent in the same workspace. The takeover agent acts as the user's delegated reviewer or progress manager and reports back through SubmitTakeoverVerdict.

Use action="start" when you need a virtual user to inspect a checkpoint, review your changes, or decide whether a long-running task should continue.`,
      presets: `Preset prompts are read from ${rootPath}. Each preset can be a directory containing prompt.md or another .md file, or a direct .md file.

Available presets:
${presetLines}`,
      brief: `brief should be short, concrete, and situation-specific. Include what you just did, what you want checked, known risks, and what kind of feedback would help you continue.

Use customPrompt only when no preset captures the situation. customPrompt is appended after the preset prompt.`,
      loop: `For review loops, use presetId="review" and pass focusFiles plus successCriteria. If the verdict is incomplete, do the requested work from response; takeover mode will review again after the next completed response while it remains enabled.

For roadmap/progress loops, use presetId="progress" and include the roadmap excerpt or acceptance criteria in brief/successCriteria.`,
      result: `The takeover agent must call SubmitTakeoverVerdict once. verdict="complete" means the takeover passes. verdict="incomplete" means the parent agent should continue working from response. response is the complete virtual-user reply to return to the parent agent.`
    };
    if (topic) {
      return `${sections[topic]}\n\n${sections.result}`;
    }
    return `${sections.overview}

${sections.presets}

${sections.brief}

${sections.loop}

${sections.result}`;
  }

  private renderPresetLines(presets: TakeoverPresetSummaryRpc[]): string {
    if (presets.length === 0) {
      return "- none";
    }
    return presets
      .map(
        (preset) =>
          `- ${preset.presetId}: ${preset.displayName} (${preset.kind}, ${preset.promptPath})`
      )
      .join("\n");
  }

  private composeTakeoverPrompt(input: {
    parentSession: ChatSession;
    takeoverSession: ChatSession;
    workspacePath?: string;
    presetPrompt: string;
    args: TakeoverToolArgs;
    request: SmartTakeoverRequest;
  }): string {
    const successCriteria = input.args.successCriteria?.length
      ? input.args.successCriteria.map((item) => `- ${item}`).join("\n")
      : "- No explicit criteria supplied. Infer concrete acceptance criteria from the brief and workspace state.";
    const focusFiles = input.args.focusFiles?.length
      ? input.args.focusFiles.map((item) => `- ${item}`).join("\n")
      : "- No explicit focus files supplied.";
    return `TAKEOVER_TASK

Parent session id: ${input.parentSession.sessionId}
Takeover session id: ${input.takeoverSession.sessionId}
Workspace: ${input.workspacePath ?? "unknown"}
Requested by engine: ${input.request.requestedBy.engineId}
Source turn id: ${input.request.sourceTurnId ?? "unknown"}

Preset prompt:
${input.presetPrompt.trim()}

${input.args.customPrompt ? `Custom prompt:\n${input.args.customPrompt.trim()}\n` : ""}
Brief:
${input.args.brief?.trim() || "No brief supplied."}

Success criteria:
${successCriteria}

Focus files:
${focusFiles}

Output contract:
Call the SubmitTakeoverVerdict tool exactly once before your final message.
- verdict "complete": the parent agent can stop this loop.
- verdict "incomplete": the parent agent must continue from your response.
- response: the complete virtual-user reply to return to the parent agent.

If the verdict tool is unavailable, include a final line in this exact form:
TAKEOVER_VERDICT: complete|incomplete`;
  }

  private waitForVerdict(input: {
    runId: string;
    takeoverSessionId: string;
    fromCursor?: string;
    timeoutMs: number;
  }): Promise<TakeoverVerdictPayload> {
    return new Promise((resolve, reject) => {
      let finalText: string | undefined;
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (verdict: TakeoverVerdictPayload): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        unsubscribe?.();
        this.finalizeRun(input.runId);
        resolve(verdict);
      };
      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        unsubscribe?.();
        this.finalizeRun(input.runId);
        reject(error);
      };
      const timeout = setTimeout(() => {
        fail(
          new Error(
            `Takeover run ${input.runId} timed out after ${input.timeoutMs}ms.`
          )
        );
      }, input.timeoutMs);
      this.pendingVerdictResolvers.set(input.runId, finish);
      this.pendingVerdictRejecters.set(input.runId, fail);
      unsubscribe = this.runtimeService.subscribeFromCursor(
        (envelope) => {
          const event = envelope.event;
          if (event.type === "message.completed" && event.finalText) {
            if (event.turnId.startsWith("user-turn-")) {
              return;
            }
            finalText = event.finalText;
            return;
          }
          if (event.type === "turn.completed") {
            if (event.turnId.startsWith("user-turn-")) {
              return;
            }
            const fallback = parseFallbackVerdict(finalText);
            if (fallback) {
              finish(fallback);
            }
            return;
          }
          if (event.type === "runtime.error" && !event.recoverable) {
            fail(new Error(event.message));
          }
        },
        {
          fromCursor: input.fromCursor,
          filter: {
            sessionId: input.takeoverSessionId,
            eventTypes: ["message.completed", "turn.completed", "runtime.error"]
          }
        }
      );
    });
  }
}
