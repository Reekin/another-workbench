import { z } from "zod";
import {
  zAgentId,
  zConversationId,
  zCursor,
  zJsonRecord,
  zRequestId,
  zSessionId,
  zTurnId
} from "./common.js";
import { commandTypes, zCommandEnvelopeSchema } from "./commands.js";
import { zChatSessionSchema, zDomainSnapshotSchema } from "./domain.js";
import {
  zEngineDefinitionRpcSchema,
  zEngineSurfaceRpcSchema
} from "./engine-control.js";
import { eventTypes, zEventEnvelopeSchema } from "./events.js";
import {
  zSessionExecutionProfileInputSchema,
  zSessionExecutionProfileSchema
} from "./session-profile.js";

export const workbenchRpcMethods = [
  "engine.list",
  "engine.getSurface",
  "agent.list",
  "agent.select",
  "settings.get",
  "settings.update",
  "domain.snapshot",
  "session.list",
  "workspace.list",
  "workspace.pickDirectory",
  "workspace.add",
  "workspace.remove",
  "workspace.toggleExpanded",
  "workspace.select",
  "sessionBrowser.listTree",
  "sessionBrowser.reconcile",
  "sessionBrowser.toggleExpanded",
  "sessionBrowser.create",
  "sessionBrowser.open",
  "sessionBrowser.loadOlder",
  "sessionBrowser.getActions",
  "sessionBrowser.runAction",
  "chatTree.get",
  "chatTree.jump",
  "delegation.get",
  "worktree.get",
  "checkpoint.get",
  "diagnostics.get",
  "backgroundRun.get",
  "file.searchWorkspace",
  "file.getPreview",
  "file.runAction",
  "codex.turnChanges.get",
  "codex.turnChanges.undo",
  "runtime.command",
  "events.subscribe",
  "events.unsubscribe",
  "events.replay"
] as const;

export type WorkbenchRpcMethod = (typeof workbenchRpcMethods)[number];

const zWorkbenchEventType = z.enum(eventTypes);
const zWorkbenchCommandType = z.enum(commandTypes);

const zAgentDescriptorSchema = z.object({
  agentId: zAgentId,
  displayName: z.string().min(1),
  capabilities: z.array(z.string().min(1)).default([])
});

const zWorkspaceRecordSchema = z.object({
  workspaceId: z.string().min(1),
  absolutePath: z.string().min(1),
  label: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

const zWorkbenchSettingsSchema = z.object({
  defaultNewSessionEngineId: z.string().min(1).optional()
});

const zSessionStatusDotSchema = z.enum(["none", "running", "unread_completed"]);

export const zProviderSessionHandleSchema = z.object({
  providerKind: z.string().min(1),
  providerSessionId: z.string().min(1)
});

const zSessionBrowserNodeSchema: z.ZodType = z.lazy(() =>
  z.object({
    sessionId: zSessionId,
    displaySessionId: z.string().min(1),
    providerSessionId: z.string().min(1).optional(),
    providerHandle: zProviderSessionHandleSchema.optional(),
    workspaceId: z.string().min(1),
    conversationId: zConversationId.optional(),
    agentId: zAgentId,
    title: z.string().min(1),
    summaryText: z.string().min(1).optional(),
    statusDot: zSessionStatusDotSchema,
    isExpanded: z.boolean(),
    isActive: z.boolean(),
    isArchived: z.boolean(),
    parentSessionId: zSessionId.optional(),
    children: z.array(zSessionBrowserNodeSchema).default([]),
    updatedAt: z.string().min(1)
  })
);

const zWorkspaceBrowserNodeSchema = z.object({
  workspaceId: z.string().min(1),
  label: z.string().min(1),
  rootPath: z.string().min(1),
  isExpanded: z.boolean(),
  isActive: z.boolean(),
  sessions: z.array(zSessionBrowserNodeSchema).default([])
});

const zSessionActionKindSchema = z.enum([
  "archive",
  "copy_session_id",
  "open_rollout",
  "reload"
]);

const zSessionActionDescriptorSchema = z.object({
  action: zSessionActionKindSchema,
  label: z.string().min(1),
  disabled: z.boolean().optional(),
  reason: z.string().min(1).optional()
});

const zSessionActionResultSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("archive"),
    archived: z.literal(true)
  }),
  z.object({
    action: z.literal("copy_session_id"),
    copiedText: z.string().min(1)
  }),
  z.object({
    action: z.literal("open_rollout"),
    rolloutPath: z.string().min(1),
    rolloutDisplayPath: z.string().min(1),
    rolloutFileUrl: z.string().url()
  }),
  z.object({
    action: z.literal("reload"),
    resumed: z.literal(true)
  })
]);

