import type { ApprovalRequest, ChatSession } from "@another-workbench/shared";

export type ComposerStatusNotice = {
  message: string;
  persistent?: boolean;
  source?:
    | "engine-list"
    | "engine-select"
    | "subscription"
    | "send"
    | "create-session"
    | "approval"
    | "workspace-add"
    | "session-browser"
    | "session-action"
    | "chat-tree"
    | "delegation"
    | "files"
    | "settings";
};

export type ResolveComposerStatusInput = {
  transportAvailable: boolean;
  selectedEngineId?: string;
  activeSession?: ChatSession;
  approvals?: ApprovalRequest[];
  notice?: ComposerStatusNotice;
};

const firstPendingApproval = (
  approvals: ApprovalRequest[] | undefined
): ApprovalRequest | undefined => approvals?.find((approval) => approval.status === "pending");

export const resolveComposerStatus = (
  input: ResolveComposerStatusInput
): string => {
  if (input.notice?.message) {
    return input.notice.message;
  }

  if (!input.transportAvailable) {
    return "Transport unavailable.";
  }

  const pendingApproval = firstPendingApproval(input.approvals);
  if (input.activeSession?.status === "awaiting_approval" && pendingApproval) {
    return `Approval requested for ${pendingApproval.requestId}`;
  }

  if (input.activeSession?.status === "running") {
    return `Running ${input.activeSession.sessionId}`;
  }

  if (input.activeSession?.status === "error") {
    return `Session ${input.activeSession.sessionId} has errors.`;
  }

  if (input.activeSession) {
    return `Ready in ${input.activeSession.sessionId}`;
  }

  if (input.selectedEngineId) {
    return `Selected engine: ${input.selectedEngineId}`;
  }

  return "Ready";
};
