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
  TakeoverPresetSummaryRpc,
  TakeoverSessionStateRpc
} from "@another-workbench/shared";
import type { ComposerAttachment } from "../composer-attachments.js";
import type { ImageLightboxState } from "../ImageLightbox.js";
import {
  ApprovalFlowView,
  type ApprovalResponseInput
} from "../ApprovalFlowView.js";
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
  contextUsage,
  takeoverPresets = [],
  takeoverState,
  isTakeoverMenuOpen = false,
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
  onToggleTakeoverMenu = () => undefined,
  onSelectTakeoverPreset = async () => undefined,
  onOpenTakeoverContextEditor = () => undefined,
  onPrimaryAction,
  onQueueCurrent,
  onStop,
  onSuggestionHover,
  onSuggestionSelect,
  onEditQueuedMessage,
  onDeleteQueuedMessage,
  onSendQueuedMessageNow,
  onSteerQueuedMessageNow,
  onRespondApproval
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
  contextUsage?: ContextUsage;
  takeoverPresets?: TakeoverPresetSummaryRpc[];
  takeoverState?: TakeoverSessionStateRpc;
  isTakeoverMenuOpen?: boolean;
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
  onToggleTakeoverMenu?: () => void;
  onSelectTakeoverPreset?: (presetId?: string) => Promise<void>;
  onOpenTakeoverContextEditor?: () => void;
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
}): ReactElement => {
  const activeTakeoverPresetId =
    takeoverState?.presetId ?? takeoverState?.manualPresetId;
  const isTakeoverManaged = takeoverState?.role === "managed";
  const isTakeoverResponding = isTakeoverManaged && takeoverState.active;
  const selectedTakeoverLabel =
    takeoverPresets.find((preset) => preset.presetId === activeTakeoverPresetId)
      ?.displayName ?? activeTakeoverPresetId ?? "No takeover";
  const takeoverTooltip =
    isTakeoverManaged
      ? `Current session is in takeover mode${takeoverState.presetId ? ` (${takeoverState.presetId})` : ""}.`
      : "Select a takeover preset for this session.";
  const submitTitle =
    isTakeoverManaged
      ? `Current session is in takeover mode${takeoverState.presetId ? ` (${takeoverState.presetId})` : ""}.`
      : undefined;
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
    <div
      className={`awb-composer-panel__editor${
        isTakeoverResponding ? " is-takeover-responding" : ""
      }`}
    >
      <textarea
        ref={textareaRef}
        value={draft}
        disabled={isTakeoverResponding}
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
      {isTakeoverResponding ? (
        <div className="awb-composer-takeover-responding" aria-live="polite">
          <span>Takeover responding</span>
          <span className="awb-composer-takeover-responding__dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      ) : null}
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
      </div>
      <div className="awb-composer__buttons">
        <div className="awb-composer-takeover">
          {isTakeoverManaged ? (
            <button
              type="button"
              className="awb-ghost-button awb-composer-takeover__edit"
              onClick={onOpenTakeoverContextEditor}
              title="Edit takeover context"
              aria-label="Edit takeover context"
            >
              Edit
            </button>
          ) : null}
          <button
            type="button"
            className={`awb-ghost-button awb-composer-takeover__button${
              activeTakeoverPresetId ? " is-active" : ""
            }`}
            onClick={onToggleTakeoverMenu}
            title={takeoverTooltip}
            aria-haspopup="menu"
            aria-expanded={isTakeoverMenuOpen}
          >
            <span className="awb-composer-takeover__button-label">Takeover</span>
            <strong>{selectedTakeoverLabel}</strong>
          </button>
          {isTakeoverMenuOpen ? (
            <div
              className="awb-composer-takeover__menu"
              role="menu"
              aria-label="Takeover presets"
            >
              <div className="awb-composer-takeover__menu-header">
                <strong>Takeover preset</strong>
                <span>Manual supervision for this session</span>
              </div>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!activeTakeoverPresetId}
                className={!activeTakeoverPresetId ? "is-active" : undefined}
                onClick={() => void onSelectTakeoverPreset(undefined)}
              >
                <span className="awb-composer-takeover__radio" aria-hidden="true" />
                <span className="awb-composer-takeover__menu-copy">
                  <strong>No takeover</strong>
                  <span>Keep direct control</span>
                </span>
              </button>
              {takeoverPresets.map((preset) => (
                <button
                  type="button"
                  key={preset.presetId}
                  role="menuitemradio"
                  aria-checked={activeTakeoverPresetId === preset.presetId}
                  className={
                    activeTakeoverPresetId === preset.presetId ? "is-active" : undefined
                  }
                  onClick={() => void onSelectTakeoverPreset(preset.presetId)}
                >
                  <span className="awb-composer-takeover__radio" aria-hidden="true" />
                  <span className="awb-composer-takeover__menu-copy">
                    <strong>{preset.displayName}</strong>
                    <span>{preset.presetId}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
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
        <span title={submitTitle}>
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
