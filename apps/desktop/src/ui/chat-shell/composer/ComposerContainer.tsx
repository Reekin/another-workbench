import type { ReactElement } from "react";
import type {
  ApprovalRequest,
  ChatSession,
  EngineSurfaceRpc,
  RuntimeInteraction,
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
import type {
  ComposerExecutionSelection,
  ComposerModelExecutionPreferences
} from "./composer-types.js";

export type ComposerContainerProps = {
  transport?: DesktopTransport;
  activeSession?: ChatSession;
  activeSessionId?: string;
  threadGoal?: ThreadGoal;
  displayedSessionId?: string;
  selectedEngineId: string;
  engineSurface?: EngineSurfaceRpc;
  allowedModelIds?: string[];
  customModelReasoningOptionIds?: Record<string, string[]>;
  modelExecutionPreferences?: ComposerModelExecutionPreferences;
  lastExecution?: ComposerExecutionSelection;
  activeWorkspaceId?: string;
  activeWorkspaceRootPath?: string;
  turns: Turn[];
  interruptTurns: Turn[];
  allowSessionLastTurnFallback?: boolean;
  approvals: ApprovalRequest[];
  interactions: RuntimeInteraction[];
  isOpeningSelectedSession: boolean;
  statusNotice?: ComposerStatusNotice;
  onStatusNotice: (notice: ComposerStatusNotice | undefined) => void;
  onPreviewImage?: (input: ImageLightboxState) => void;
  onCreateSession?: (workspaceId: string, engineId: string) => Promise<void>;
  onOpenSession?: (sessionId: string) => Promise<void>;
  onRequestTranscriptBottom?: (sessionId: string) => void;
  onExecutionPreferenceChange?: (
    engineId: string,
    execution: ComposerExecutionSelection
  ) => void;
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
  engineSurface,
  allowedModelIds,
  customModelReasoningOptionIds,
  modelExecutionPreferences,
  lastExecution,
  activeWorkspaceId,
  activeWorkspaceRootPath,
  turns,
  interruptTurns,
  allowSessionLastTurnFallback,
  approvals,
  interactions,
  isOpeningSelectedSession,
  statusNotice,
  onStatusNotice,
  onPreviewImage,
  onCreateSession,
  onOpenSession,
  onRequestTranscriptBottom,
  onExecutionPreferenceChange,
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
    engineSurface,
    allowedModelIds,
    customModelReasoningOptionIds,
    modelExecutionPreferences,
    lastExecution,
    activeWorkspaceId,
    activeWorkspaceRootPath,
    turns,
    interruptTurns,
    allowSessionLastTurnFallback,
    approvals,
    isOpeningSelectedSession,
    statusNotice,
    onStatusNotice,
    onCreateSession,
    onOpenSession,
    onRequestTranscriptBottom,
    onExecutionPreferenceChange
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
      intent={composer.intent}
      supportsSteer={composer.capabilities.supportsSteer}
      supportsAttachments={composer.capabilities.supportsAttachments}
      models={composer.models}
      selectedExecution={composer.execution}
      reasoningOptions={composer.reasoningOptions}
      serviceTiers={composer.serviceTiers}
      isExecutionLoading={composer.isExecutionLoading}
      isExecutionDisabled={composer.isExecutionDisabled}
      hasComposedInput={composer.hasComposedInput}
      isTurnActive={composer.isTurnActive}
      canSubmit={composer.canSubmit}
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
      onPrimaryAction={composer.onPrimaryAction}
      onStop={composer.onStop}
      onModelChange={composer.onModelChange}
      onReasoningOptionChange={composer.onReasoningOptionChange}
      onServiceTierChange={composer.onServiceTierChange}
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