const zChatTreeNodeSchema = z.object({
  nodeId: z.string().min(1),
  parentNodeId: z.string().min(1).optional(),
  label: z.string().min(1),
  turnId: zTurnId.optional(),
  order: z.number().int(),
  isCurrent: z.boolean()
});

const zConversationGraphNodeSchema = zChatTreeNodeSchema.extend({
  providerNodeId: z.string().min(1).optional(),
  summary: z.string().min(1).optional()
});

const zConversationGraphSnapshotSchema = z.object({
  sessionId: zSessionId,
  agentId: zAgentId,
  supportsJump: z.boolean(),
  currentNodeId: z.string().min(1).optional(),
  nodes: z.array(zConversationGraphNodeSchema).default([]),
  fetchedAt: z.string().min(1)
});

const zChatTreeSnapshotSchema = z.object({
  sessionId: zSessionId,
  agentId: zAgentId,
  supportsJump: z.boolean(),
  currentNodeId: z.string().min(1).optional(),
  nodes: z.array(zChatTreeNodeSchema).default([]),
  fetchedAt: z.string().min(1)
});

const zDelegationNodeSchema = z.object({
  nodeId: z.string().min(1),
  providerNodeId: z.string().min(1).optional(),
  label: z.string().min(1),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  role: z.enum(["root", "delegate"]),
  parentNodeId: z.string().min(1).optional(),
  linkedSessionId: zSessionId.optional(),
  summary: z.string().min(1).optional(),
  startedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional()
});

const zDelegationEdgeSchema = z.object({
  edgeId: z.string().min(1),
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  relation: z.enum(["spawn", "handoff", "wait", "resume"])
});

const zDelegationSnapshotSchema = z.object({
  sessionId: zSessionId,
  agentId: zAgentId,
  supported: z.boolean(),
  supportsControl: z.boolean(),
  currentActiveNodeId: z.string().min(1).optional(),
  nodes: z.array(zDelegationNodeSchema).default([]),
  edges: z.array(zDelegationEdgeSchema).default([]),
  fetchedAt: z.string().min(1)
});

const zWorktreeSnapshotSchema = z.object({
  sessionId: zSessionId,
  agentId: zAgentId,
  supported: z.boolean(),
  workspaceRoot: z.string().min(1).optional(),
  rolloutPath: z.string().min(1).optional(),
  gitBranch: z.string().min(1).optional(),
  gitSha: z.string().min(1).optional(),
  gitOriginUrl: z.string().min(1).optional(),
  diffToRemoteSha: z.string().min(1).optional(),
  diffToRemote: z.string().optional(),
  fetchedAt: z.string().min(1)
});

const zCheckpointEntrySchema = z.object({
  checkpointId: z.string().min(1),
  providerCheckpointId: z.string().min(1).optional(),
  label: z.string().min(1),
  summary: z.string().min(1).optional(),
  turnId: zTurnId.optional(),
  order: z.number().int(),
  isCurrent: z.boolean()
});

const zCheckpointSnapshotSchema = z.object({
  sessionId: zSessionId,
  agentId: zAgentId,
  supported: z.boolean(),
  supportsRestore: z.boolean(),
  currentCheckpointId: z.string().min(1).optional(),
  checkpoints: z.array(zCheckpointEntrySchema).default([]),
  fetchedAt: z.string().min(1)
});

