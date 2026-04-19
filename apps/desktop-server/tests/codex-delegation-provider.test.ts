import { describe, expect, it } from "vitest";
import { CodexDelegationProvider } from "../src/codex-delegation-provider.js";

describe("CodexDelegationProvider", () => {
  it("builds a delegation graph from subagent relations in the session index", async () => {
    const provider = new CodexDelegationProvider();

    await expect(
      provider.get({
        sessionId: "root-session",
        agentId: "codex",
        indexEntry: {
          sessionId: "root-session",
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          agentId: "codex",
          title: "Root session",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          source: "registry"
        },
        runtimeService: {
          listSessions: () => [
            {
              sessionId: "root-session",
              conversationId: "conversation-1",
              agentId: "codex",
              status: "idle",
              title: "Root session",
              createdAt: "2026-04-20T00:00:00.000Z",
              updatedAt: "2026-04-20T00:00:00.000Z"
            },
            {
              sessionId: "child-session",
              conversationId: "conversation-1",
              agentId: "codex",
              status: "running",
              title: "Child session",
              createdAt: "2026-04-20T00:01:00.000Z",
              updatedAt: "2026-04-20T00:01:00.000Z"
            }
          ]
        } as never,
        sessionIndexStore: {
          getEntry: (sessionId: string) =>
            sessionId === "child-session"
              ? {
                  sessionId,
                  workspaceId: "workspace-1",
                  conversationId: "conversation-1",
                  agentId: "codex",
                  title: "Child session",
                  summaryText: "Investigating tools",
                  createdAt: "2026-04-20T00:01:00.000Z",
                  updatedAt: "2026-04-20T00:01:00.000Z",
                  source: "registry"
                }
              : {
                  sessionId,
                  workspaceId: "workspace-1",
                  conversationId: "conversation-1",
                  agentId: "codex",
                  title: "Root session",
                  createdAt: "2026-04-20T00:00:00.000Z",
                  updatedAt: "2026-04-20T00:00:00.000Z",
                  source: "registry"
                },
          listRelations: () => [
            {
              workspaceId: "workspace-1",
              parentSessionId: "root-session",
              childSessionId: "child-session",
              relationType: "subagent",
              createdAt: "2026-04-20T00:01:00.000Z"
            }
          ]
        } as never,
        sessionIdentity: {
          getProviderHandle: () => undefined
        } as never
      })
    ).resolves.toEqual({
      sessionId: "root-session",
      agentId: "codex",
      supported: true,
      supportsControl: false,
      currentActiveNodeId: "child-session",
      nodes: [
        {
          nodeId: "root-session",
          providerNodeId: undefined,
          label: "Root session",
          status: "pending",
          role: "root",
          parentNodeId: undefined,
          linkedSessionId: "root-session",
          summary: undefined,
          startedAt: "2026-04-20T00:00:00.000Z",
          completedAt: undefined
        },
        {
          nodeId: "child-session",
          providerNodeId: undefined,
          label: "Child session",
          status: "running",
          role: "delegate",
          parentNodeId: "root-session",
          linkedSessionId: "child-session",
          summary: "Investigating tools",
          startedAt: "2026-04-20T00:01:00.000Z",
          completedAt: undefined
        }
      ],
      edges: [
        {
          edgeId: "root-session:child-session:subagent",
          fromNodeId: "root-session",
          toNodeId: "child-session",
          relation: "spawn"
        }
      ],
      fetchedAt: expect.any(String)
    });
  });
});
