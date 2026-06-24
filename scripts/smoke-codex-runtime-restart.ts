import { fileURLToPath } from "node:url";
import { createWorkbenchRuntimeService } from "../apps/desktop-server/src/prod-service.js";

const timeoutMs = Number(process.env.AWB_SMOKE_TIMEOUT_MS ?? "30000");
const conversationId = `smoke-restart-${Date.now().toString(36)}`;
const fixturePath = fileURLToPath(
  new URL("../apps/desktop-server/tests/fixtures/fake-codex-app-server.mjs", import.meta.url)
);

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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const errorCodeOf = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : undefined;

const run = async (): Promise<void> => {
  const service = createWorkbenchRuntimeService({
    codexCommandPath: process.execPath,
    codexCommandArgs: [fixturePath],
    titleGenerator: {
      async generateTitle() {
        return "Runtime Restart Smoke";
      }
    }
  });
  const deadlineAt = Date.now() + timeoutMs;
  const previousExitMethod = process.env.FAKE_CODEX_EXIT_ON_METHOD;
  const previousExitCode = process.env.FAKE_CODEX_EXIT_CODE;

  try {
    await service.executeCommand({
      commandId: "restart-smoke-create-session",
      command: {
        type: "createSession",
        engineId: "codex",
        conversationId
      }
    });

    const sessionId = service.listSessions({
      conversationId,
      includeArchived: true
    })[0]?.sessionId;
    if (!sessionId) {
      throw new Error("Failed to create restart smoke session.");
    }

    process.env.FAKE_CODEX_EXIT_ON_METHOD = "turn/start";
    process.env.FAKE_CODEX_EXIT_CODE = "31";
    let firstError: unknown;
    try {
      await service.executeCommand({
        commandId: "restart-smoke-crash-send",
        command: {
          type: "sendUserMessage",
          sessionId,
          messageId: "restart-smoke-message-crash",
          content: "This turn should crash the fake Codex runtime.",
          attachments: []
        }
      });
    } catch (error) {
      firstError = error;
    }

    const firstErrorCode = errorCodeOf(firstError);
    if (firstErrorCode !== "runtime_process_exited") {
      throw new Error(
        `Expected first command to fail with runtime_process_exited, got ${firstErrorCode ?? "no error"}.`
      );
    }

    delete process.env.FAKE_CODEX_EXIT_ON_METHOD;
    delete process.env.FAKE_CODEX_EXIT_CODE;
    await service.executeCommand({
      commandId: "restart-smoke-recovered-send",
      command: {
        type: "sendUserMessage",
        sessionId,
        messageId: "restart-smoke-message-recovered",
        content: "Reply with exactly: recovered",
        attachments: []
      }
    });

    await waitFor(
      deadlineAt,
      () => {
        const snapshot = service.getSnapshot();
        const transcriptText = snapshot.messageBlocks
          .filter((block) => block.sessionId === sessionId && block.role !== "user")
          .map((block) => block.text)
          .join("\n");
        return transcriptText.toLowerCase().includes("recovered");
      },
      "the recovered Codex runtime response"
    );

    const snapshot = service.getSnapshot();
    const transcriptText = snapshot.messageBlocks
      .filter((block) => block.sessionId === sessionId && block.role !== "user")
      .map((block) => block.text)
      .join("\n");
    console.log(
      JSON.stringify(
        {
          ok: true,
          conversationId,
          sessionId,
          firstErrorCode,
          transcriptPreview: transcriptText.slice(0, 400)
        },
        null,
        2
      )
    );
  } finally {
    if (previousExitMethod === undefined) {
      delete process.env.FAKE_CODEX_EXIT_ON_METHOD;
    } else {
      process.env.FAKE_CODEX_EXIT_ON_METHOD = previousExitMethod;
    }
    if (previousExitCode === undefined) {
      delete process.env.FAKE_CODEX_EXIT_CODE;
    } else {
      process.env.FAKE_CODEX_EXIT_CODE = previousExitCode;
    }
    await service.dispose();
  }
};

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
