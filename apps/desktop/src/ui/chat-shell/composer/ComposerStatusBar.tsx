import type { ReactElement } from "react";
import type { ComposerIntent } from "./composer-types.js";
import type { ComposerStatusModel } from "../composer-status.js";

export const ComposerStatusBar = ({
  status,
  intent
}: {
  status: ComposerStatusModel;
  intent: ComposerIntent;
}): ReactElement => (
  <div className="awb-composer-status">
    <span className={`awb-composer-status__pill is-${status.kind}`}>
      {status.label}
    </span>
    <span className="awb-composer-status__detail">
      {status.detail ?? (intent === "steer" ? "Steer supported" : "Ready")}
    </span>
  </div>
);