const zDiagnosticsSnapshotSchema = z.object({
  sessionId: zSessionId,
  agentId: zAgentId,
  supported: z.boolean(),
  authenticated: z.boolean(),
  authMethod: z.string().min(1).nullable().optional(),
  requiresOpenaiAuth: z.boolean().nullable().optional(),
  gitBranch: z.string().min(1).optional(),
  gitSha: z.string().min(1).optional(),
  diffToRemoteSha: z.string().min(1).optional(),
  diffToRemote: z.string().optional(),
  summaryText: z.string().min(1).optional(),
  fetchedAt: z.string().min(1)
});

const zBackgroundRunSnapshotSchema = z.object({
  sessionId: zSessionId,
  agentId: zAgentId,
  supported: z.boolean(),
  status: z.enum(["unsupported", "attached", "detached"]),
  resumeToken: z.string().min(1).optional(),
  fetchedAt: z.string().min(1)
});

const zSessionWindowSchema = z.object({
  sessionId: zSessionId,
  snapshot: zDomainSnapshotSchema,
  windowStartTurnId: zTurnId.optional(),
  windowEndTurnId: zTurnId.optional(),
  hasOlder: z.boolean(),
  hasNewer: z.boolean()
});

const zFileReferenceSchema = z.object({
  path: z.string().min(1),
  displayPath: z.string().min(1),
  fileUrl: z.string().min(1),
  label: z.string().min(1),
  fileName: z.string().min(1),
  extension: z.string().min(1).optional(),
  isImage: z.boolean(),
  source: z.enum(["markdown_link", "markdown_image", "inline_path"])
});

const zWorkspaceFileSearchResultSchema = zFileReferenceSchema.extend({
  workspaceId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  relativePath: z.string().min(1),
  matchScore: z.number()
});

const zFilePreviewSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("image"),
    target: zFileReferenceSchema,
    exists: z.boolean(),
    fileSizeBytes: z.number().int().nonnegative().optional(),
    mimeType: z.string().min(1).optional(),
    imageUrl: z.string().min(1)
  }),
  z.object({
    kind: z.literal("text"),
    target: zFileReferenceSchema,
    exists: z.boolean(),
    fileSizeBytes: z.number().int().nonnegative().optional(),
    mimeType: z.string().min(1).optional(),
    text: z.string(),
    truncated: z.boolean(),
    lineCount: z.number().int().nonnegative()
  }),
  z.object({
    kind: z.literal("code"),
    target: zFileReferenceSchema,
    exists: z.boolean(),
    fileSizeBytes: z.number().int().nonnegative().optional(),
    mimeType: z.string().min(1).optional(),
    text: z.string(),
    truncated: z.boolean(),
    lineCount: z.number().int().nonnegative(),
    language: z.string().min(1).optional()
  }),
  z.object({
    kind: z.literal("unsupported"),
    target: zFileReferenceSchema,
    exists: z.boolean(),
    fileSizeBytes: z.number().int().nonnegative().optional(),
    mimeType: z.string().min(1).optional(),
    reason: z.string().min(1)
  }),
  z.object({
    kind: z.literal("missing"),
    target: zFileReferenceSchema,
    exists: z.literal(false),
    reason: z.string().min(1)
  }),
  z.object({
    kind: z.literal("error"),
    target: zFileReferenceSchema,
    exists: z.boolean(),
    reason: z.string().min(1)
  })
]);

const zFileActionKindSchema = z.enum(["open", "reveal"]);

const zFileActionResultSchema = z.object({
  action: zFileActionKindSchema,
  ok: z.boolean(),
  displayPath: z.string().min(1),
  fileUrl: z.string().min(1),
  errorMessage: z.string().min(1).optional()
});

const zCodexTurnChangeKindSchema = z.enum(["add", "delete", "update"]);

const zCodexChangedFileSchema = zFileReferenceSchema.extend({
  changeKind: zCodexTurnChangeKindSchema,
  diff: z.string().min(1).optional()
});

const zEngineListRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("engine.list"),
  params: z.object({})
});

const zEngineGetSurfaceRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("engine.getSurface"),
  params: z.object({
    engineId: z.string().min(1)
  })
});

const zAgentListRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("agent.list"),
  params: z.object({})
});

const zAgentSelectRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("agent.select"),
  params: z.object({
    agentId: zAgentId,
    config: zJsonRecord.optional()
  })
});

const zDomainSnapshotRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("domain.snapshot"),
  params: z.object({})
});

const zSettingsGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("settings.get"),
  params: z.object({})
});

const zSettingsUpdateRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("settings.update"),
  params: z.object({
    defaultNewSessionEngineId: z.string().min(1).optional()
  })
});

const zRuntimeCommandRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("runtime.command"),
  params: z.object({
    envelope: zCommandEnvelopeSchema
  })
});

const zSessionListRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("session.list"),
  params: z.object({
    conversationId: zConversationId.optional(),
    includeArchived: z.boolean().default(false)
  })
});

const zWorkspaceListRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.list"),
  params: z.object({})
});

const zWorkspacePickDirectoryRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.pickDirectory"),
  params: z.object({})
});

const zWorkspaceAddRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.add"),
  params: z.object({
    rootPath: z.string().min(1),
    label: z.string().min(1).optional()
  })
});

const zWorkspaceRemoveRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.remove"),
  params: z.object({
    workspaceId: z.string().min(1)
  })
});

const zWorkspaceToggleExpandedRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.toggleExpanded"),
  params: z.object({
    workspaceId: z.string().min(1)
  })
});

const zWorkspaceSelectRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.select"),
  params: z.object({
    workspaceId: z.string().min(1)
  })
});

const zSessionBrowserListTreeRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.listTree"),
  params: z.object({
    workspaceId: z.string().min(1).optional()
  })
});

const zSessionBrowserToggleExpandedRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.toggleExpanded"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zSessionBrowserCreateRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.create"),
  params: z.object({
    workspaceId: z.string().min(1),
    engineId: z.string().min(1),
    conversationId: zConversationId.optional(),
    sessionProfile: zSessionExecutionProfileInputSchema.optional(),
    metadata: zJsonRecord.optional()
  })
});

const zSessionBrowserReconcileRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.reconcile"),
  params: z.object({
    workspaceId: z.string().min(1).optional()
  })
});

const zSessionBrowserOpenRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.open"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zSessionBrowserLoadOlderRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.loadOlder"),
  params: z.object({
    sessionId: zSessionId,
    beforeTurnId: zTurnId.optional(),
    limit: z.number().int().positive().max(50).optional()
  })
});

const zSessionBrowserGetActionsRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.getActions"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zSessionBrowserRunActionRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.runAction"),
  params: z.object({
    sessionId: zSessionId,
    action: zSessionActionKindSchema
  })
});

const zChatTreeGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("chatTree.get"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zChatTreeJumpRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("chatTree.jump"),
  params: z.object({
    sessionId: zSessionId,
    nodeId: z.string().min(1)
  })
});

const zDelegationGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("delegation.get"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zWorktreeGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("worktree.get"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zCheckpointGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("checkpoint.get"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zDiagnosticsGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("diagnostics.get"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zBackgroundRunGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("backgroundRun.get"),
  params: z.object({
    sessionId: zSessionId
  })
});

const zFileSearchWorkspaceRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("file.searchWorkspace"),
  params: z.object({
    workspaceId: z.string().min(1),
    query: z.string(),
    limit: z.number().int().positive().max(100).optional()
  })
});

const zFileGetPreviewRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("file.getPreview"),
  params: z.object({
    path: z.string().min(1)
  })
});

const zFileRunActionRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("file.runAction"),
  params: z.object({
    path: z.string().min(1),
    action: zFileActionKindSchema
  })
});

const zCodexTurnChangesGetRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("codex.turnChanges.get"),
  params: z.object({
    sessionId: zSessionId,
    turnId: zTurnId
  })
});

const zCodexTurnChangesUndoRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("codex.turnChanges.undo"),
  params: z.object({
    sessionId: zSessionId,
    turnId: zTurnId
  })
});

export const zWorkbenchEventSubscriptionFilterSchema = z.object({
  sessionId: zSessionId.optional(),
  conversationId: zConversationId.optional(),
  eventTypes: z.array(zWorkbenchEventType).optional()
});

const zEventsSubscribeRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("events.subscribe"),
  params: z.object({
    subscriptionId: z.string().min(1).optional(),
    fromCursor: zCursor.optional(),
    filter: zWorkbenchEventSubscriptionFilterSchema.optional()
  })
});

const zEventsUnsubscribeRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("events.unsubscribe"),
  params: z.object({
    subscriptionId: z.string().min(1)
  })
});

const zEventsReplayRequestSchema = z.object({
  id: zRequestId,
  method: z.literal("events.replay"),
  params: z.object({
    fromCursor: zCursor,
    toCursor: zCursor.optional(),
    filter: zWorkbenchEventSubscriptionFilterSchema.optional()
  })
});

export const zWorkbenchRpcRequestSchema = z.discriminatedUnion("method", [
  zAgentListRequestSchema,
  zEngineListRequestSchema,
  zEngineGetSurfaceRequestSchema,
  zAgentSelectRequestSchema,
  zSettingsGetRequestSchema,
  zSettingsUpdateRequestSchema,
  zDomainSnapshotRequestSchema,
  zSessionListRequestSchema,
  zWorkspaceListRequestSchema,
  zWorkspacePickDirectoryRequestSchema,
  zWorkspaceAddRequestSchema,
  zWorkspaceRemoveRequestSchema,
  zWorkspaceToggleExpandedRequestSchema,
  zWorkspaceSelectRequestSchema,
  zSessionBrowserListTreeRequestSchema,
  zSessionBrowserReconcileRequestSchema,
  zSessionBrowserToggleExpandedRequestSchema,
  zSessionBrowserCreateRequestSchema,
  zSessionBrowserOpenRequestSchema,
  zSessionBrowserLoadOlderRequestSchema,
  zSessionBrowserGetActionsRequestSchema,
  zSessionBrowserRunActionRequestSchema,
  zChatTreeGetRequestSchema,
  zChatTreeJumpRequestSchema,
  zDelegationGetRequestSchema,
  zWorktreeGetRequestSchema,
  zCheckpointGetRequestSchema,
  zDiagnosticsGetRequestSchema,
  zBackgroundRunGetRequestSchema,
  zFileSearchWorkspaceRequestSchema,
  zFileGetPreviewRequestSchema,
  zFileRunActionRequestSchema,
  zCodexTurnChangesGetRequestSchema,
  zCodexTurnChangesUndoRequestSchema,
  zRuntimeCommandRequestSchema,
  zEventsSubscribeRequestSchema,
  zEventsUnsubscribeRequestSchema,
  zEventsReplayRequestSchema
]);

const zEngineListResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("engine.list"),
  ok: z.literal(true),
  result: z.object({
    engines: z.array(zEngineDefinitionRpcSchema)
  })
});

const zEngineGetSurfaceResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("engine.getSurface"),
  ok: z.literal(true),
  result: z.object({
    surface: zEngineSurfaceRpcSchema
  })
});

const zAgentListResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("agent.list"),
  ok: z.literal(true),
  result: z.object({
    agents: z.array(zAgentDescriptorSchema)
  })
});

const zAgentSelectResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("agent.select"),
  ok: z.literal(true),
  result: z.object({
    selectedAgentId: zAgentId
  })
});

const zDomainSnapshotResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("domain.snapshot"),
  ok: z.literal(true),
  result: z.object({
    snapshot: zDomainSnapshotSchema,
    cursor: zCursor.optional()
  })
});

const zSettingsGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("settings.get"),
  ok: z.literal(true),
  result: zWorkbenchSettingsSchema
});

const zSettingsUpdateResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("settings.update"),
  ok: z.literal(true),
  result: zWorkbenchSettingsSchema
});

const zSessionListResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("session.list"),
  ok: z.literal(true),
  result: z.object({
    sessions: z.array(zChatSessionSchema)
  })
});

const zWorkspaceListResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.list"),
  ok: z.literal(true),
  result: z.object({
    workspaces: z.array(zWorkspaceRecordSchema),
    lastActiveWorkspaceId: z.string().min(1).optional(),
    lastActiveSessionId: z.string().min(1).optional()
  })
});

const zWorkspacePickDirectoryResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.pickDirectory"),
  ok: z.literal(true),
  result: z.object({
    canceled: z.boolean(),
    rootPath: z.string().min(1).optional()
  })
});

const zWorkspaceAddResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.add"),
  ok: z.literal(true),
  result: z.object({
    workspace: zWorkspaceRecordSchema
  })
});

const zWorkspaceRemoveResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.remove"),
  ok: z.literal(true),
  result: z.object({
    workspaceId: z.string().min(1),
    removed: z.boolean()
  })
});

const zWorkspaceToggleExpandedResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.toggleExpanded"),
  ok: z.literal(true),
  result: z.object({
    workspaceId: z.string().min(1),
    expanded: z.boolean()
  })
});

const zWorkspaceSelectResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("workspace.select"),
  ok: z.literal(true),
  result: z.object({
    workspaceId: z.string().min(1),
    activeSessionId: zSessionId.optional()
  })
});

const zSessionBrowserListTreeResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.listTree"),
  ok: z.literal(true),
  result: z.object({
    workspaces: z.array(zWorkspaceBrowserNodeSchema)
  })
});

const zSessionBrowserToggleExpandedResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.toggleExpanded"),
  ok: z.literal(true),
  result: z.object({
    sessionId: zSessionId,
    expanded: z.boolean()
  })
});

const zSessionBrowserCreateResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.create"),
  ok: z.literal(true),
  result: z.object({
    sessionId: zSessionId,
    conversationId: zConversationId
  })
});

const zSessionBrowserReconcileResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.reconcile"),
  ok: z.literal(true),
  result: z.object({
    workspaces: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    relations: z.number().int().nonnegative()
  })
});

const zSessionBrowserOpenResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.open"),
  ok: z.literal(true),
  result: z.object({
    page: zSessionWindowSchema
  })
});

const zSessionBrowserLoadOlderResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.loadOlder"),
  ok: z.literal(true),
  result: z.object({
    page: zSessionWindowSchema
  })
});

const zSessionBrowserGetActionsResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.getActions"),
  ok: z.literal(true),
  result: z.object({
    actions: z.array(zSessionActionDescriptorSchema)
  })
});

const zSessionBrowserRunActionResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("sessionBrowser.runAction"),
  ok: z.literal(true),
  result: zSessionActionResultSchema
});

const zChatTreeGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("chatTree.get"),
  ok: z.literal(true),
  result: z.object({
    chatTree: zChatTreeSnapshotSchema
  })
});

const zChatTreeJumpResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("chatTree.jump"),
  ok: z.literal(true),
  result: z.object({
    jumped: z.boolean()
  })
});

const zDelegationGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("delegation.get"),
  ok: z.literal(true),
  result: z.object({
    delegation: zDelegationSnapshotSchema
  })
});

const zWorktreeGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("worktree.get"),
  ok: z.literal(true),
  result: z.object({
    worktree: zWorktreeSnapshotSchema
  })
});

const zCheckpointGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("checkpoint.get"),
  ok: z.literal(true),
  result: z.object({
    checkpoint: zCheckpointSnapshotSchema
  })
});

const zDiagnosticsGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("diagnostics.get"),
  ok: z.literal(true),
  result: z.object({
    diagnostics: zDiagnosticsSnapshotSchema
  })
});

const zBackgroundRunGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("backgroundRun.get"),
  ok: z.literal(true),
  result: z.object({
    backgroundRun: zBackgroundRunSnapshotSchema
  })
});

const zFileSearchWorkspaceResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("file.searchWorkspace"),
  ok: z.literal(true),
  result: z.object({
    results: z.array(zWorkspaceFileSearchResultSchema).default([])
  })
});

const zFileGetPreviewResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("file.getPreview"),
  ok: z.literal(true),
  result: z.object({
    preview: zFilePreviewSchema
  })
});

const zFileRunActionResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("file.runAction"),
  ok: z.literal(true),
  result: z.object({
    result: zFileActionResultSchema
  })
});

const zCodexTurnChangesGetResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("codex.turnChanges.get"),
  ok: z.literal(true),
  result: z.object({
    engineId: z.literal("codex"),
    sessionId: zSessionId,
    turnId: zTurnId,
    changedFiles: z.array(zCodexChangedFileSchema).default([]),
    canUndo: z.boolean()
  })
});

const zCodexTurnChangesUndoResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("codex.turnChanges.undo"),
  ok: z.literal(true),
  result: z.object({
    engineId: z.literal("codex"),
    sessionId: zSessionId,
    turnId: zTurnId,
    undone: z.boolean(),
    displayPath: z.string().min(1),
    errorMessage: z.string().min(1).optional()
  })
});

const zRuntimeCommandResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("runtime.command"),
  ok: z.literal(true),
  result: z.object({
    commandId: zRequestId,
    commandType: zWorkbenchCommandType,
    accepted: z.boolean().default(true)
  })
});

const zEventsSubscribeResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("events.subscribe"),
  ok: z.literal(true),
  result: z.object({
    subscriptionId: z.string().min(1),
    fromCursor: zCursor.optional()
  })
});

const zEventsUnsubscribeResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("events.unsubscribe"),
  ok: z.literal(true),
  result: z.object({
    unsubscribed: z.boolean().default(true)
  })
});

const zEventsReplayResponseSchema = z.object({
  id: zRequestId,
  method: z.literal("events.replay"),
  ok: z.literal(true),
  result: z.object({
    replayed: z.number().int().nonnegative(),
    fromCursor: zCursor,
    toCursor: zCursor.optional(),
    envelopes: z.array(zEventEnvelopeSchema).default([])
  })
});

const zWorkbenchRpcErrorResponseSchema = z.object({
  id: zRequestId,
  method: z.enum(workbenchRpcMethods),
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: zJsonRecord.optional()
  })
});

export const zWorkbenchRpcResponseSchema = z.union([
  zAgentListResponseSchema,
  zEngineListResponseSchema,
  zEngineGetSurfaceResponseSchema,
  zAgentSelectResponseSchema,
  zSettingsGetResponseSchema,
  zSettingsUpdateResponseSchema,
  zDomainSnapshotResponseSchema,
  zSessionListResponseSchema,
  zWorkspaceListResponseSchema,
  zWorkspacePickDirectoryResponseSchema,
  zWorkspaceAddResponseSchema,
  zWorkspaceRemoveResponseSchema,
  zWorkspaceToggleExpandedResponseSchema,
  zWorkspaceSelectResponseSchema,
  zSessionBrowserListTreeResponseSchema,
  zSessionBrowserReconcileResponseSchema,
  zSessionBrowserToggleExpandedResponseSchema,
  zSessionBrowserCreateResponseSchema,
  zSessionBrowserOpenResponseSchema,
  zSessionBrowserLoadOlderResponseSchema,
  zSessionBrowserGetActionsResponseSchema,
  zSessionBrowserRunActionResponseSchema,
  zChatTreeGetResponseSchema,
  zChatTreeJumpResponseSchema,
  zDelegationGetResponseSchema,
  zWorktreeGetResponseSchema,
  zCheckpointGetResponseSchema,
  zDiagnosticsGetResponseSchema,
  zBackgroundRunGetResponseSchema,
  zFileSearchWorkspaceResponseSchema,
  zFileGetPreviewResponseSchema,
  zFileRunActionResponseSchema,
  zCodexTurnChangesGetResponseSchema,
  zCodexTurnChangesUndoResponseSchema,
  zRuntimeCommandResponseSchema,
  zEventsSubscribeResponseSchema,
  zEventsUnsubscribeResponseSchema,
  zEventsReplayResponseSchema,
  zWorkbenchRpcErrorResponseSchema
]);

export const zWorkbenchEventPushSchema = z.object({
  channel: z.literal("workbench.events"),
  subscriptionId: z.string().min(1),
  envelope: zEventEnvelopeSchema
});

export type AgentDescriptor = z.infer<typeof zAgentDescriptorSchema>;
export type WorkbenchSettingsRpc = z.infer<typeof zWorkbenchSettingsSchema>;
export type WorkbenchEventSubscriptionFilter = z.infer<
  typeof zWorkbenchEventSubscriptionFilterSchema
