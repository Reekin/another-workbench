import type { ReactElement } from "react";
import type { ParticipantIdentity } from "./participant-directory.js";

export type ParticipantIdentityBadgeProps = {
  identity: ParticipantIdentity;
  compact?: boolean;
};

export const ParticipantIdentityBadge = ({
  identity,
  compact = false
}: ParticipantIdentityBadgeProps): ReactElement => (
  <span
    className={`awb-participant-badge is-${identity.kind}${compact ? " is-compact" : ""}`}
    title={identity.detail}
  >
    <strong>{identity.label}</strong>
    {!compact && <small>{identity.detail}</small>}
  </span>
);
