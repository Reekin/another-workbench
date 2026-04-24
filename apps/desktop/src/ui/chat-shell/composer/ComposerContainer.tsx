import type { ReactElement } from "react";
import type {
  ApprovalRequest,
  ChatSession,
  Turn
} from "@another-workbench/shared";
import type { DesktopTransport } from "../../../transport/desktop-transport.js";
import type { ComposerStatusNotice } from "../composer-status.js";
import { useComposerController } from "../use-composer-controller.js";
import { ComposerPanel } from "./ComposerPanel.js";

export type ComposerContainerProps = {
  transport?: DesktopTransport;
  activeSession?: ChatSession;
  activeSessionId?: string;
  displayedSessionId?: string;
  selectedEngineId: string;
  activeWorkspaceId?: string;
  activeWorkspaceRootPath?: string;
  turns: Turn[];
  approvals: ApprovalRequest[];
  isOpeningSelectedSession: boolean;
  statusNotice?: ComposerStatusNotice;
  onStatusNotice: (notice: ComposerStatusNotice | undefined) => void;
  onCreateSession?: (workspaceId: string, engineId: string) => Promise<void>;
  onOpenSession?: (sessionId: string) => Promise<void>;
};

export const ComposerContainer = ({
  transport,
  activeSession,
  activeSessionId,
  displayedSessionId,
  selectedEngineId,
  activeWorkspaceId,
  activeWorkspaceRootPath,
  turns,
  approvals,
  isOpeningSelectedSession,
  statusNotice,
  onStatusNotice,
  onCreateSession,
  onOpenSession
}: ComposerContainerProps): ReactElement => {
  const composer = useComposerController({
    transport,
    activeSession,
    activeSessionId,
    displayedSessionId,
    selectedEngineId,
    activeWorkspaceId,
    activeWorkspaceRootPath,
    turns,
    approvals,
    isOpeningSelectedSession,
    statusNotice,
    onStatusNotice,
    onCreateSession,
    onOpenSession
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
      onPickAttachments={composer.onPickAttachments}
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
    />
  );
};
