export const acpRuntimeRequestMethods = [
  "agent.initialize",
  "session.create",
  "session.list",
  "session.load",
  "session.archive",
  "session.fork",
  "turn.send",
  "turn.steer",
  "turn.interrupt",
  "approval.respond",
  "session.dispose"
] as const;

export type AcpRuntimeRequestMethod = (typeof acpRuntimeRequestMethods)[number];

export const acpRuntimeEventNames = [
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

export type AcpRuntimeEventName = (typeof acpRuntimeEventNames)[number];

export type AcpRuntimeRequest = {
  id: string;
  method: AcpRuntimeRequestMethod;
  params: Record<string, unknown>;
};

export type AcpRuntimeResponse = {
  id: string;
  ok?: boolean;
  result?: unknown;
  error?: {
    code?: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type AcpRuntimeEvent = {
  event: AcpRuntimeEventName;
  payload: Record<string, unknown>;
  eventId?: string;
  cursor?: string;
  occurredAt?: string;
};
