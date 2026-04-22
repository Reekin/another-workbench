import type { ReactElement } from "react";
import type { ComposerIntent, QueuedComposerMessage } from "./composer-types.js";

const formatQueuedTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleTimeString();
};

export const ComposerQueue = ({
  queue,
  currentIntent,
  supportsSteer,
  onEdit,
  onDelete,
  onSendNow,
  onSteerNow
}: {
  queue: QueuedComposerMessage[];
  currentIntent: ComposerIntent;
  supportsSteer: boolean;
  onEdit: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  onSendNow: (messageId: string) => Promise<void>;
  onSteerNow: (messageId: string) => Promise<void>;
}): ReactElement | null => {
  if (queue.length === 0) {
    return null;
  }

  return (
    <div className="awb-composer-queue" aria-label="Queued follow-ups">
      {queue.map((item) => (
        <article key={item.id} className="awb-composer-queue__item">
          <div className="awb-composer-queue__copy">
            <strong>
              {item.text ||
                (item.skills.length > 0
                  ? "Skill-enabled follow-up"
                  : "Attachment-only follow-up")}
            </strong>
            <span>
              {item.skills.length} skill(s) · {item.attachments.length} attachment(s) ·{" "}
              {formatQueuedTime(item.createdAt)}
            </span>
          </div>
          <div className="awb-composer-queue__actions">
            <button type="button" onClick={() => onEdit(item.id)}>
              Edit
            </button>
            <button type="button" onClick={() => onDelete(item.id)}>
              Delete
            </button>
            {currentIntent === "send" ? (
              <button type="button" onClick={() => void onSendNow(item.id)}>
                Send now
              </button>
            ) : null}
            {supportsSteer && currentIntent !== "send" ? (
              <button type="button" onClick={() => void onSteerNow(item.id)}>
                Steer now
              </button>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
};
