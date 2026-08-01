import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createCodexAppServerRuntimePort } from "../src/codex-app-server-runtime-port.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url)
);

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 3_000
): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for predicate.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("Codex thread status aliases", () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  });

  it("settles every session alias when the provider thread becomes idle", async () => {
    const port = createCodexAppServerRuntimePort({
      commandPath: process.execPath,
      commandArgs: [fixturePath],
      resolveConversationIdBySessionId: (sessionId) => `conversation-${sessionId}`
    });
    disposers.push(() => port.stop());

    const idleSessionIds = new Set<string>();
    port.subscribe((event) => {
      if (
        event.method === "session.updated" &&
        event.params.status === "idle"
      ) {
        idleSessionIds.add(String(event.params.sessionId));
      }
    });

    await port.start();
    port.attachThreadToSession("session-running", "thread-shared");
    port.attachThreadToSession("codex-thread:thread-shared", "thread-shared");

    await port.request({
      id: "turn-shared-status",
      method: "turn/start",
      params: {
        sessionId: "session-running",
        content: "settle every alias"
      }
    });

    await waitFor(
      () =>
        idleSessionIds.has("session-running") &&
        idleSessionIds.has("codex-thread:thread-shared")
    );

    expect(Array.from(idleSessionIds)).toEqual(
      expect.arrayContaining([
        "session-running",
        "codex-thread:thread-shared"
      ])
    );
  });
});
