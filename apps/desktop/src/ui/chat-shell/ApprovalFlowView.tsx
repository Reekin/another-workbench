import { startTransition, useState, type ReactElement } from "react";
import type { ApprovalRequest } from "@another-workbench/shared";
import { ParticipantIdentityBadge } from "./ParticipantIdentityBadge.js";
import {
  buildParticipantDirectory,
  type ParticipantDirectory,
  resolveParticipantIdentity
} from "./participant-directory.js";

export type ApprovalAction = "approve" | "deny" | "defer";

export type ApprovalResponseInput = {
  sessionId: string;
  requestId: string;
  action: ApprovalAction;
};

export type ApprovalFlowViewProps = {
  approvals: ApprovalRequest[];
  participantDirectory?: ParticipantDirectory;
  onRespond?: (input: ApprovalResponseInput) => Promise<void>;
};

const defaultDirectory = buildParticipantDirectory([]);

const canRespond = (approval: ApprovalRequest): boolean => approval.status === "pending";

export const ApprovalFlowView = ({
  approvals,
  participantDirectory = defaultDirectory,
  onRespond
}: ApprovalFlowViewProps): ReactElement => {
  const [inFlightByRequestId, setInFlightByRequestId] = useState<Record<string, boolean>>({});
  const [errorByRequestId, setErrorByRequestId] = useState<Record<string, string | undefined>>(
    {}
  );

  const setPending = (requestId: string, pending: boolean): void => {
    startTransition(() => {
      setInFlightByRequestId((current) => ({
        ...current,
        [requestId]: pending
      }));
    });
  };

  const setError = (requestId: string, message?: string): void => {
    startTransition(() => {
      setErrorByRequestId((current) => ({
        ...current,
        [requestId]: message
      }));
    });
  };

  const onAction = async (
    approval: ApprovalRequest,
    action: ApprovalAction
  ): Promise<void> => {
    if (!onRespond || !canRespond(approval)) {
      return;
    }
    setPending(approval.requestId, true);
    setError(approval.requestId, undefined);

    try {
      await onRespond({
        sessionId: approval.sessionId,
        requestId: approval.requestId,
        action
      });
    } catch (error) {
      setError(approval.requestId, (error as Error).message);
    } finally {
      setPending(approval.requestId, false);
    }
  };

  if (approvals.length === 0) {
    return <p className="awb-detail__empty">No approval request in this turn.</p>;
  }

  return (
    <div className="awb-approval-list">
      {approvals.map((approval) => {
        const inFlight = inFlightByRequestId[approval.requestId] ?? false;
        const requestError = errorByRequestId[approval.requestId];
        const disabled = !onRespond || !canRespond(approval) || inFlight;
        const identity = resolveParticipantIdentity(
          participantDirectory,
          approval.actor,
          approval.approvalKind
        );

        return (
          <article key={approval.requestId} className="awb-timeline-item awb-approval-item">
            <header className="awb-timeline-item__header">
              <div className="awb-timeline-item__meta">
                <strong>{approval.title}</strong>
                <ParticipantIdentityBadge identity={identity} compact />
              </div>
              <span className={`awb-badge is-${approval.status}`}>{approval.status}</span>
            </header>
            <p className="awb-approval-item__kind">{approval.approvalKind}</p>
            {approval.details && <p className="awb-approval-item__details">{approval.details}</p>}
            <div className="awb-approval-item__actions">
              <button
                type="button"
                disabled={disabled}
                onClick={() => void onAction(approval, "approve")}
              >
                Approve
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => void onAction(approval, "deny")}
              >
                Deny
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => void onAction(approval, "defer")}
              >
                Later
              </button>
            </div>
            {requestError && <p className="awb-approval-item__error">{requestError}</p>}
          </article>
        );
      })}
    </div>
  );
};
