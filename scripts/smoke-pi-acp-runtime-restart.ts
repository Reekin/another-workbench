import { fileURLToPath } from "node:url";
import { createWorkbenchRuntimeService } from "../apps/desktop-server/src/prod-service.js";

const timeoutMs = Number(process.env.AWB_SMOKE_TIMEOUT_MS ?? "30000");
const conversationId = `smoke-pi-restart-${Date.now().toString(36)}`;
const fixturePath = fileURLToPath(
  new URL("../apps/desktop-server/tests/fixtures/fake-pi-acp.mjs", import.meta.url)
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

const run = async (): Promise<void> => {
  const service = createWorkbenchRuntimeService({
    piAcpCommandPath: process.execPath,
    piAcpCommandArgs: [fixturePath],
    titleGenerator: {
      async generateTitle() {
        return "Pi Runtime Restart Smoke";
      }
    }
  });
  const deadlineAt = Date.now() + timeoutMs;
  const previousExitMethod = process.env.FAKE_PI_ACP_EXIT_ON_METHOD;
  const previousExitCode = process.env.FAKE_PI_ACP_EXIT_CODE;

  try {
    await service.executeCommand({
      commandId: "pi-restart-smoke-create-session",
      command: {
        type: "createSession",
        engineId: "pi-acp",
        conversationId
      }
    });

    const sessionId = service.listSessions({
      conversationId,
      includeArchived: true
    })[0]?.sessionId;
    if (!sessionId) {
      throw new Error("Failed to create pi-acp restart smoke session.");
    }

    process.env.FAKE_PI_ACP_EXIT_ON_METHOD = "prompt";
    process.env.FAKE_PI_ACP_EXIT_CODE = "41";
    const firstReceipt = await service.executeCommand({
      commandId: "pi-restart-smoke-crash-send",
      command: {
        type: "sendUserMessage",
        sessionId,
        messageId: "pi-restart-smoke-message-crash",
        content: "This turn should crash the fake Pi ACP runtime.",
        attachments: []
      }
    });

    if (firstReceipt.accepted !== false) {
      throw new Error(
        `Expected first pi-acp command to be rejected after process exit, got accepted=${String(firstReceipt.accepted)}.`
      );
    }

    delete process.env.FAKE_PI_ACP_EXIT_ON_METHOD;
    delete process.env.FAKE_PI_ACP_EXIT_CODE;
    const recoveredReceipt = await service.executeCommand({
      commandId: "pi-restart-smoke-recovered-send",
      command: {
        type: "sendUserMessage",
        sessionId,
        messageId: "pi-restart-smoke-message-recovered",
        content: "recovered after pi restart",
        attachments: []
      }
    });

    if (recoveredReceipt.accepted !== true) {
      throw new Error("Expected recovered pi-acp command to be accepted.");
    }

    await waitFor(
      deadlineAt,
      () => {
        const snapshot = service.getSnapshot();
        const transcriptText = snapshot.messageBlocks
          .filter((block) => block.sessionId === sessionId && block.role !== "user")
          .map((block) => block.text)
          .join("\n");
        return transcriptText.includes("Pi ACP says: recovered after pi restart");
      },
      "the recovered Pi ACP runtime response"
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
          firstAccepted: firstReceipt.accepted,
          recoveredAccepted: recoveredReceipt.accepted,
          transcriptPreview: transcriptText.slice(0, 400)
        },
        null,
        2
      )
    );
  } finally {
    if (previousExitMethod === undefined) {
      delete process.env.FAKE_PI_ACP_EXIT_ON_METHOD;
    } else {
      process.env.FAKE_PI_ACP_EXIT_ON_METHOD = previousExitMethod;
    }
    if (previousExitCode === undefined) {
      delete process.env.FAKE_PI_ACP_EXIT_CODE;
    } else {
      process.env.FAKE_PI_ACP_EXIT_CODE = previousExitCode;
    }
    await service.dispose();
  }
};

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
