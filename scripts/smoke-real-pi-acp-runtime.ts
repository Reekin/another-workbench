import { createWorkbenchRuntimeService } from "../apps/desktop-server/src/prod-service.js";

const timeoutMs = Number(process.env.AWB_SMOKE_TIMEOUT_MS ?? "120000");
const conversationId = `smoke-pi-${Date.now().toString(36)}`;

const waitFor = async (
  predicate: () => boolean,
  description: string
): Promise<void> => {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

const run = async (): Promise<void> => {
  const service = createWorkbenchRuntimeService();

  try {
    await service.executeCommand({
      commandId: "smoke-pi-create-session",
      command: {
        type: "createSession",
        agentId: "pi-acp",
        conversationId
      }
    });

    const sessionId = service.listSessions({
      conversationId,
      includeArchived: true
    })[0]?.sessionId;

    if (!sessionId) {
      throw new Error("Failed to create pi-acp smoke-test session.");
    }

    const messageChunks: string[] = [];
    const toolChunks: string[] = [];

    service.subscribe((envelope) => {
      if (envelope.event.type === "message.delta") {
        messageChunks.push(envelope.event.delta);
      }
      if (envelope.event.type === "tool.delta") {
        toolChunks.push(envelope.event.delta);
      }
    }, {
      conversationId
    });

    await service.executeCommand({
      commandId: "smoke-pi-send",
      command: {
        type: "sendUserMessage",
        sessionId,
        messageId: "smoke-pi-message-1",
        content: "Reply with exactly the word hi.",
        attachments: []
      }
    });

    await waitFor(
      () =>
        service
          .getSnapshot()
          .turns.some(
            (turn) => turn.sessionId === sessionId && turn.status === "completed"
          ),
      "completed real pi-acp turn"
    );

    const snapshot = service.getSnapshot();
    const transcriptText = snapshot.messageBlocks
      .filter((block) => block.sessionId === sessionId)
      .map((block) => block.text)
      .join("\n");
    const toolText = snapshot.toolCalls
      .filter((toolCall) => toolCall.sessionId === sessionId)
      .map((toolCall) => toolCall.outputSummary ?? "")
      .join("\n");

    if (!transcriptText.trim() && messageChunks.length === 0) {
      throw new Error("Real pi-acp smoke test did not capture any assistant transcript text.");
    }
    if (transcriptText.includes("ACP response") || transcriptText.includes("Codex response")) {
      throw new Error("Real pi-acp smoke test still saw demo placeholder text.");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          conversationId,
          sessionId,
          transcriptPreview: transcriptText.slice(0, 400),
          toolPreview: toolText.slice(0, 400),
          streamedMessagePreview: messageChunks.join("").slice(0, 400),
          streamedToolPreview: toolChunks.join("").slice(0, 400)
        },
        null,
        2
      )
    );
  } finally {
    await service.dispose();
  }
};

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
