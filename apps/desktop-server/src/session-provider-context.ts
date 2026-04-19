import type { ChatSession } from "@another-workbench/shared";
import type { WorkbenchRuntimeService } from "./runtime-service.js";
import type { SessionIndexEntry, SessionIndexStore } from "./session-index.js";

export type ResolvedSessionContext = {
  sessionId: string;
  session?: ChatSession;
  indexEntry?: SessionIndexEntry;
  agentId?: string;
};

export const findRuntimeSession = (
  runtimeService: WorkbenchRuntimeService,
  sessionId: string
): ChatSession | undefined =>
  runtimeService
    .listSessions({
      includeArchived: true
    })
    .find((session) => session.sessionId === sessionId);

export const resolveSessionContext = (
  runtimeService: WorkbenchRuntimeService,
  sessionIndexStore: SessionIndexStore,
  sessionId: string
): ResolvedSessionContext => {
  const session = findRuntimeSession(runtimeService, sessionId);
  const indexEntry = sessionIndexStore.getEntry(sessionId);
  return {
    sessionId,
    session,
    indexEntry,
    agentId: session?.agentId ?? indexEntry?.agentId
  };
};
