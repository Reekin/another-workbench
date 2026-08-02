import type {
  ChangeEvent as ReactChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  RefObject
} from "react";
import type {
  ApprovalRequest,
  ContextUsage,
  RuntimeInteraction,
  ThreadGoal
} from "@another-workbench/shared";
import type { ComposerAttachment } from "../composer-attachments.js";
import type { ImageLightboxState } from "../ImageLightbox.js";
import {
  ApprovalFlowView,
  type ApprovalResponseInput
} from "../ApprovalFlowView.js";
import {
  InteractionFlowView,
  type InteractionResponseInput
} from "../InteractionFlowView.js";
import { ComposerQueue } from "./ComposerQueue.js";
import { ComposerStatusBar } from "./ComposerStatusBar.js";
import { ComposerSuggestions } from "./ComposerSuggestions.js";
import type {
  ComposerStatusModel,
  ComposerStatusNotice
} from "../composer-status.js";
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

const formatTokenCount = (value: number): string => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  }
  return String(value);
};

const contextUsagePercent = (contextUsage: ContextUsage): number | undefined => {
  if (!contextUsage.contextWindow) {
    return undefined;
  }
  return Math.min(
    100,
    Math.max(0, Math.round((contextUsage.usedTokens / contextUsage.contextWindow) * 100))
  );
};

const formatContextUsageLabel = (contextUsage: ContextUsage): string => {
  const percent = contextUsagePercent(contextUsage);
  const usedTokens = formatTokenCount(contextUsage.usedTokens);
  if (percent === undefined || !contextUsage.contextWindow) {
    return `${usedTokens} tokens`;
  }
  return `${percent}% · ${usedTokens}/${formatTokenCount(contextUsage.contextWindow)}`;
};

const threadGoalStatusLabel = (status: ThreadGoal["status"]): string => {
  switch (status) {
    case "budgetLimited":
      return "Budget";
    case "usageLimited":
      return "Usage";
    default:
      return status[0]?.toUpperCase() + status.slice(1);
  }
};

const formatThreadGoalUsage = (goal: ThreadGoal): string | undefined => {
  if (!goal.tokenBudget) {
    return goal.tokensUsed > 0 ? `${formatTokenCount(goal.tokensUsed)} tokens` : undefined;
  }
  return `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`;
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
  statusNotice,
  pendingApprovals = [],
  pendingInteractions = [],
  contextUsage,
  threadGoal,
  intent,
  supportsSteer,
  supportsAttachments,
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
  onPreviewAttachment,
  onPickAttachments,
  onPrimaryAction,
  onQueueCurrent,
  onStop,
  onSuggestionHover,
  onSuggestionSelect,
  onEditQueuedMessage,
  onDeleteQueuedMessage,
  onSendQueuedMessageNow,
  onSteerQueuedMessageNow,
  onRespondApproval,
  onRespondInteraction
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
  statusNotice?: ComposerStatusNotice;
  pendingApprovals?: ApprovalRequest[];
  pendingInteractions?: RuntimeInteraction[];
  contextUsage?: ContextUsage;
  threadGoal?: ThreadGoal;
  intent: ComposerIntent;
  supportsSteer: boolean;
  supportsAttachments: boolean;
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
  onPreviewAttachment?: (input: ImageLightboxState) => void;
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
  onRespondApproval?: (input: ApprovalResponseInput) => Promise<void>;
  onRespondInteraction?: (input: InteractionResponseInput) => Promise<void>;
}): ReactElement => {
  return (
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
              <button
                type="button"
                className="awb-composer__attachment-preview"
                onClick={() =>
                  onPreviewAttachment?.({
                    src: attachment.previewUrl ?? "",
                    alt: attachment.displayName
                  })
                }
                aria-label={`Preview ${attachment.displayName}`}
                disabled={!onPreviewAttachment}
              >
                <img src={attachment.previewUrl} alt={attachment.displayName} />
              </button>
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
    {pendingApprovals.length > 0 ? (
      <section className="awb-composer-approvals" aria-label="Pending approvals">
        <ApprovalFlowView
          approvals={pendingApprovals}
          onRespond={onRespondApproval}
        />
      </section>
    ) : null}
    {pendingInteractions.length > 0 ? (
      <section className="awb-composer-approvals" aria-label="Pending interactions">
        <InteractionFlowView
          interactions={pendingInteractions}
          onRespond={onRespondInteraction}
        />
      </section>
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
      />
      <ComposerSuggestions
        suggestions={suggestions}
        onHover={onSuggestionHover}
        onSelect={onSuggestionSelect}
      />
    </div>
    <div className="awb-composer__actions awb-composer-panel__actions">
      <div className="awb-composer__meta">
        <ComposerStatusBar status={status} notice={statusNotice} />
        {contextUsage ? (
          <div
            className="awb-composer-context"
            aria-label={`Context usage ${formatContextUsageLabel(contextUsage)}`}
            tabIndex={0}
            style={
              {
                "--awb-composer-context-percent": `${
                  contextUsagePercent(contextUsage) ?? 0
                }%`
              } as CSSProperties
            }
          >
            <span className="awb-composer-context__ring" aria-hidden="true" />
            <span className="awb-composer-context__tooltip" role="tooltip">
              Context {formatContextUsageLabel(contextUsage)}
            </span>
          </div>
        ) : null}
        {threadGoal ? (
          <div
            className={`awb-composer-goal awb-composer-goal--${threadGoal.status}`}
            aria-label={`Goal ${threadGoalStatusLabel(threadGoal.status)}: ${threadGoal.objective}`}
            title={threadGoal.objective}
          >
            <span className="awb-composer-goal__dot" aria-hidden="true" />
            <span className="awb-composer-goal__label">Goal</span>
            <span className="awb-composer-goal__status">
              {threadGoalStatusLabel(threadGoal.status)}
            </span>
            <span className="awb-composer-goal__objective">
              {threadGoal.objective}
            </span>
            {formatThreadGoalUsage(threadGoal) ? (
              <span className="awb-composer-goal__usage">
                {formatThreadGoalUsage(threadGoal)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="awb-composer__buttons">
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
        <span>
          <button
            type="button"
            onClick={() => void onPrimaryAction()}
            disabled={!canSubmit}
          >
            {primaryLabel(intent)}
          </button>
        </span>
      </div>
    </div>
  </footer>
  );
};
