import type { CodexAppServerRuntimePort } from "./codex-app-server-runtime-port.js";
import { createFilePathTarget } from "./file-path-target.js";
import {
  codexProviderKind,
  discoveredCodexSessionId,
  resolveCodexThreadId
} from "./codex-session-identity.js";
import {
  buildConversationMap,
  discoveredConversationId,
  type DiscoveredSessionRelation,
  type DiscoveredSessionRecord
} from "./session-discovery.js";
import type {
  SessionAgentActionsProvider,
  SessionActionDescriptor,
  SessionActionKind,
  SessionActionProviderContext,
  SessionActionResult
} from "./session-actions.js";

const isoFromUnixSeconds = (value: number): string =>
  new Date(value * 1_000).toISOString();

const isMissingRolloutError = (error: unknown, threadId: string): boolean =>
  error instanceof Error &&
  error.message.includes(`no rollout found for thread id ${threadId}`);

const resolveWorkspaceId = (
  input: SessionActionProviderContext
): string | undefined => {
  if (input.indexEntry?.workspaceId) {
    return input.indexEntry.workspaceId;
  }
  const conversationId = input.session?.conversationId;
  if (!conversationId) {
    return undefined;
  }
  return input.runtimeService
    .getSnapshot()
    .conversations.find((conversation) => conversation.conversationId === conversationId)
    ?.workspaceId;
};

const buildForkMetadata = (
  input: SessionActionProviderContext,
  providerSessionId: string,
  thread?: { cwd?: string; path?: string | null }
): Record<string, unknown> => ({
  ...(input.session?.metadata ?? {}),
  providerKind: codexProviderKind,
  providerSessionId,
  cwd: thread?.cwd ?? input.session?.metadata?.cwd,
  rolloutPath: thread?.path ?? input.session?.metadata?.rolloutPath
});

const resolveForkTitle = (thread: { id: string; name?: string | null; preview?: string | null }): string => {
  const name = thread.name?.trim();
  if (name) {
    return name;
  }
  const preview = thread.preview
    ?.split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return preview || discoveredCodexSessionId(thread.id);
};

const isTreeRelationType = (
  relationType: string
): relationType is DiscoveredSessionRelation["relationType"] =>
  relationType === "fork" || relationType === "subagent";

const resolveForkConversationId = (input: {
  childSession: DiscoveredSessionRecord;
  parentSessionId: string;
  workspaceId: string;
  sessionIndexStore: SessionActionProviderContext["sessionIndexStore"];
  createdAt: string;
}): string => {
  const relations: DiscoveredSessionRelation[] = [];
  for (const relation of input.sessionIndexStore.listRelations(input.workspaceId)) {
    if (!isTreeRelationType(relation.relationType)) {
      continue;
    }
    relations.push({
      parentSessionId: relation.parentSessionId,
      childSessionId: relation.childSessionId,
      relationType: relation.relationType,
      createdAt: relation.createdAt
    });
  }
  relations.push({
    parentSessionId: input.parentSessionId,
    childSessionId: input.childSession.sessionId,
    relationType: "fork",
    createdAt: input.createdAt
  });
  return (
    buildConversationMap([input.childSession], relations).get(input.childSession.sessionId) ??
    discoveredConversationId(input.childSession.sessionId)
  );
};

export class CodexSessionActionsProvider implements SessionAgentActionsProvider {
  public readonly engineId = "codex";

  private readonly codexRuntimePort: CodexAppServerRuntimePort;

  public constructor(options: { codexRuntimePort: CodexAppServerRuntimePort }) {
    this.codexRuntimePort = options.codexRuntimePort;
  }

  public resolveDisplayedSessionId(input: SessionActionProviderContext): string | undefined {
    return resolveCodexThreadId(input);
  }

  public async listAdditionalActions(
    input: SessionActionProviderContext
  ): Promise<SessionActionDescriptor[]> {
    const threadId = resolveCodexThreadId(input);
    const workspaceId = resolveWorkspaceId(input);
    return [
      {
        action: "fork",
        label: "Fork",
        disabled: !threadId || !workspaceId,
        reason: !threadId
          ? "Fork is not available until the Codex thread is created."
          : !workspaceId
            ? "Fork is not available without a workspace context."
            : undefined
      },
      {
        action: "open_rollout",
        label: "Open rollout",
        disabled: !threadId,
        reason: threadId ? undefined : "Rollout is not available until the thread is created."
      }
    ];
  }

