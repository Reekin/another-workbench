import type { ChatSession } from "@another-workbench/shared";
import type {
  DelegationCapability,
  DelegationNodeSnapshot,
  DelegationSnapshot,
  SessionCapabilityContext
} from "./capability-registry.js";

const mapSessionStatus = (
  session: ChatSession | undefined,
  archivedAt: string | undefined
): DelegationNodeSnapshot["status"] => {
  if (session?.status === "running" || session?.status === "awaiting_approval") {
    return "running";
  }
  if (session?.status === "error") {
    return "failed";
  }
  if (session?.status === "completed" || archivedAt) {
    return "completed";
  }
  return "pending";
};

const buildNodeLabel = (
  input: Pick<SessionCapabilityContext, "runtimeService" | "sessionIndexStore">,
  sessionId: string
): { session?: ChatSession; title: string; archivedAt?: string; startedAt?: string } => {
  const session = input.runtimeService
    .listSessions({
      includeArchived: true
    })
    .find((candidate) => candidate.sessionId === sessionId);
  const entry = input.sessionIndexStore.getEntry(sessionId);
  return {
    session,
    title: session?.title ?? entry?.title ?? sessionId,
    archivedAt: session?.archivedAt ?? entry?.archivedAt,
    startedAt: session?.createdAt ?? entry?.createdAt
  };
};

export class CodexDelegationProvider implements DelegationCapability {
  public async get(input: SessionCapabilityContext): Promise<DelegationSnapshot> {
    const workspaceId = input.indexEntry?.workspaceId;
    if (!workspaceId) {
      return {
        sessionId: input.sessionId,
        agentId: input.agentId ?? "codex",
        supported: true,
        supportsControl: false,
        currentActiveNodeId: input.sessionId,
        nodes: [
          {
            nodeId: input.sessionId,
            label: input.session?.title ?? input.indexEntry?.title ?? input.sessionId,
            status: mapSessionStatus(input.session, input.indexEntry?.archivedAt),
            role: "root",
            linkedSessionId: input.sessionId,
            startedAt: input.session?.createdAt ?? input.indexEntry?.createdAt,
            completedAt: input.session?.archivedAt ?? input.indexEntry?.archivedAt
          }
        ],
        edges: [],
        fetchedAt: new Date().toISOString()
      };
    }

    const relations = input.sessionIndexStore
      .listRelations(workspaceId)
      .filter((relation) => relation.relationType === "subagent");
    const connected = new Set<string>([input.sessionId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const relation of relations) {
        if (connected.has(relation.parentSessionId) && !connected.has(relation.childSessionId)) {
          connected.add(relation.childSessionId);
          changed = true;
        }
        if (connected.has(relation.childSessionId) && !connected.has(relation.parentSessionId)) {
          connected.add(relation.parentSessionId);
          changed = true;
        }
      }
    }

    const componentRelations = relations.filter(
      (relation) =>
        connected.has(relation.parentSessionId) && connected.has(relation.childSessionId)
    );
    const parentBySessionId = new Map(
      componentRelations.map((relation) => [relation.childSessionId, relation.parentSessionId] as const)
    );
    const nodes = [...connected].map((sessionId) => {
      const details = buildNodeLabel(input, sessionId);
      return {
        nodeId: sessionId,
        providerNodeId: input.sessionIdentity.getProviderHandle(sessionId)?.providerSessionId,
        label: details.title,
        status: mapSessionStatus(details.session, details.archivedAt),
        role: parentBySessionId.has(sessionId) ? "delegate" as const : "root" as const,
        parentNodeId: parentBySessionId.get(sessionId),
        linkedSessionId: sessionId,
        summary: input.sessionIndexStore.getEntry(sessionId)?.summaryText,
        startedAt: details.startedAt,
        completedAt: details.archivedAt
      };
    });
    const currentActiveNodeId =
      nodes.find((node) => node.status === "running")?.nodeId ?? input.sessionId;

    return {
      sessionId: input.sessionId,
      agentId: input.agentId ?? "codex",
      supported: true,
      supportsControl: false,
      currentActiveNodeId,
      nodes,
      edges: componentRelations.map((relation) => ({
        edgeId: `${relation.parentSessionId}:${relation.childSessionId}:${relation.relationType}`,
        fromNodeId: relation.parentSessionId,
        toNodeId: relation.childSessionId,
        relation: "spawn" as const
      })),
      fetchedAt: new Date().toISOString()
    };
  }
}
