import { createCodexWorkbenchRuntimeService } from "../apps/desktop-server/src/prod-service.js";

const timeoutMs = Number(process.env.AWB_SMOKE_TIMEOUT_MS ?? "120000");
const conversationId = `smoke-${Date.now().toString(36)}`;

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
  const service = createCodexWorkbenchRuntimeService();

  try {
  await service.executeCommand({
    commandId: "smoke-create-session",
    command: {
      type: "createSession",
      agentId: "codex",
      conversationId
    }
  });

  const sessionId = service.listSessions({
    conversationId,
    includeArchived: true
  })[0]?.sessionId;

  if (!sessionId) {
    throw new Error("Failed to create smoke-test session.");
  }

  const messageChunks: string[] = [];
  const terminalChunks: string[] = [];
  const toolNames: string[] = [];

  service.subscribe((envelope) => {
    if (envelope.event.type === "message.delta") {
      messageChunks.push(envelope.event.delta);
    }
    if (envelope.event.type === "terminal.output") {
      terminalChunks.push(envelope.event.chunk);
    }
    if (envelope.event.type === "tool.started") {
      toolNames.push(envelope.event.toolName);
    }
  }, {
    conversationId
  });

  await service.executeCommand({
    commandId: "smoke-send",
    command: {
      type: "sendUserMessage",
      sessionId,
      messageId: "smoke-message-1",
      content:
        "Use one shell command to print the current working directory, then answer in one short sentence with that result.",
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
    "completed real Codex turn"
  );

  const snapshot = service.getSnapshot();
  const transcriptText = snapshot.messageBlocks
    .filter((block) => block.sessionId === sessionId)
    .map((block) => block.text)
    .join("\n");
  const terminalText = snapshot.terminalStreams
    .filter((stream) => stream.sessionId === sessionId)
    .map((stream) => stream.outputText)
    .join("\n");

  if (!transcriptText.trim()) {
    throw new Error("Real smoke test did not capture any assistant transcript text.");
  }
  if (transcriptText.includes("Codex response")) {
    throw new Error("Real smoke test still saw demo placeholder text.");
  }
  if (toolNames.length === 0 && snapshot.toolCalls.length === 0) {
    throw new Error("Real smoke test did not observe any tool execution.");
  }
  if (!terminalText.trim() && terminalChunks.length === 0) {
    throw new Error("Real smoke test did not observe any terminal output.");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        conversationId,
        sessionId,
        toolNames,
        transcriptPreview: transcriptText.slice(0, 400),
        terminalPreview: terminalText.slice(0, 400)
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