  public async prepareArchive(input: SessionActionProviderContext): Promise<void> {
    const threadId = resolveCodexThreadId(input);
    if (!threadId) {
      throw new Error("Archive is unavailable without a provider session id.");
    }
    try {
      await this.codexRuntimePort.archiveThread(threadId);
    } catch (error) {
      if (!isMissingRolloutError(error, threadId)) {
        throw error;
      }
    }
  }

  public async runAction(
    input: SessionActionProviderContext & { action: SessionActionKind }
  ): Promise<SessionActionResult | undefined> {
    const threadId = resolveCodexThreadId(input);

    if (input.action === "refresh") {
      await this.codexRuntimePort.reloadUserConfig();
      await this.codexRuntimePort.reloadMcpServers();
      await this.codexRuntimePort.listSkills({
        forceReload: true
      });
      return {
        action: "refresh",
        refreshed: true,
        details: "Reloaded user config, refreshed skills, and queued MCP server reloads for loaded Codex threads."
      };
    }

    if (input.action === "resume") {
      if (!threadId) {
        throw new Error("Resume is unavailable without a provider thread id.");
      }
      await this.codexRuntimePort.interruptThread(threadId, {
        bestEffort: true
      });
      await this.codexRuntimePort.unsubscribeThread(threadId);
      const thread = await this.codexRuntimePort.resumeThread(threadId);
      this.codexRuntimePort.attachThreadToSession(input.sessionId, thread.id);
      return {
        action: "resume",
        resumed: true
      };
    }

    if (input.action === "fork") {
      if (!threadId) {
        throw new Error("Fork is unavailable without a provider thread id.");
      }
      const workspaceId = resolveWorkspaceId(input);
      if (!workspaceId) {
        throw new Error("Fork is unavailable without a workspace context.");
      }
      const thread = await this.codexRuntimePort.forkThread(threadId);
      const childSessionId = discoveredCodexSessionId(thread.id);
      const createdAt = isoFromUnixSeconds(thread.createdAt);
      const updatedAt = isoFromUnixSeconds(thread.updatedAt);
      const childSessionRecord: DiscoveredSessionRecord = {
        sessionId: childSessionId,
        engineId: input.engineId ?? this.engineId,
        providerKind: codexProviderKind,
        providerSessionId: thread.id,
        title: resolveForkTitle(thread),
        summaryText: thread.preview?.trim() || undefined,
        createdAt,
        updatedAt,
        metadata: buildForkMetadata(input, thread.id, thread)
      };
      const conversationId = resolveForkConversationId({
        childSession: childSessionRecord,
        parentSessionId: input.sessionId,
        workspaceId,
        sessionIndexStore: input.sessionIndexStore,
        createdAt
      });
      this.codexRuntimePort.attachThreadToSession(childSessionId, thread.id);
      await input.sessionIndexStore.upsertSession({
        workspaceId,
        session: {
          sessionId: childSessionId,
          conversationId,
          engineId: childSessionRecord.engineId,
          title: childSessionRecord.title,
          createdAt,
          updatedAt,
          lastTurnId: thread.turns.at(-1)?.id,
          metadata: childSessionRecord.metadata
        },
        providerKind: childSessionRecord.providerKind,
        providerSessionId: childSessionRecord.providerSessionId,
        summaryText: childSessionRecord.summaryText,
        source: "discovery"
      });
      await input.sessionIndexStore.upsertRelation({
        workspaceId,
        parentSessionId: input.sessionId,
        childSessionId,
        relationType: "fork",
        createdAt
      });
      await input.runtimeService.getWorkspaceRegistry()?.setLastActiveSelection({
        workspaceId,
        sessionId: childSessionId
      });
      return {
        action: "fork",
        status: "forked",
        forkedSessionId: childSessionId,
        providerSessionId: thread.id
      };
    }

    if (input.action !== "open_rollout") {
      return undefined;
    }

    if (!threadId) {
      throw new Error("Rollout path is unavailable before the thread is created.");
    }
    const thread = await this.codexRuntimePort.readThread(threadId, false);
    if (!thread.path) {
      throw new Error("Codex thread does not expose a rollout path.");
    }
    const rolloutTarget = createFilePathTarget(thread.path);
    return {
      action: "open_rollout",
      rolloutPath: thread.path,
      rolloutDisplayPath: rolloutTarget.displayPath,
      rolloutFileUrl: rolloutTarget.fileUrl
    };
  }
}
