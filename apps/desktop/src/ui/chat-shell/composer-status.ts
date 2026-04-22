import type { ApprovalRequest, ChatSession } from "@another-workbench/shared";

export type ComposerStatusNotice = {
  message: string;
  persistent?: boolean;
  source?:
    | "agent-list"
    | "agent-select"
    | "subscription"
    | "send"
    | "create-session"
    | "approval"
    | "workspace-add"
    | "session-browser"
    | "session-action"
    | "chat-tree"
    | "delegation"
    | "settings";
};

export type ResolveComposerStatusInput = {
  transportAvailable: boolean;
  selectedAgentId?: string;
  activeSession?: ChatSession;
  approvals?: ApprovalRequest[];
  notice?: ComposerStatusNotice;
  queuedCount?: number;
  supportsSteer?: boolean;
};

export type ComposerStatusModel = {
  kind:
    | "transport_unavailable"
    | "no_session"
    | "idle"
    | "running"
    | "awaiting_approval"
    | "error"
    | "queue_pending"
    | "notice";
  label: string;
  detail?: string;
};

const firstPendingApproval = (
  approvals: ApprovalRequest[] | undefined
): ApprovalRequest | undefined => approvals?.find((approval) => approval.status === "pending");

export const resolveComposerStatusModel = (
  input: ResolveComposerStatusInput
): ComposerStatusModel => {
  if (input.notice?.message) {
    return {
      kind: "notice",
      label: input.notice.message
    };
  }

  if (!input.transportAvailable) {
    return {
      kind: "transport_unavailable",
      label: "Transport unavailable"
    };
  }

  const pendingApproval = firstPendingApproval(input.approvals);
  if (input.activeSession?.status === "awaiting_approval" && pendingApproval) {
    return {
      kind: "awaiting_approval",
      label: "Awaiting approval",
      detail: `Approval requested for ${pendingApproval.requestId}`
    };
  }

  if (input.activeSession?.status === "running") {
    return {
      kind: "running",
      label: "Running",
      detail: input.supportsSteer ? "Steer supported" : "Queue only"
    };
  }

  if (input.activeSession?.status === "error") {
    return {
      kind: "error",
      label: "Attention",
      detail: `Session ${input.activeSession.sessionId} has errors.`
    };
  }

  if ((input.queuedCount ?? 0) > 0 && input.activeSession) {
    return {
      kind: "queue_pending",
      label: `${input.queuedCount} queued`,
      detail: "Will auto-send when idle"
    };
  }

  if (input.activeSession) {
    return {
      kind: "idle",
      label: "Ready",
      detail: `In ${input.activeSession.sessionId}`
    };
  }

  if (input.selectedAgentId) {
    return {
      kind: "no_session",
      label: "No thread selected",
      detail: `Selected agent: ${input.selectedAgentId}`
    };
  }

  return {
    kind: "no_session",
    label: "Ready"
  };
};

export const resolveComposerStatus = (
  input: ResolveComposerStatusInput
): string => {
  const model = resolveComposerStatusModel(input);
  return model.detail ? `${model.label}: ${model.detail}` : model.label;
};
