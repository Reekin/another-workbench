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
        canSubmit={true}
        canQueue={false}
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
        onQueueCurrent={() => undefined}
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
        canSubmit={true}
        canQueue={false}
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
        onQueueCurrent={() => undefined}
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
        canSubmit={true}
        canQueue={false}
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
        onQueueCurrent={() => undefined}
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
        canSubmit={false}
        canQueue={false}
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
        onQueueCurrent={() => undefined}
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
    expect(html.indexOf("awb-composer-approvals")).toBeLessThan(
      html.indexOf("<textarea")
    );
  });
});
