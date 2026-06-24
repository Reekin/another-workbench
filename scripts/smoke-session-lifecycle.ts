import { createCodexWorkbenchRuntimeService } from "../apps/desktop-server/src/prod-service.js";

const expect = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const main = async () => {
  const service = createCodexWorkbenchRuntimeService();
  const conversationId = `smoke-lifecycle-${Date.now().toString(36)}`;
  let sessionId: string | undefined;

  try {
    await service.executeCommand({
      commandId: "smoke-create-session",
      command: {
        type: "createSession",
        conversationId,
        engineId: "codex",
        workspaceId: process.cwd(),
        metadata: {
          smoke: "session-lifecycle"
        }
      }
    });
    const session = service.listSessions({ conversationId })[0];
    if (!session) {
      throw new Error("Created session was not listed.");
    }
    sessionId = session.sessionId;

    expect(
      service.getSnapshot().sessions.find(
        (candidate) => candidate.sessionId === session.sessionId
      )?.metadata?.smoke ===
        "session-lifecycle",
      "Created session was not readable from the runtime service."
    );
    expect(
      service.listSessions({ conversationId }).some(
        (candidate) => candidate.sessionId === session.sessionId
      ),
      "Created session was not listed."
    );

    await service.executeCommand({
      commandId: "smoke-archive-session",
      command: {
        type: "archiveSession",
        sessionId: session.sessionId
      }
    });
    expect(
      !service.listSessions({ conversationId }).some(
        (candidate) => candidate.sessionId === session.sessionId
      ),
      "Archived session remained in the default session list."
    );
    expect(
      service.listSessions({ conversationId, includeArchived: true }).some(
        (candidate) =>
          candidate.sessionId === session.sessionId && candidate.archivedAt
      ),
      "Archived session was not readable with includeArchived."
    );

    await service.executeCommand({
      commandId: "smoke-resume-session",
      command: {
        type: "resumeSession",
        sessionId: session.sessionId
      }
    });
    expect(
      service.listSessions({ conversationId }).some(
        (candidate) =>
          candidate.sessionId === session.sessionId && !candidate.archivedAt
      ),
      "Resumed session did not return to the active session list."
    );

    await service.executeCommand({
      commandId: "smoke-dispose-session",
      command: {
        type: "disposeSession",
        sessionId: session.sessionId
      }
    });
    expect(
      !service.getSnapshot().sessions.some(
        (candidate) => candidate.sessionId === session.sessionId
      ),
      "Disposed session was still readable from the runtime service."
    );
    expect(
      !service.getSnapshot().sessions.some(
        (candidate) => candidate.sessionId === session.sessionId
      ),
      "Disposed session remained in the canonical snapshot."
    );
  } finally {
    await service.dispose();
  }

  console.log(JSON.stringify({
    ok: true,
    conversationId,
    sessionId
  }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
