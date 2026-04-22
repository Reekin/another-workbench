import type {
  ChangeEvent as ReactChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  RefObject
} from "react";
import type { ComposerAttachment } from "../composer-attachments.js";
import { ComposerQueue } from "./ComposerQueue.js";
import { ComposerStatusBar } from "./ComposerStatusBar.js";
import { ComposerSuggestions } from "./ComposerSuggestions.js";
import type { ComposerStatusModel } from "../composer-status.js";
import type {
  ComposerIntent,
  ComposerSkillReference,
  QueuedComposerMessage,
  ComposerSuggestionState
} from "./composer-types.js";

const primaryLabel = (intent: ComposerIntent): string => {
  switch (intent) {
    case "steer":
      return "Steer";
    case "queue":
      return "Queue";
    default:
      return "Send";
  }
};

export const ComposerPanel = ({
  isDropTarget,
  fileInputRef,
  textareaRef,
  draft,
  selectedSkills,
  attachments,
  queue,
  suggestions,
  status,
  intent,
  supportsSteer,
  canSubmit,
  canQueue,
  canStop,
  isDispatching,
  onTextareaChange,
  onTextareaSelect,
  onInputKeyDown,
  onPaste,
  onFileInputChange,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onRemoveSkill,
  onRemoveAttachment,
  onPickAttachments,
  onPrimaryAction,
  onQueueCurrent,
  onStop,
  onSuggestionHover,
  onSuggestionSelect,
  onEditQueuedMessage,
  onDeleteQueuedMessage,
  onSendQueuedMessageNow,
  onSteerQueuedMessageNow
}: {
  isDropTarget: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  selectedSkills: ComposerSkillReference[];
  attachments: ComposerAttachment[];
  queue: QueuedComposerMessage[];
  suggestions: ComposerSuggestionState | undefined;
  status: ComposerStatusModel;
  intent: ComposerIntent;
  supportsSteer: boolean;
  canSubmit: boolean;
  canQueue: boolean;
  canStop: boolean;
  isDispatching: boolean;
  onTextareaChange: (value: string, selectionStart?: number | null) => void;
  onTextareaSelect: (selectionStart: number) => void;
  onInputKeyDown: (
    event: ReactKeyboardEvent<HTMLTextAreaElement>
  ) => Promise<void>;
  onPaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  onFileInputChange: (event: ReactChangeEvent<HTMLInputElement>) => void;
  onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
  onRemoveSkill: (skillId: string) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onPickAttachments: () => void;
  onPrimaryAction: () => Promise<void>;
  onQueueCurrent: () => void;
  onStop: () => Promise<void>;
  onSuggestionHover: (index: number) => void;
  onSuggestionSelect: (index: number) => Promise<void>;
  onEditQueuedMessage: (messageId: string) => void;
  onDeleteQueuedMessage: (messageId: string) => void;
  onSendQueuedMessageNow: (messageId: string) => Promise<void>;
  onSteerQueuedMessageNow: (messageId: string) => Promise<void>;
}): ReactElement => (
  <footer
    className={`awb-composer awb-composer-panel${
      isDropTarget ? " is-drop-target" : ""
    }`}
    onDragEnter={onDragEnter}
    onDragOver={onDragOver}
    onDragLeave={onDragLeave}
    onDrop={onDrop}
  >
    <input
      ref={fileInputRef}
      className="awb-composer__file-input"
      type="file"
      multiple
      onChange={onFileInputChange}
    />
    <ComposerQueue
      queue={queue}
      currentIntent={intent}
      supportsSteer={supportsSteer}
      onEdit={onEditQueuedMessage}
      onDelete={onDeleteQueuedMessage}
      onSendNow={onSendQueuedMessageNow}
      onSteerNow={onSteerQueuedMessageNow}
    />
    {selectedSkills.length > 0 ? (
      <div className="awb-composer-skills" aria-label="Selected skills">
        {selectedSkills.map((skill) => (
          <article key={skill.id} className="awb-composer-skill">
            <div className="awb-composer-skill__copy">
              <strong>{`$${skill.name}`}</strong>
              <span>{skill.shortDescription ?? skill.description ?? skill.path}</span>
            </div>
            <button
              type="button"
              className="awb-ghost-button awb-composer-skill__remove"
              onClick={() => onRemoveSkill(skill.id)}
            >
              Remove
            </button>
          </article>
        ))}
      </div>
    ) : null}
    {attachments.length > 0 ? (
      <div className="awb-composer__attachments" aria-label="Composer attachments">
        {attachments.map((attachment) => (
          <article
            key={attachment.attachment.attachmentId}
            className="awb-composer__attachment"
          >
            {attachment.previewUrl ? (
              <img
                className="awb-composer__attachment-preview"
                src={attachment.previewUrl}
                alt={attachment.displayName}
              />
            ) : (
              <div className="awb-composer__attachment-icon" aria-hidden="true">
                FILE
              </div>
            )}
            <div className="awb-composer__attachment-copy">
              <strong>{attachment.displayName}</strong>
              <span>
                {attachment.mimeType} · {attachment.sizeLabel}
              </span>
            </div>
            <button
              type="button"
              className="awb-ghost-button awb-composer__attachment-remove"
              onClick={() => onRemoveAttachment(attachment.attachment.attachmentId)}
            >
              Remove
            </button>
          </article>
        ))}
      </div>
    ) : null}
    <div className="awb-composer-panel__editor">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) =>
          onTextareaChange(
            event.target.value,
            event.currentTarget.selectionStart
          )
        }
        onSelect={(event) => onTextareaSelect(event.currentTarget.selectionStart ?? 0)}
        onClick={(event) => onTextareaSelect(event.currentTarget.selectionStart ?? 0)}
        onKeyUp={(event) => onTextareaSelect(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={(event) => void onInputKeyDown(event)}
        onPaste={onPaste}
        placeholder="Message the active session, use / for actions, $ for skills, or drop files here..."
      />
      <ComposerSuggestions
        suggestions={suggestions}
        onHover={onSuggestionHover}
        onSelect={onSuggestionSelect}
      />
    </div>
    <div className="awb-composer__actions awb-composer-panel__actions">
      <ComposerStatusBar status={status} intent={intent} />
      <div className="awb-composer__buttons">
        <button
          type="button"
          className="awb-ghost-button"
          onClick={onPickAttachments}
          disabled={isDispatching}
        >
          Attach files
        </button>
        {canQueue ? (
          <button
            type="button"
            className="awb-ghost-button"
            onClick={onQueueCurrent}
            disabled={!canQueue}
          >
            Queue
          </button>
        ) : null}
        {canStop ? (
          <button
            type="button"
            className="awb-ghost-button"
            onClick={() => void onStop()}
            disabled={!canStop}
          >
            Stop
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void onPrimaryAction()}
          disabled={!canSubmit}
        >
          {primaryLabel(intent)}
        </button>
      </div>
    </div>
  </footer>
);
