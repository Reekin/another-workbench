export const codexRuntimeRequestMethods = [
  "initialize",
  "thread/start",
  "thread/list",
  "thread/resume",
  "thread/archive",
  "thread/fork",
  "turn/start",
  "turn/interrupt",
  "approval/respond",
  "session/dispose"
] as const;

export type CodexRuntimeRequestMethod = (typeof codexRuntimeRequestMethods)[number];

export const codexRuntimeEventMethods = [
  "conversation.updated",
  "session.created",
  "session.updated",
  "session.archived",
  "session.disposed",
  "turn.started",
  "turn.completed",
  "message.started",
  "message.delta",
  "message.completed",
  "tool.started",
  "tool.delta",
  "tool.completed",
  "terminal.started",
  "terminal.output",
  "terminal.completed",
  "approval.requested",
  "approval.resolved",
  "participant.updated",
  "runtime.error"
] as const;

export type CodexRuntimeEventMethod = (typeof codexRuntimeEventMethods)[number];

export type CodexRuntimeRequest = {
  id: string;
  method: CodexRuntimeRequestMethod;
  params: Record<string, unknown>;
};

export type CodexRuntimeResponse = {
  id: string;
  ok?: boolean;
  result?: unknown;
  error?: {
    code?: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type CodexRuntimeEvent = {
  method: CodexRuntimeEventMethod;
  params: Record<string, unknown>;
  eventId?: string;
  cursor?: string;
  occurredAt?: string;
};
