import type { ReactElement } from "react";
import type {
  ComposerStatusModel,
  ComposerStatusNotice
} from "../composer-status.js";

export const ComposerStatusBar = ({
  status,
  notice
}: {
  status: ComposerStatusModel;
  notice?: ComposerStatusNotice;
}): ReactElement => (
  <div className="awb-composer-status">
    <span className={`awb-composer-status__pill is-${status.kind}`}>
      {status.label}
    </span>
    {notice?.message ? (
      <span
        className={`awb-composer-status__notice is-${notice.severity ?? "info"}`}
        title={notice.message}
      >
        {notice.message}
      </span>
    ) : null}
  </div>
);
