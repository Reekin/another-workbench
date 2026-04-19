import type { SessionIndexStore } from "./session-index.js";
import type { WorkbenchRuntimeService } from "./runtime-service.js";
import {
  SessionIdentityRegistry,
  type ResolvedSessionContext
} from "./session-identity-registry.js";

export type { ResolvedSessionContext } from "./session-identity-registry.js";

export const findRuntimeSession = (
  runtimeService: WorkbenchRuntimeService,
  sessionId: string
) =>
  runtimeService
    .listSessions({
      includeArchived: true
    })
    .find((session) => session.sessionId === sessionId);

export const resolveSessionContext = (
  runtimeService: WorkbenchRuntimeService,
  sessionIndexStore: SessionIndexStore,
  sessionId: string
): ResolvedSessionContext =>
  new SessionIdentityRegistry({
    runtimeService,
    sessionIndexStore
  }).resolveContext(sessionId);
