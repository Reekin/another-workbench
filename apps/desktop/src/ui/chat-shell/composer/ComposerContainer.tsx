import type { ReactElement } from "react";
import type {
  ApprovalRequest,
  ChatSession,
  RuntimeInteraction,
  TakeoverPresetSummaryRpc,
  TakeoverSessionStateRpc,
  ThreadGoal,
  Turn
} from "@another-workbench/shared";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import type { ImageLightboxState } from "../ImageLightbox.js";
import type { ComposerStatusNotice } from "../composer-status.js";
import type { ApprovalResponseInput } from "../ApprovalFlowView.js";
import type { InteractionResponseInput } from "../InteractionFlowView.js";
import { useComposerController } from "../use-composer-controller.js";
import { ComposerPanel } from "./ComposerPanel.js";

export type ComposerContainerProps = {
  transport?: DesktopTransport;
  activeSession?: ChatSession;
  activeSessionId?: string;
  threadGoal?: ThreadGoal;
  displayedSessionId?: string;
  selectedEngineId: string;
  activeWorkspaceId?: string;
  activeWorkspaceRootPath?: string;
  turns: Turn[];
  allowSessionLastTurnFallback?: boolean;
  approvals: ApprovalRequest[];
  interactions: RuntimeInteraction[];
  takeoverPresets: TakeoverPresetSummaryRpc[];
  takeoverState?: TakeoverSessionStateRpc;
  isTakeoverMenuOpen: boolean;
  isOpeningSelectedSession: boolean;
  statusNotice?: ComposerStatusNotice;
  onStatusNotice: (notice: ComposerStatusNotice | undefined) => void;
  onPreviewImage?: (input: ImageLightboxState) => void;
  onCreateSession?: (workspaceId: string, engineId: string) => Promise<void>;
  onOpenSession?: (sessionId: string) => Promise<void>;
  onRequestTranscriptBottom?: (sessionId: string) => void;
  onToggleTakeoverMenu: () => void;
  onSelectTakeoverPreset: (presetId?: string) => Promise<void>;
  onOpenTakeoverContextEditor: () => void;
  onRespondApproval?: (input: ApprovalResponseInput) => Promise<void>;
  onRespondInteraction?: (input: InteractionResponseInput) => Promise<void>;
};

export const ComposerContainer = ({
  transport,
  activeSession,
  activeSessionId,
  threadGoal,
  displayedSessionId,
  selectedEngineId,
  activeWorkspaceId,
  activeWorkspaceRootPath,
  turns,
  allowSessionLastTurnFallback,
  approvals,
  interactions,
  takeoverPresets,
  takeoverState,
  isTakeoverMenuOpen,
  isOpeningSelectedSession,
  statusNotice,
  onStatusNotice,
  onPreviewImage,
  onCreateSession,
  onOpenSession,
  onRequestTranscriptBottom,
  onToggleTakeoverMenu,
  onSelectTakeoverPreset,
  onOpenTakeoverContextEditor,
  onRespondApproval,
  onRespondInteraction
}: ComposerContainerProps): ReactElement => {
  const composer = useComposerController({
    transport,
    activeSession,
    activeSessionId,
    threadGoal,
    displayedSessionId,
    selectedEngineId,
    activeWorkspaceId,
    activeWorkspaceRootPath,
    turns,
    allowSessionLastTurnFallback,
    approvals,
    isTakeoverManaged: takeoverState?.role === "managed",
    isOpeningSelectedSession,
    statusNotice,
    onStatusNotice,
    onCreateSession,
    onOpenSession,
    onRequestTranscriptBottom
  });

  return (
    <ComposerPanel
      isDropTarget={composer.isDropTarget}
      fileInputRef={composer.composerFileInputRef}
      textareaRef={composer.composerTextareaRef}
      draft={composer.draft}
      selectedSkills={composer.selectedSkills}
      attachments={composer.attachments}
      queue={composer.queue}
      suggestions={composer.suggestions}
      status={composer.status}
      statusNotice={statusNotice}
      pendingApprovals={approvals.filter((approval) => approval.status === "pending")}
      pendingInteractions={interactions.filter(
        (interaction) => interaction.status === "pending"
      )}
      contextUsage={activeSession?.contextUsage}
      threadGoal={threadGoal}
      takeoverPresets={takeoverPresets}
      takeoverState={takeoverState}
      isTakeoverMenuOpen={isTakeoverMenuOpen}
      onOpenTakeoverContextEditor={onOpenTakeoverContextEditor}
      intent={composer.intent}
      supportsSteer={composer.capabilities.supportsSteer}
      supportsAttachments={composer.capabilities.supportsAttachments}
      canSubmit={composer.canSubmit}
      canQueue={composer.canQueue}
      canStop={composer.canStop}
      isDispatching={composer.isDispatching}
      onTextareaChange={composer.onDraftChange}
      onTextareaSelect={composer.onTextareaSelect}
      onInputKeyDown={composer.onInputKeyDown}
      onPaste={composer.onComposerPaste}
      onFileInputChange={composer.onComposerInputChange}
      onDragEnter={composer.onComposerDragEnter}
      onDragOver={composer.onComposerDragOver}
      onDragLeave={composer.onComposerDragLeave}
      onDrop={composer.onComposerDrop}
      onRemoveSkill={composer.onRemoveSkill}
      onRemoveAttachment={composer.onRemoveAttachment}
      onPreviewAttachment={onPreviewImage}
      onPickAttachments={composer.onPickAttachments}
      onToggleTakeoverMenu={onToggleTakeoverMenu}
      onSelectTakeoverPreset={onSelectTakeoverPreset}
      onPrimaryAction={composer.onPrimaryAction}
      onQueueCurrent={composer.onQueueCurrent}
      onStop={composer.onStop}
      onSuggestionHover={composer.onSuggestionHover}
      onSuggestionSelect={async (index) => {
        const item = composer.suggestions?.items[index];
        if (item) {
          await composer.onSuggestionSelect(item);
        }
      }}
      onEditQueuedMessage={composer.onEditQueuedMessage}
      onDeleteQueuedMessage={composer.onDeleteQueuedMessage}
      onSendQueuedMessageNow={composer.onSendQueuedMessageNow}
      onSteerQueuedMessageNow={composer.onSteerQueuedMessageNow}
      onRespondApproval={onRespondApproval}
      onRespondInteraction={onRespondInteraction}
    />
  );
};