>;
export type WorkbenchRpcRequest = z.infer<typeof zWorkbenchRpcRequestSchema>;
export type WorkbenchRpcResponse = z.infer<typeof zWorkbenchRpcResponseSchema>;
export type WorkbenchEventPush = z.infer<typeof zWorkbenchEventPushSchema>;
export type WorkspaceRecordRpc = z.infer<typeof zWorkspaceRecordSchema>;
export type ProviderSessionHandle = z.infer<typeof zProviderSessionHandleSchema>;
export type SessionBrowserNodeRpc = z.infer<typeof zSessionBrowserNodeSchema>;
export type WorkspaceBrowserNodeRpc = z.infer<typeof zWorkspaceBrowserNodeSchema>;
export type SessionActionKindRpc = z.infer<typeof zSessionActionKindSchema>;
export type SessionActionDescriptorRpc = z.infer<typeof zSessionActionDescriptorSchema>;
export type SessionActionResultRpc = z.infer<typeof zSessionActionResultSchema>;
export type ConversationGraphSnapshotRpc = z.infer<
  typeof zConversationGraphSnapshotSchema
>;
export type ChatTreeSnapshotRpc = z.infer<typeof zChatTreeSnapshotSchema>;
export type DelegationSnapshotRpc = z.infer<typeof zDelegationSnapshotSchema>;
export type WorktreeSnapshotRpc = z.infer<typeof zWorktreeSnapshotSchema>;
export type CheckpointSnapshotRpc = z.infer<typeof zCheckpointSnapshotSchema>;
export type DiagnosticsSnapshotRpc = z.infer<typeof zDiagnosticsSnapshotSchema>;
export type BackgroundRunSnapshotRpc = z.infer<typeof zBackgroundRunSnapshotSchema>;
export type SessionWindowRpc = z.infer<typeof zSessionWindowSchema>;
export type FileReferenceRpc = z.infer<typeof zFileReferenceSchema>;
export type WorkspaceFileSearchResultRpc = z.infer<
  typeof zWorkspaceFileSearchResultSchema
>;
export type FilePreviewRpc = z.infer<typeof zFilePreviewSchema>;
export type FileActionKindRpc = z.infer<typeof zFileActionKindSchema>;
export type FileActionResultRpc = z.infer<typeof zFileActionResultSchema>;
export type CodexTurnChangeKindRpc = z.infer<typeof zCodexTurnChangeKindSchema>;
export type CodexChangedFileRpc = z.infer<typeof zCodexChangedFileSchema>;
export type CodexTurnChangesResultRpc = z.infer<
  typeof zCodexTurnChangesGetResponseSchema
>["result"];
export type CodexTurnChangesUndoResultRpc = z.infer<
  typeof zCodexTurnChangesUndoResponseSchema
>["result"];

export type WorkbenchEventHandler = (event: WorkbenchEventPush) => void;

export type WorkbenchClientApi = {
  request: (request: WorkbenchRpcRequest) => Promise<WorkbenchRpcResponse>;
  subscribe: (
    params: Extract<WorkbenchRpcRequest, { method: "events.subscribe" }>["params"],
    handler: WorkbenchEventHandler
  ) => Promise<{ subscriptionId: string; unsubscribe: () => Promise<void> }>;
};

export const parseWorkbenchRpcRequest = (value: unknown): WorkbenchRpcRequest =>
  zWorkbenchRpcRequestSchema.parse(value);

export const parseWorkbenchRpcResponse = (value: unknown): WorkbenchRpcResponse =>
  zWorkbenchRpcResponseSchema.parse(value);

export const parseWorkbenchEventPush = (value: unknown): WorkbenchEventPush =>
  zWorkbenchEventPushSchema.parse(value);

export const safeParseWorkbenchRpcRequest = (value: unknown) =>
  zWorkbenchRpcRequestSchema.safeParse(value);

export const safeParseWorkbenchRpcResponse = (value: unknown) =>
  zWorkbenchRpcResponseSchema.safeParse(value);

export const safeParseWorkbenchEventPush = (value: unknown) =>
  zWorkbenchEventPushSchema.safeParse(value);
