import { readFile } from "node:fs/promises";
import type {
  CommandEnvelope,
  ChatSession,
  DomainSnapshot,
  MessageBlock,
  TakeoverPresetSummaryRpc
} from "@another-workbench/shared";
import type { CommandReceipt } from "./runtime-types.js";
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
export type CurrentBranchContext = {
  currentTurnId?: string;
  visibleTurnIds?: string[];
};
type CurrentBranchResolver = (
  sessionId: string
) => CurrentBranchContext | undefined | Promise<CurrentBranchContext | undefined>;

type TakeoverToolArgs = {
  action?: "help" | "start" | "stop";
  helpTopic?: "overview" | "presets" | "loop" | "result";
  presetId?: string;
  context?: string;
  timeoutMs?: number;
};

type TakeoverVerdictPayload = {
  verdict: "complete" | "incomplete";
  response: string;
  sourceTurnId?: string;
};

type TakeoverVerdictSubmission = TakeoverVerdictPayload & {
  complete?: (result: HostToolResult) => void;
};

type TakeoverForwardResult = "forwarded" | "rejected" | "terminal";
type CommandExecutor = (input: CommandEnvelope) => Promise<CommandReceipt>;

type TakeoverRun = {
  runId: string;
  configId: string;
  parentSessionId: string;
  takeoverSessionId?: string;
  presetId: string;
  args: TakeoverToolArgs;
  createdAt: string;
  source: "tool" | "manual";
};

type TakeoverConfig = {
  configId: string;
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
  context?: string;
};

