import type { ChatSession, SessionStatus } from "@another-workbench/shared";
import { parseChatSession } from "@another-workbench/shared";

export type RuntimeBinding = {
  runtimeId?: string;
  handle: unknown;
  attachedAt: string;
  metadata?: Record<string, unknown>;
};

export type RuntimeRouteInput = {
  runtimeId: string;
  eventSessionId?: string;
};

export type RuntimeRouteResult =
  | {
      accepted: true;
      sessionId: string;
    }
  | {
      accepted: false;
      reason: "runtime_not_bound";
    }
  | {
      accepted: false;
      reason: "session_mismatch";
      sessionId: string;
    };

export type CreateSessionInput = {
  sessionId?: string;
  conversationId: string;
  engineId: string;
  status?: SessionStatus;
  title?: string;
  metadata?: Record<string, unknown>;
};

export type ListSessionOptions = {
  conversationId?: string;
  includeArchived?: boolean;
};

type SessionManagerOptions = {
  now?: () => string;
  createSessionId?: () => string;
};

const createOpaqueSessionId = (): string =>
  `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const sortByUpdatedAtDesc = (sessions: ChatSession[]): ChatSession[] =>
  [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

export class SessionManager {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly runtimeBindings = new Map<string, RuntimeBinding>();
  private readonly sessionIdByRuntimeId = new Map<string, string>();
  private readonly now: () => string;
  private readonly createSessionId: () => string;

  public constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createSessionId = options.createSessionId ?? createOpaqueSessionId;
  }

  public createSession(input: CreateSessionInput): ChatSession {
    const timestamp = this.now();
    const session = parseChatSession({
      sessionId: input.sessionId ?? this.createSessionId(),
      conversationId: input.conversationId,
      engineId: input.engineId,
      status: input.status ?? "idle",
      title: input.title,
      metadata: input.metadata,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    this.sessions.set(session.sessionId, session);
    return session;
  }

  public loadSession(session: ChatSession): ChatSession {
    const parsedSession = parseChatSession(session);
    this.sessions.set(parsedSession.sessionId, parsedSession);
    return parsedSession;
  }

  public getSession(sessionId: string): ChatSession | undefined {
    return this.sessions.get(sessionId);
  }

  public listSessions(options: ListSessionOptions = {}): ChatSession[] {
    let sessions = [...this.sessions.values()];

    if (options.conversationId) {
      sessions = sessions.filter(
        (session) => session.conversationId === options.conversationId
      );
    }

    if (!options.includeArchived) {
      sessions = sessions.filter((session) => !session.archivedAt);
    }

    return sortByUpdatedAtDesc(sessions);
  }

  public archiveSession(sessionId: string): ChatSession {
    const existingSession = this.requireSession(sessionId);
    const archivedSession = parseChatSession({
      ...existingSession,
      archivedAt: this.now(),
      updatedAt: this.now()
    });
    this.sessions.set(sessionId, archivedSession);
    return archivedSession;
  }

  public resumeSession(sessionId: string): ChatSession {
    const existingSession = this.requireSession(sessionId);
    const resumedSession = parseChatSession({
      ...existingSession,
      archivedAt: undefined,
      status: existingSession.status === "completed" ? "idle" : existingSession.status,
      updatedAt: this.now()
    });
    this.sessions.set(sessionId, resumedSession);
    return resumedSession;
  }

  public updateSessionStatus(sessionId: string, status: SessionStatus): ChatSession {
    const existingSession = this.requireSession(sessionId);
    const updatedSession = parseChatSession({
      ...existingSession,
      status,
      updatedAt: this.now()
    });
    this.sessions.set(sessionId, updatedSession);
    return updatedSession;
  }

  public disposeSession(sessionId: string): boolean {
    this.unbindRuntime(sessionId);
    return this.sessions.delete(sessionId);
  }

  public bindRuntime(sessionId: string, binding: RuntimeBinding): RuntimeBinding {
    this.requireSession(sessionId);
    const runtimeId = binding.runtimeId ?? sessionId;
    const existingOwnerSessionId = this.sessionIdByRuntimeId.get(runtimeId);
    if (existingOwnerSessionId && existingOwnerSessionId !== sessionId) {
      throw new Error(
        `Runtime ${runtimeId} is already bound to session ${existingOwnerSessionId}.`
      );
    }

    const existingBinding = this.runtimeBindings.get(sessionId);
    if (existingBinding?.runtimeId) {
      this.sessionIdByRuntimeId.delete(existingBinding.runtimeId);
    }

    const normalizedBinding: RuntimeBinding = {
      ...binding,
      runtimeId
    };
    this.runtimeBindings.set(sessionId, normalizedBinding);
    this.sessionIdByRuntimeId.set(runtimeId, sessionId);
    return normalizedBinding;
  }

  public unbindRuntime(sessionId: string): void {
    const existingBinding = this.runtimeBindings.get(sessionId);
    if (existingBinding?.runtimeId) {
      this.sessionIdByRuntimeId.delete(existingBinding.runtimeId);
    }
    this.runtimeBindings.delete(sessionId);
  }

  public getRuntimeBinding(sessionId: string): RuntimeBinding | undefined {
    return this.runtimeBindings.get(sessionId);
  }

  public getSessionIdByRuntimeId(runtimeId: string): string | undefined {
    return this.sessionIdByRuntimeId.get(runtimeId);
  }

  public resolveRuntimeRoute(input: RuntimeRouteInput): RuntimeRouteResult {
    const sessionId = this.getSessionIdByRuntimeId(input.runtimeId);
    if (!sessionId) {
      return {
        accepted: false,
        reason: "runtime_not_bound"
      };
    }

    if (input.eventSessionId && input.eventSessionId !== sessionId) {
      return {
        accepted: false,
        reason: "session_mismatch",
        sessionId
      };
    }

    return {
      accepted: true,
      sessionId
    };
  }

  public getRunningSessionIds(): string[] {
    return this.listSessions({ includeArchived: true })
      .filter((session) => session.status === "running")
      .map((session) => session.sessionId);
  }

  private requireSession(sessionId: string): ChatSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }
}
