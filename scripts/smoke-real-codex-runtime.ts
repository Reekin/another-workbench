import { createCodexWorkbenchRuntimeService } from "../apps/desktop-server/src/prod-service.js";

const timeoutMs = Number(process.env.AWB_SMOKE_TIMEOUT_MS ?? "120000");
const conversationId = `smoke-${Date.now().toString(36)}`;

const waitFor = async (
  deadlineAt: number,
  predicate: () => boolean,
  description: string
): Promise<void> => {
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() > deadlineAt) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

const readSessionObservations = (
  service: ReturnType<typeof createCodexWorkbenchRuntimeService>,
  sessionId: string,
  toolNames: readonly string[],
  terminalChunks: readonly string[]
) => {
  const snapshot = service.getSnapshot();
  const session = snapshot.sessions.find((entry) => entry.sessionId === sessionId);
  const assistantTranscriptText = snapshot.messageBlocks
    .filter((block) => block.sessionId === sessionId && block.role !== "user")
    .map((block) => block.text)
    .join("\n");
  const terminalStreams = snapshot.terminalStreams.filter(
    (stream) => stream.sessionId === sessionId
  );
  const terminalText = terminalStreams.map((stream) => stream.outputText).join("\n");
  const toolObserved =
    toolNames.length > 0 ||
    snapshot.toolCalls.some((toolCall) => toolCall.sessionId === sessionId);
  const terminalObserved =
    terminalStreams.length > 0 ||
    terminalText.trim().length > 0 ||
    terminalChunks.join("").trim().length > 0;
  const assistantTranscriptObserved = assistantTranscriptText.trim().length > 0;
  const realActivityObserved =
    assistantTranscriptObserved || toolObserved || terminalObserved;

  return {
    snapshot,
    session,
    assistantTranscriptText,
    terminalText,
    toolObserved,
    terminalObserved,
    assistantTranscriptObserved,
    realActivityObserved
  };
};

const describeObservations = (
  observations: ReturnType<typeof readSessionObservations>,
  toolNames: readonly string[],
  terminalChunks: readonly string[]
): string =>
  JSON.stringify(
    {
      sessionStatus: observations.session?.status,
      lastTurnId: observations.session?.lastTurnId,
      assistantTranscriptObserved: observations.assistantTranscriptObserved,
      toolObserved: observations.toolObserved,
      terminalObserved: observations.terminalObserved,
      toolNames,
      terminalStreamCount: observations.snapshot.terminalStreams.filter(
        (stream) => stream.sessionId === observations.session?.sessionId
      ).length,
      terminalChunkCount: terminalChunks.length,
      sessionTurnStatuses: observations.snapshot.turns
        .filter((turn) => turn.sessionId === observations.session?.sessionId)
        .map((turn) => ({
          turnId: turn.turnId,
          status: turn.status,
          finishReason: turn.finishReason
        })),
      transcriptPreview: observations.assistantTranscriptText.slice(0, 400),
      terminalPreview: observations.terminalText.slice(0, 400)
    },
    null,
    2
  );

const run = async (): Promise<void> => {
  const service = createCodexWorkbenchRuntimeService();
  const deadlineAt = Date.now() + timeoutMs;

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
    deadlineAt,
    () => {
      const observations = readSessionObservations(
        service,
        sessionId,
        toolNames,
        terminalChunks
      );
      return observations.realActivityObserved;
    },
    "real Codex runtime activity beyond the optimistic user turn"
  );

  await waitFor(
    deadlineAt,
    () => {
      const observations = readSessionObservations(
        service,
        sessionId,
        toolNames,
        terminalChunks
      );
      return (
        observations.session?.status === "idle" ||
        observations.session?.status === "error"
      );
    },
    "the real Codex runtime turn to settle"
  );

  const observations = readSessionObservations(
    service,
    sessionId,
    toolNames,
    terminalChunks
  );
  const transcriptText = observations.assistantTranscriptText;
  const terminalText = observations.terminalText;

  if (!transcriptText.trim()) {
    throw new Error("Real smoke test did not capture any assistant transcript text.");
  }
  if (transcriptText.includes("Codex response")) {
    throw new Error("Real smoke test still saw demo placeholder text.");
  }
  if (!observations.toolObserved) {
    throw new Error("Real smoke test did not observe any tool execution.");
  }
  if (!observations.terminalObserved) {
    throw new Error(
      `Real smoke test did not observe any terminal output.\n${describeObservations(
        observations,
        toolNames,
        terminalChunks
      )}`
    );
  }
  if (!observations.assistantTranscriptObserved) {
    throw new Error(
      `Real smoke test did not capture any assistant transcript text.\n${describeObservations(
        observations,
        toolNames,
        terminalChunks
      )}`
    );
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
