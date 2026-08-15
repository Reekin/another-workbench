import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerPanel } from "../src/ui/chat-shell/composer/ComposerPanel.js";
import type { ComposerAttachment } from "../src/ui/chat-shell/composer-attachments.js";

const imageAttachment = (
  attachmentId: string,
  name: string,
  previewUrl: string
): ComposerAttachment => ({
  attachment: {
    attachmentId,
    mimeType: "image/png",
    name,
    uri: previewUrl
  },
  dedupeKey: attachmentId,
  displayName: name,
  isImage: true,
  mimeType: "image/png",
  previewUrl,
  releasePreviewUrl: false,
  size: 4,
  sizeLabel: "4 B"
});

describe("ComposerPanel", () => {
  it("renders provider-native model and reasoning options and locks them while steering", () => {
    const html = renderToStaticMarkup(
      <ComposerPanel
        isDropTarget={false}
        fileInputRef={{ current: null }}
        textareaRef={{ current: null }}
        draft="Refine the current turn"
        selectedSkills={[]}
        attachments={[]}
        queue={[]}
        suggestions={undefined}
        status={{ kind: "running", label: "Running" }}
        intent="steer"
        supportsSteer={true}
        supportsAttachments={true}
        models={[
          {
            modelId: "gpt-5.5-codex",
            displayName: "GPT-5.5 Codex",
            reasoningOptions: [
              { optionId: "xhigh", displayName: "Extra high" }
            ],
            isDefault: true
          }
        ]}
        selectedExecution={{
          modelId: "gpt-5.5-codex",
          reasoningOptionId: "xhigh"
        }}
        reasoningOptions={[
          { optionId: "xhigh", displayName: "Extra high" }
        ]}
        isExecutionLoading={false}
        isExecutionDisabled={true}
        hasComposedInput={true}
        isTurnActive={true}
        canSubmit={true}
        canStop={true}
        isDispatching={false}
        onTextareaChange={() => undefined}
        onTextareaSelect={() => undefined}
        onInputKeyDown={async () => undefined}
        onPaste={() => undefined}
        onFileInputChange={() => undefined}
        onDragEnter={() => undefined}
        onDragOver={() => undefined}
        onDragLeave={() => undefined}
        onDrop={() => undefined}
        onRemoveSkill={() => undefined}
        onRemoveAttachment={() => undefined}
        onPickAttachments={() => undefined}
        onPrimaryAction={async () => undefined}
        onStop={async () => undefined}
        onModelChange={() => undefined}
        onReasoningOptionChange={() => undefined}
        onSuggestionHover={() => undefined}
        onSuggestionSelect={async () => undefined}
        onEditQueuedMessage={() => undefined}
        onDeleteQueuedMessage={() => undefined}
        onSendQueuedMessageNow={async () => undefined}
        onSteerQueuedMessageNow={async () => undefined}
      />
    );

    expect(html).toContain('aria-label="Model"');
    expect(html).toContain('value="gpt-5.5-codex" selected=""');
    expect(html).toContain('value="xhigh" selected=""');
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain(">Default<");
    expect(html).toContain(">Steer<");
    expect(html).not.toContain(">Queue<");
    expect(html.indexOf("awb-composer__primary-action")).toBeLessThan(
      html.indexOf("awb-composer__actions awb-composer-panel__actions")
    );
  });

  it("renders multiple image attachments with preview actions", () => {
    const html = renderToStaticMarkup(
      <ComposerPanel
        isDropTarget={false}
        fileInputRef={{ current: null }}
        textareaRef={{ current: null }}
        draft=""
        selectedSkills={[]}
        attachments={[
          imageAttachment("image-1", "first.png", "data:image/png;base64,AAAA"),
          imageAttachment("image-2", "second.png", "data:image/png;base64,BBBB")
        ]}
        queue={[]}
        suggestions={undefined}
        status={{ kind: "idle", label: "Ready" }}
        intent="send"
        supportsSteer={true}
        supportsAttachments={true}
        hasComposedInput={true}
        isTurnActive={false}
        canSubmit={true}
        canStop={false}
        isDispatching={false}
        onTextareaChange={() => undefined}
        onTextareaSelect={() => undefined}
        onInputKeyDown={async () => undefined}
        onPaste={() => undefined}
        onFileInputChange={() => undefined}
        onDragEnter={() => undefined}
        onDragOver={() => undefined}
        onDragLeave={() => undefined}
        onDrop={() => undefined}
        onRemoveSkill={() => undefined}
        onRemoveAttachment={() => undefined}
        onPreviewAttachment={() => undefined}
        onPickAttachments={() => undefined}
        onPrimaryAction={async () => undefined}
        onStop={async () => undefined}
        onSuggestionHover={() => undefined}
        onSuggestionSelect={async () => undefined}
        onEditQueuedMessage={() => undefined}
        onDeleteQueuedMessage={() => undefined}
        onSendQueuedMessageNow={async () => undefined}
        onSteerQueuedMessageNow={async () => undefined}
      />
    );

    expect((html.match(/class="awb-composer__attachment"/g) ?? []).length).toBe(2);
    expect((html.match(/class="awb-composer__attachment-preview"/g) ?? []).length).toBe(2);
    expect(html).toContain("Preview first.png");
    expect(html).toContain("Preview second.png");
    expect(html).toContain("multiple=\"\"");
  });

  it("shows active session context usage when available", () => {
    const html = renderToStaticMarkup(
      <ComposerPanel
        isDropTarget={false}
        fileInputRef={{ current: null }}
        textareaRef={{ current: null }}
        draft=""
        selectedSkills={[]}
        attachments={[]}
        queue={[]}
        suggestions={undefined}
        status={{ kind: "idle", label: "Ready" }}
        contextUsage={{
          usedTokens: 42000,
          contextWindow: 128000,
          inputTokens: 40000,
          cachedInputTokens: 12000,
          outputTokens: 1200,
          reasoningOutputTokens: 800,
          lastUsedTokens: 2200
        }}
        intent="send"
        supportsSteer={true}
        supportsAttachments={true}
        hasComposedInput={false}
        isTurnActive={false}
        canSubmit={true}
        canStop={false}
        isDispatching={false}
        onTextareaChange={() => undefined}
        onTextareaSelect={() => undefined}
        onInputKeyDown={async () => undefined}
        onPaste={() => undefined}
        onFileInputChange={() => undefined}
        onDragEnter={() => undefined}
        onDragOver={() => undefined}
        onDragLeave={() => undefined}
        onDrop={() => undefined}
        onRemoveSkill={() => undefined}
        onRemoveAttachment={() => undefined}
        onPreviewAttachment={() => undefined}
        onPickAttachments={() => undefined}
        onPrimaryAction={async () => undefined}
        onStop={async () => undefined}
        onSuggestionHover={() => undefined}
        onSuggestionSelect={async () => undefined}
        onEditQueuedMessage={() => undefined}
        onDeleteQueuedMessage={() => undefined}
        onSendQueuedMessageNow={async () => undefined}
        onSteerQueuedMessageNow={async () => undefined}
      />
    );

    expect(html).toContain("Context 33% · 42.0k/128k");
    expect(html).toContain("--awb-composer-context-percent:33%");
    expect(html).not.toContain('title="Context 33% · 42.0k/128k"');
    expect(html).not.toContain("awb-composer-context__track");
  });

  it("renders the goal badge as passive status text", () => {
    const html = renderToStaticMarkup(
      <ComposerPanel
        isDropTarget={false}
        fileInputRef={{ current: null }}
        textareaRef={{ current: null }}
        draft=""
        selectedSkills={[]}
        attachments={[]}
        queue={[]}
        suggestions={undefined}
        status={{ kind: "idle", label: "Ready" }}
        threadGoal={{
          sessionId: "session-1",
          threadId: "thread-1",
          objective: "Keep the goal badge tidy",
          status: "active",
          tokenBudget: 12000,
          tokensUsed: 4000,
          timeUsedSeconds: 10,
          createdAt: 1700000000000,
          updatedAt: 1700000001000
        }}
        intent="send"
        supportsSteer={true}
        supportsAttachments={true}
        hasComposedInput={false}
        isTurnActive={false}
        canSubmit={true}
        canStop={false}
        isDispatching={false}
        onTextareaChange={() => undefined}
        onTextareaSelect={() => undefined}
        onInputKeyDown={async () => undefined}
        onPaste={() => undefined}
        onFileInputChange={() => undefined}
        onDragEnter={() => undefined}
        onDragOver={() => undefined}
        onDragLeave={() => undefined}
        onDrop={() => undefined}
        onRemoveSkill={() => undefined}
        onRemoveAttachment={() => undefined}
        onPreviewAttachment={() => undefined}
        onPickAttachments={() => undefined}
        onPrimaryAction={async () => undefined}
        onStop={async () => undefined}
        onSuggestionHover={() => undefined}
        onSuggestionSelect={async () => undefined}
        onEditQueuedMessage={() => undefined}
        onDeleteQueuedMessage={() => undefined}
        onSendQueuedMessageNow={async () => undefined}
        onSteerQueuedMessageNow={async () => undefined}
      />
    );

    expect(html).toContain("Keep the goal badge tidy");
    expect(html).toContain("4.0k/12.0k");
    expect(html).toContain('class="awb-composer-goal awb-composer-goal--active"');
    expect(html).not.toContain("tabindex");
  });

  it("renders pending approval controls above the editor", () => {
    const html = renderToStaticMarkup(
      <ComposerPanel
        isDropTarget={false}
        fileInputRef={{ current: null }}
        textareaRef={{ current: null }}
        draft=""
        selectedSkills={[]}
        attachments={[]}
        queue={[]}
        suggestions={undefined}
        status={{ kind: "awaiting_approval", label: "Awaiting approval" }}
        pendingApprovals={[
          {
            requestId: "approval-1",
            sessionId: "session-1",
            turnId: "turn-1",
            approvalKind: "command",
            status: "pending",
            title: "Run shell command",
            details: "echo hello",
            requestedAt: "2026-04-26T00:00:00.000Z"
          }
        ]}
        intent="send"
        supportsSteer={true}
        supportsAttachments={true}
        hasComposedInput={false}
        isTurnActive={true}
        canSubmit={false}
        canStop={false}
        isDispatching={false}
        onTextareaChange={() => undefined}
        onTextareaSelect={() => undefined}
        onInputKeyDown={async () => undefined}
        onPaste={() => undefined}
        onFileInputChange={() => undefined}
        onDragEnter={() => undefined}
        onDragOver={() => undefined}
        onDragLeave={() => undefined}
        onDrop={() => undefined}
        onRemoveSkill={() => undefined}
        onRemoveAttachment={() => undefined}
        onPreviewAttachment={() => undefined}
        onPickAttachments={() => undefined}
        onPrimaryAction={async () => undefined}
        onStop={async () => undefined}
        onSuggestionHover={() => undefined}
        onSuggestionSelect={async () => undefined}
        onEditQueuedMessage={() => undefined}
        onDeleteQueuedMessage={() => undefined}
        onSendQueuedMessageNow={async () => undefined}
        onSteerQueuedMessageNow={async () => undefined}
        onRespondApproval={async () => undefined}
      />
    );

    expect(html).toContain('aria-label="Pending approvals"');
    expect(html).toContain("Run shell command");
    expect(html).toContain("echo hello");
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Stop<");
    expect(html).not.toContain(">Queue<");
    expect(html.indexOf("awb-composer-approvals")).toBeLessThan(
      html.indexOf("<textarea")
    );
  });
});
