import type { ReactElement } from "react";
import type { ComposerStatusModel } from "../composer-status.js";

export const ComposerStatusBar = ({
  status
}: {
  status: ComposerStatusModel;
}): ReactElement => (
  <div className="awb-composer-status">
    <span className={`awb-composer-status__pill is-${status.kind}`}>
      {status.label}
    </span>
  </div>
);