export type SmartTakeoverServiceOptions = {
  runtimeService: WorkbenchRuntimeService;
  presetStore: TakeoverPresetStore;
  executeParentCommand?: CommandExecutor;
  now?: Clock;
  createId?: IdFactory;
  defaultTimeoutMs?: number;
  resolveCurrentBranchContext?: CurrentBranchResolver;
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

const alreadyManagedStartMessage = (sessionId: string): string =>
  `SmartTakeover start failed: session ${sessionId} is already managed. To change presetId or context, call SmartTakeover with action="stop" first, then call action="start" again. Usually a task should call SmartTakeover only once at the beginning; the original global context is reused for later reviews and does not need to be updated. Think carefully about whether restarting takeover is really necessary.`;

const goalConflictMessage = (sessionId: string): string =>
  `SmartTakeover start failed: session ${sessionId} has an active goal. SmartTakeover is mutually exclusive with goals; clear the goal before enabling takeover.`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseTakeoverArgs = (value: unknown): TakeoverToolArgs => {
  if (!isRecord(value)) {
    return {};
  }
  return {
    action:
      value.action === "help" ||
      value.action === "start" ||
      value.action === "stop"
        ? value.action
        : undefined,
    helpTopic:
      value.helpTopic === "overview" ||
      value.helpTopic === "presets" ||
      value.helpTopic === "loop" ||
      value.helpTopic === "result"
        ? value.helpTopic
        : undefined,
    presetId: typeof value.presetId === "string" ? value.presetId : undefined,
    context: typeof value.context === "string" ? value.context : undefined,
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

const isTextMessageBlock = (
  block: MessageBlock
): block is MessageBlock & { text: string } =>
  block.role === "assistant" &&
  (block.kind === "markdown" || block.kind === "plain_text") &&
  typeof block.text === "string" &&
  block.text.trim().length > 0;

const compareIsoDesc = (left?: string, right?: string): number =>
  (right ?? "").localeCompare(left ?? "");

const smartTakeoverHelpOverviewUrl = new URL(
  "./resources/smart-takeover/help-overview.md",
  import.meta.url
);

const renderMessageText = (blocks: MessageBlock[]): string | undefined => {
  const text = blocks
    .filter(isTextMessageBlock)
    .sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) ||
        left.blockId.localeCompare(right.blockId)
    )
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text.length > 0 ? text : undefined;
};

const stripPresetDescMetadata = (prompt: string): string => {
  const normalized = prompt.replace(/^\uFEFF/, "");
  if (!/^desc:\s*.*(?:\r?\n|$)/i.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/^desc:\s*.*(?:\r?\n|$)/i, "");
};

const resolveLatestAgentOutput = (
  snapshot: DomainSnapshot,
  sessionId: string
): string | undefined => {
  const turns = snapshot.turns
    .filter(
      (turn) =>
        turn.sessionId === sessionId &&
        turn.status === "completed" &&
        turn.completedAt
    )
    .sort(
      (left, right) =>
        compareIsoDesc(left.completedAt, right.completedAt) ||
        compareIsoDesc(left.startedAt, right.startedAt)
    );

  for (const turn of turns) {
    if (turn.finalMessageId) {
      const finalText = renderMessageText(
        snapshot.messageBlocks.filter(
          (block) =>
            block.sessionId === sessionId &&
            block.messageId === turn.finalMessageId
        )
      );
      if (finalText) {
        return finalText;
      }
    }

    for (const messageId of [...turn.messageIds].reverse()) {
      const fallbackText = renderMessageText(
        snapshot.messageBlocks.filter(
          (block) =>
            block.sessionId === sessionId && block.messageId === messageId
        )
      );
      if (fallbackText) {
        return fallbackText;
      }
    }
  }

  return undefined;
};

const renderCompletedTurnOutput = (
  snapshot: DomainSnapshot,
  sessionId: string,
  turn: DomainSnapshot["turns"][number] | undefined
): string | undefined => {
  if (!turn || turn.status !== "completed" || !turn.completedAt) {
    return undefined;
  }
  if (turn.finalMessageId) {
    const finalText = renderMessageText(
      snapshot.messageBlocks.filter(
        (block) =>
          block.sessionId === sessionId &&
          block.messageId === turn.finalMessageId
      )
    );
    if (finalText) {
      return finalText;
    }
  }
  for (const messageId of [...turn.messageIds].reverse()) {
    const fallbackText = renderMessageText(
      snapshot.messageBlocks.filter(
        (block) => block.sessionId === sessionId && block.messageId === messageId
      )
    );
    if (fallbackText) {
      return fallbackText;
    }
  }
  return undefined;
};

const resolveAgentOutputForTurn = (
  snapshot: DomainSnapshot,
  sessionId: string,
  turnId: string | undefined
): string | undefined => {
  if (!turnId) {
    return undefined;
  }
  const turn = snapshot.turns.find(
    (item) => item.sessionId === sessionId && item.turnId === turnId
  );
  return renderCompletedTurnOutput(snapshot, sessionId, turn);
};

const resolveAgentOutputForBranch = (
  snapshot: DomainSnapshot,
  sessionId: string,
  branchContext: CurrentBranchContext
): string | undefined => {
  const currentText = resolveAgentOutputForTurn(
    snapshot,
    sessionId,
    branchContext.currentTurnId
  );
  if (currentText) {
    return currentText;
  }

  const visibleTurnIds = new Set(
    (branchContext.visibleTurnIds ?? []).filter((turnId) => turnId.length > 0)
  );
  if (visibleTurnIds.size === 0) {
    return undefined;
  }

  const turns = snapshot.turns
    .filter(
      (turn) =>
        turn.sessionId === sessionId &&
        visibleTurnIds.has(turn.turnId) &&
        turn.status === "completed" &&
        turn.completedAt
    )
    .sort(
      (left, right) =>
        compareIsoDesc(left.completedAt, right.completedAt) ||
        compareIsoDesc(left.startedAt, right.startedAt)
    );

  for (const turn of turns) {
    const text = renderCompletedTurnOutput(snapshot, sessionId, turn);
    if (text) {
      return text;
    }
  }
  return undefined;
};

export class SmartTakeoverService {
  private readonly runtimeService: WorkbenchRuntimeService;
  private readonly presetStore: TakeoverPresetStore;
  private executeParentCommand: CommandExecutor;
  private readonly now: Clock;
  private readonly createId: IdFactory;
  private readonly defaultTimeoutMs: number;
  private readonly resolveCurrentBranchContext?: CurrentBranchResolver;
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
    (verdict: TakeoverVerdictSubmission) => void
  >();
  private readonly pendingVerdictRejecters = new Map<
    string,
    (error: Error) => void
  >();
  private readonly runCleanupById = new Map<string, Set<() => void>>();

  public constructor(options: SmartTakeoverServiceOptions) {
    this.runtimeService = options.runtimeService;
    this.presetStore = options.presetStore;
    this.executeParentCommand =
      options.executeParentCommand ?? ((input) => this.runtimeService.executeCommand(input));
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => createOpaqueId("takeover"));
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10 * 60 * 1000;
    this.resolveCurrentBranchContext = options.resolveCurrentBranchContext;
  }

  public setParentCommandExecutor(executor: CommandExecutor): void {
    this.executeParentCommand = executor;
  }

  public createHostTools(): HostToolRegistration[] {
    return [
      createSmartTakeoverHostTool({
        isAvailable: (context) =>
          !this.isActiveTakeoverRun(context.sessionId) &&
          !this.isActiveParentRun(context.sessionId) &&
          !this.hasThreadGoal(context.sessionId),
        presetIdDescription: () => this.buildPresetIdInputDescription(),
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
    return Boolean(runId && this.runsById.has(runId));
  }

  public isActiveParentRun(sessionId: string): boolean {
    const runId = this.runIdByParentSessionId.get(sessionId);
    return Boolean(runId && this.runsById.has(runId));
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
        active: Boolean(takeoverRunId && this.runsById.has(takeoverRunId)),
        presetId: takeoverRun?.presetId ?? takeoverMetadata.presetId,
        context: takeoverRun?.args.context
      };
    }

    const parentRunId = this.runIdByParentSessionId.get(sessionId);
    const parentRun = parentRunId ? this.runsById.get(parentRunId) : undefined;
    const config = this.takeoverConfigByParentSessionId.get(sessionId);
    if (parentRun || config) {
      return {
        sessionId,
        role: "managed",
        active: Boolean(parentRunId && this.runsById.has(parentRunId)),
        manualPresetId: config?.presetId,
        presetId: parentRun?.presetId ?? config?.presetId,
        takeoverSessionId: parentRun?.takeoverSessionId,
        context: config?.args.context ?? parentRun?.args.context
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
    context?: string;
  }): Promise<TakeoverSessionState> {
    if (!input.presetId) {
      this.disableTakeover(input.sessionId, "Manual takeover was disabled.");
      return this.getSessionState(input.sessionId);
    }

    this.assertNoThreadGoalForTakeover(input.sessionId);
    await this.enableTakeover({
      parentSessionId: input.sessionId,
      args: {
        action: "start",
        presetId: input.presetId,
        context: input.context
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

  private disableTakeover(sessionId: string, reason: string): boolean {
    const hadConfig = this.takeoverConfigByParentSessionId.delete(sessionId);
    this.cancelPendingLaunch(sessionId);
    const activeRunId = this.runIdByParentSessionId.get(sessionId);
    if (activeRunId) {
      this.cancelRun(activeRunId, reason);
    }
    return hadConfig || Boolean(activeRunId);
  }

  private interruptTakeoverRun(runId: string, reason: string): void {
    const run = this.runsById.get(runId);
    if (!run?.takeoverSessionId) {
      return;
    }
    const snapshot = this.runtimeService.getSnapshot();
    const takeoverSession = this.runtimeService.getSession(run.takeoverSessionId);
    const activeTurn =
      (takeoverSession?.lastTurnId
        ? snapshot.turns.find(
            (turn) =>
              turn.sessionId === run.takeoverSessionId &&
              turn.turnId === takeoverSession.lastTurnId &&
              turn.status !== "completed"
          )
        : undefined) ??
      snapshot.turns
        .filter(
          (turn) =>
            turn.sessionId === run.takeoverSessionId &&
            turn.status !== "completed"
        )
        .sort(
          (left, right) =>
            compareIsoDesc(left.startedAt, right.startedAt) ||
            right.turnId.localeCompare(left.turnId)
        )[0];
    if (!activeTurn) {
      return;
    }
    void this.runtimeService
      .executeCommand({
        commandId: this.createId(),
        issuedAt: this.now(),
        command: {
          type: "interruptTurn",
          sessionId: run.takeoverSessionId,
          turnId: activeTurn.turnId,
          reason
        }
      })
      .catch(() => undefined);
  }

  private hasThreadGoal(sessionId: string): boolean {
    const snapshot = this.runtimeService.getSnapshot?.();
    return (snapshot?.threadGoals ?? []).some(
      (goal) => goal.sessionId === sessionId
    );
  }

  private assertNoThreadGoalForTakeover(sessionId: string): void {
    if (this.hasThreadGoal(sessionId)) {
      throw new Error(goalConflictMessage(sessionId));
    }
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
    const cleanups = this.runCleanupById.get(runId);
    if (cleanups) {
      this.runCleanupById.delete(runId);
      for (const cleanup of cleanups) {
        cleanup();
      }
    }
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

  private registerRunCleanup(runId: string, cleanup: () => void): () => void {
    let cleanups = this.runCleanupById.get(runId);
    if (!cleanups) {
      cleanups = new Set();
      this.runCleanupById.set(runId, cleanups);
    }
    cleanups.add(cleanup);
    return () => {
      const current = this.runCleanupById.get(runId);
      current?.delete(cleanup);
      if (current?.size === 0) {
        this.runCleanupById.delete(runId);
      }
    };
  }

  private isRunCurrent(run: TakeoverRun): boolean {
    const config = this.takeoverConfigByParentSessionId.get(run.parentSessionId);
    return (
      this.runsById.get(run.runId) === run &&
      this.runIdByParentSessionId.get(run.parentSessionId) === run.runId &&
      config?.configId === run.configId
    );
  }

  private cancelRun(runId: string, reason: string): void {
    this.interruptTakeoverRun(runId, reason);
    const rejecter = this.pendingVerdictRejecters.get(runId);
    if (rejecter) {
      rejecter(new Error(reason));
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
    if (args.action === "help" || (!args.action && !args.presetId)) {
      return textResult(await this.buildHelp(args.helpTopic));
    }
    try {
      if (args.action === "stop") {
        const disabled = this.disableTakeover(
          request.parentSessionId,
          "SmartTakeover was disabled by the managed agent."
        );
        return textResult(
          disabled
            ? `SmartTakeover disabled for session ${request.parentSessionId}.`
            : `SmartTakeover is not enabled for session ${request.parentSessionId}.`
        );
      }

      if (!args.presetId) {
        return textResult(
          "SmartTakeover start failed: presetId is required. Choose one of the available takeover presets and pass its presetId explicitly.",
          false
        );
      }

      if (this.hasThreadGoal(request.parentSessionId)) {
        return textResult(goalConflictMessage(request.parentSessionId), false);
      }

      const existingConfig = this.takeoverConfigByParentSessionId.get(
        request.parentSessionId
      );
      if (
        existingConfig &&
        existingConfig.presetId === args.presetId &&
        existingConfig.args.context === args.context
      ) {
        return textResult(
          `SmartTakeover is already enabled for session ${request.parentSessionId}. It will run after the current response is complete.`
        );
      }

      if (existingConfig) {
        return textResult(
          alreadyManagedStartMessage(request.parentSessionId),
          false
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
    return await new Promise<HostToolResult>((resolve) => {
      let settled = false;
      let unregister = (): void => undefined;
      const complete = (result: HostToolResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        unregister();
        resolve(result);
      };
      unregister = this.registerRunCleanup(runId, () => {
        complete(
          textResult(
            `SubmitTakeoverVerdict failed: takeover run ${runId} was cancelled before the verdict could be forwarded.`,
            false
          )
        );
      });
      resolver({
        ...verdict,
        sourceTurnId: request.sourceTurnId,
        complete
      });
    });
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
    this.cancelPendingLaunch(parentSession.sessionId);
    if (existingRunId) {
      this.cancelRun(
        existingRunId,
        existingRun?.presetId === presetId
          ? "Takeover was reconfigured."
          : "Takeover preset changed."
      );
    }
    this.takeoverConfigByParentSessionId.set(parentSession.sessionId, {
      configId: createOpaqueId("takeover-config"),
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
    this.startOrScheduleConfiguredRun(parentSession.sessionId);
    return `SmartTakeover enabled for session ${parentSession.sessionId}. It will run after the current response is complete.`;
  }

  private async launchTakeover(
    request: SmartTakeoverRequest,
    args: TakeoverToolArgs,
    configId: string,
    source: TakeoverRun["source"],
    shouldContinue: () => boolean = () => true
  ): Promise<{
    runId: string;
    run: TakeoverRun;
    takeoverSession: ChatSession;
    verdictPromise: Promise<TakeoverVerdictSubmission>;
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
    const hasBranchResolver = Boolean(this.resolveCurrentBranchContext);
    const branchContext = hasBranchResolver
      ? await Promise.resolve(
          this.resolveCurrentBranchContext?.(parentSession.sessionId)
        ).catch(() => ({}))
      : undefined;
    const snapshot = this.runtimeService.getSnapshot();
    const agentOutput = hasBranchResolver
      ? resolveAgentOutputForBranch(
          snapshot,
          parentSession.sessionId,
          branchContext ?? {}
        )
      : resolveLatestAgentOutput(snapshot, parentSession.sessionId);
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
    if (existingRunId) {
      throw new Error(
        `Takeover is already active for session ${parentSession.sessionId}.`
      );
    }

    const runId = this.createId();
    const run: TakeoverRun = {
      runId,
      configId,
      parentSessionId: parentSession.sessionId,
      presetId,
      args,
      createdAt: this.now(),
      source
    };
    this.runsById.set(runId, run);
    this.runIdByParentSessionId.set(parentSession.sessionId, runId);

    let verdictPromise: Promise<TakeoverVerdictSubmission> | undefined;
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
        fromCursor: cursor
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
              agentOutput,
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
    let launchedRun: TakeoverRun | undefined;
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
        config.configId,
        config.source,
        isCurrentConfig
      );
      launchedRun = launch.run;
      if (!isCurrentConfig() || !this.isRunCurrent(launch.run)) {
        this.cancelRun(launch.run.runId, "Takeover was reconfigured.");
        return;
      }
      let verdict = await launch.verdictPromise;
      for (;;) {
        if (!isCurrentConfig() || !this.isRunCurrent(launch.run)) {
          verdict.complete?.(
            textResult(
              "SubmitTakeoverVerdict failed: takeover was reconfigured before the verdict could be forwarded.",
              false
            )
          );
          return;
        }
        if (
          verdict.sourceTurnId &&
          !verdict.complete &&
          launch.run.takeoverSessionId
        ) {
          await this.waitForTakeoverTurnCompletion({
            run: launch.run,
            takeoverSessionId: launch.run.takeoverSessionId,
            turnId: verdict.sourceTurnId,
            timeoutMs: launch.run.args.timeoutMs ?? this.defaultTimeoutMs
          });
        }
        if (!isCurrentConfig() || !this.isRunCurrent(launch.run)) {
          verdict.complete?.(
            textResult(
              "SubmitTakeoverVerdict failed: takeover was reconfigured before the verdict could be forwarded.",
              false
            )
          );
          return;
        }
        const forwarded = await this.forwardTakeoverVerdictToParent(launch.run, verdict);
        verdict.complete?.(
          forwarded === "forwarded"
            ? textResult(`Takeover verdict forwarded: ${verdict.verdict}.`)
            : forwarded === "rejected"
              ? textResult(
                  "SubmitTakeoverVerdict failed: parent runtime rejected the feedback after local transcript echo. The verdict was not retried to avoid duplicating the parent transcript.",
                  false
                )
              : textResult(
                  "SubmitTakeoverVerdict failed: takeover was no longer current before the verdict could be forwarded.",
                  false
                )
        );
        if (forwarded === "rejected" && this.isRunCurrent(launch.run)) {
          this.takeoverConfigByParentSessionId.delete(parentSessionId);
          this.cancelPendingLaunch(parentSessionId);
        }
        this.finalizeRun(launch.run.runId);
        return;
      }
    } catch (error) {
      if (this.takeoverConfigByParentSessionId.get(parentSessionId) === config) {
        const currentRunId = this.runIdByParentSessionId.get(parentSessionId);
        const currentRun = currentRunId ? this.runsById.get(currentRunId) : undefined;
        console.warn("[another-workbench] SmartTakeover run failed; disabling takeover.", {
          parentSessionId,
          runId: launchedRun?.runId ?? currentRunId,
          takeoverSessionId:
            launchedRun?.takeoverSessionId ?? currentRun?.takeoverSessionId,
          presetId: config.presetId,
          source: config.source,
          sourceTurnId: config.sourceTurnId,
          sourceToolCallId: config.sourceToolCallId,
          reason: error instanceof Error ? error.message : String(error)
        });
        this.takeoverConfigByParentSessionId.delete(parentSessionId);
        this.cancelPendingLaunch(parentSessionId);
        if (currentRunId) {
          this.cancelRun(currentRunId, (error as Error).message);
        }
      }
    }
  }

  private async forwardTakeoverVerdictToParent(
    run: TakeoverRun,
    verdict: TakeoverVerdictPayload
  ): Promise<TakeoverForwardResult> {
    const config = this.takeoverConfigByParentSessionId.get(run.parentSessionId);
    if (!this.isRunCurrent(run)) {
      console.warn("[another-workbench] SmartTakeover verdict was not forwarded: config mismatch.", {
        parentSessionId: run.parentSessionId,
        runId: run.runId,
        takeoverSessionId: run.takeoverSessionId,
        runPresetId: run.presetId,
        runConfigId: run.configId,
        configPresetId: config?.presetId,
        configId: config?.configId,
        currentRunId: this.runIdByParentSessionId.get(run.parentSessionId)
      });
      return "terminal";
    }
    const parentSession = this.runtimeService.getSession(run.parentSessionId);
    if (!parentSession) {
      console.warn("[another-workbench] SmartTakeover verdict was not forwarded: parent session missing.", {
        parentSessionId: run.parentSessionId,
        runId: run.runId,
        takeoverSessionId: run.takeoverSessionId,
        presetId: run.presetId
      });
      this.takeoverConfigByParentSessionId.delete(run.parentSessionId);
      this.cancelPendingLaunch(run.parentSessionId);
      return "terminal";
    }
    if (!this.isRunCurrent(run)) {
      return "terminal";
    }
    const cursor = this.runtimeService.getSnapshotResult().cursor;
    const receipt = await this.executeParentCommand({
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
    if (!this.isRunCurrent(run)) {
      console.warn("[another-workbench] SmartTakeover verdict result was ignored: run is no longer current.", {
        parentSessionId: run.parentSessionId,
        runId: run.runId,
        takeoverSessionId: run.takeoverSessionId,
        presetId: run.presetId,
        runConfigId: run.configId,
        currentRunId: this.runIdByParentSessionId.get(run.parentSessionId),
        commandId: receipt.commandId,
        commandType: receipt.commandType
      });
      return "terminal";
    }
    if (!receipt.accepted) {
      console.warn("[another-workbench] SmartTakeover verdict was not forwarded: parent runtime rejected feedback.", {
        parentSessionId: run.parentSessionId,
        runId: run.runId,
        takeoverSessionId: run.takeoverSessionId,
        presetId: run.presetId,
        commandId: receipt.commandId,
        commandType: receipt.commandType
      });
      return "rejected";
    }
    if (verdict.verdict === "complete") {
      if (this.isRunCurrent(run)) {
        this.takeoverConfigByParentSessionId.delete(run.parentSessionId);
      }
      this.cancelPendingLaunch(run.parentSessionId);
      return "forwarded";
    }
    if (verdict.verdict === "incomplete") {
      if (this.isRunCurrent(run)) {
        this.scheduleConfiguredRunAfterParentTurn(run.parentSessionId, cursor);
      }
    }
    return "forwarded";
  }

  private async waitForTakeoverTurnCompletion(input: {
    run: TakeoverRun;
    takeoverSessionId: string;
    turnId: string;
    timeoutMs: number;
  }): Promise<void> {
    if (!this.isRunCurrent(input.run)) {
      throw new Error("Takeover run was cancelled.");
    }
    const snapshotResult = this.runtimeService.getSnapshotResult();
    if (
      snapshotResult.snapshot.turns.some(
        (turn) =>
          turn.sessionId === input.takeoverSessionId &&
          turn.turnId === input.turnId &&
          turn.status === "completed"
      )
    ) {
      return;
    }

    let unsubscribe: (() => void) | undefined;
    let unregisterCleanup = (): void => undefined;
    const completion = new Promise<void>((resolve, reject) => {
      unregisterCleanup = this.registerRunCleanup(input.run.runId, () => {
        reject(new Error("Takeover run was cancelled."));
      });
      unsubscribe = this.runtimeService.subscribeFromCursor(
        (envelope) => {
          const event = envelope.event;
          if (
            event.type === "turn.completed" &&
            event.sessionId === input.takeoverSessionId &&
            event.turnId === input.turnId
          ) {
            resolve();
          }
        },
        {
          fromCursor: snapshotResult.cursor,
          filter: {
            sessionId: input.takeoverSessionId,
            eventTypes: ["turn.completed"]
          }
        }
      );
    });
    try {
      await this.withTimeout(
        completion,
        input.timeoutMs,
        `Takeover turn ${input.turnId} did not complete within ${input.timeoutMs}ms.`
      );
    } finally {
      unregisterCleanup();
      unsubscribe?.();
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
    const overview = (await readFile(smartTakeoverHelpOverviewUrl, "utf8")).trim();
    const presetLines = this.renderPresetLines(presets);
    const sections: Record<NonNullable<TakeoverToolArgs["helpTopic"]>, string> = {
      overview,
      presets: `Preset prompts are read from ${rootPath}. Each preset can be a directory containing prompt.md or another .md file, or a direct .md file.

Available presets:
${presetLines}`,
      loop: `For review loops, use presetId="review". If the verdict is incomplete, do the requested work from response; takeover mode will review again after the next completed response while it remains enabled.

For roadmap/progress loops, use presetId="progress". Put scenario-specific review standards in the preset prompt.`,
      result: `The takeover agent must call SubmitTakeoverVerdict once. verdict="complete" accepts the current state and ends takeover. verdict="incomplete" sends response back as the user's next reply so the agent continues. The managed agent may call SmartTakeover with action="stop" to disable takeover when further review loops are no longer useful.`
    };
    if (topic) {
      return `${sections[topic]}\n\n${sections.result}`;
    }
    return `${sections.overview}

${sections.presets}

${sections.loop}

${sections.result}`;
  }

  private async buildPresetIdInputDescription(): Promise<string> {
    const { rootPath, presets } = await this.presetStore.list();
    return [
      `Preset prompt name from ${rootPath}. Required when action is start or omitted to start takeover; not needed for help or stop.`,
      "",
      "Available presets:",
      this.renderPresetDescriptionLines(presets)
    ].join("\n");
  }

  private renderPresetLines(presets: TakeoverPresetSummaryRpc[]): string {
    if (presets.length === 0) {
      return "- none";
    }
    return presets
      .map(
        (preset) =>
          `- ${preset.presetId}: ${preset.desc ?? preset.displayName} (${preset.kind}, ${preset.promptPath})`
      )
      .join("\n");
  }

  private renderPresetDescriptionLines(presets: TakeoverPresetSummaryRpc[]): string {
    if (presets.length === 0) {
      return "- none";
    }
    return presets
      .map((preset) => `- ${preset.presetId}: ${preset.desc ?? preset.displayName}`)
      .join("\n");
  }

  private composeTakeoverPrompt(input: {
    parentSession: ChatSession;
    takeoverSession: ChatSession;
    workspacePath?: string;
    presetPrompt: string;
    agentOutput?: string;
    args: TakeoverToolArgs;
    request: SmartTakeoverRequest;
  }): string {
    const presetInstructions = stripPresetDescMetadata(input.presetPrompt).trim();
    const sections = [`Preset instructions:\n${presetInstructions}`];

    if (input.args.context?.trim()) {
      sections.push(`Task context:\n${input.args.context.trim()}`);
    }

    if (input.agentOutput?.trim()) {
      sections.push(`Agent output:\n${input.agentOutput.trim()}`);
    }

    sections.push(`Verdict contract:
Call the SubmitTakeoverVerdict tool exactly once before your final message.
- verdict "complete": accept the current state and end takeover.
- verdict "incomplete": send your response as the user's next reply so the agent continues.
- response: the complete user-facing reply to send back to the agent.

If the verdict tool is unavailable, include a final line in this exact form:
TAKEOVER_VERDICT: complete|incomplete`);

    return sections.join("\n\n");
  }

  private waitForVerdict(input: {
    runId: string;
    takeoverSessionId: string;
    fromCursor?: string;
  }): Promise<TakeoverVerdictSubmission> {
    return new Promise((resolve, reject) => {
      let finalText: string | undefined;
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (verdict: TakeoverVerdictSubmission): void => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribe?.();
        this.pendingVerdictResolvers.delete(input.runId);
        this.pendingVerdictRejecters.delete(input.runId);
        resolve(verdict);
      };
      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribe?.();
        this.finalizeRun(input.runId);
        reject(error);
      };
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
