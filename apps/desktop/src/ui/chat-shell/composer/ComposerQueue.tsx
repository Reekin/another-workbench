import type { ReactElement } from "react";
import { Button } from "../Button.js";
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
            <Button variant="ghost" size="sm" onClick={() => onEdit(item.id)}>
              Edit
            </Button>
            <Button variant="danger" size="sm" onClick={() => onDelete(item.id)}>
              Delete
            </Button>
            {currentIntent === "send" ? (
              <Button variant="secondary" size="sm" onClick={() => void onSendNow(item.id)}>
                Send now
              </Button>
            ) : null}
            {supportsSteer && currentIntent !== "send" ? (
              <Button variant="secondary" size="sm" onClick={() => void onSteerNow(item.id)}>
                Steer now
              </Button>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
};
