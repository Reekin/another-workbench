import { describe, expect, it } from "vitest";
import { parseDomainSnapshot } from "@another-workbench/shared";
import {
  selectSessionGraphForConversation,
  selectSessionSummary
} from "../src/store/selectors.js";
import { createRendererStore } from "../src/store/store.js";

describe("session graph selectors", () => {
  it("derives parent/child summaries and root sessions for a conversation", () => {
    const store = createRendererStore();
    store.hydrateSnapshot(
      parseDomainSnapshot({
        conversations: [
          {
            conversationId: "conv-1",
            participantEngineIds: ["agent-1"],
            activeSessionId: "session-child",
            sessionIds: ["session-root", "session-child"],
            createdAt: "2026-04-18T00:00:00.000Z",
            updatedAt: "2026-04-18T00:00:00.000Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-root",
            conversationId: "conv-1",
            engineId: "agent-1",
            status: "completed",
            createdAt: "2026-04-18T00:00:00.000Z",
            updatedAt: "2026-04-18T00:00:00.000Z"
          },
          {
            sessionId: "session-child",
            conversationId: "conv-1",
            engineId: "agent-1",
            status: "running",
            createdAt: "2026-04-18T00:05:00.000Z",
            updatedAt: "2026-04-18T00:05:00.000Z"
          }
        ],
        sessionRelations: [
          {
            relationId: "relation-1",
            parentSessionId: "session-root",
            childSessionId: "session-child",
            relationType: "fork",
            createdAt: "2026-04-18T00:05:00.000Z"
          }
        ]
      })
    );

    const domain = store.getDomainReadModel();
    const rootSummary = selectSessionSummary(domain, "session-root");
    const childSummary = selectSessionSummary(domain, "session-child");
    const graph = selectSessionGraphForConversation(domain, "conv-1");

    expect(rootSummary).toMatchObject({
      childSessionIds: ["session-child"]
    });
    expect(childSummary).toMatchObject({
      parentSessionId: "session-root",
      isActive: true
    });
    expect(graph.rootSessionIds).toEqual(["session-root"]);
    expect(graph.relationEdges).toEqual([
      expect.objectContaining({
        relationId: "relation-1",
        relationType: "fork"
      })
    ]);
  });
});
