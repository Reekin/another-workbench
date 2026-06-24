import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AcpRuntimeEvent,
  AcpRuntimeRequest,
  AcpRuntimeResponse,
  AdapterRuntimePort
} from "@another-workbench/adapters";
import { createPiAcpRuntimePort } from "../src/pi-acp-runtime-port.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/fake-pi-acp.mjs", import.meta.url)
);

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 3_000
): Promise<void> => {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for predicate.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const readRequestLog = (path: string): Array<Record<string, unknown>> => {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

const createPort = (): AdapterRuntimePort<
  AcpRuntimeRequest,
  AcpRuntimeResponse,
  AcpRuntimeEvent
> =>
  createPiAcpRuntimePort({
    commandPath: process.execPath,
    commandArgs: [fixturePath],
    resolveConversationIdBySessionId: () => "conversation-1"
  });

const sendTurn = (
  port: AdapterRuntimePort<AcpRuntimeRequest, AcpRuntimeResponse, AcpRuntimeEvent>,
  input: {
    requestId: string;
    sessionId: string;
    content: string;
  }
): Promise<AcpRuntimeResponse> =>
  port.request({
    id: input.requestId,
    method: "turn.send",
    params: {
      sessionId: input.sessionId,
      content: input.content,
      attachments: []
    }
  });

describe("Pi ACP runtime port", () => {
  const disposers: Array<() => Promise<void>> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      if (dispose) {
        await dispose();
      }
    }
    while (tempDirs.length > 0) {
      const path = tempDirs.pop();
      if (path) {
        rmSync(path, {
          recursive: true,
          force: true
        });
      }
    }
  });

  it("single-flights concurrent starts into one ACP child process", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "awb-pi-acp-start-"));
    tempDirs.push(tempDir);
    const requestLogPath = join(tempDir, "requests.jsonl");
    const port = createPort();
    disposers.push(() => port.stop());

    await Promise.all([
      port.start({
        env: {
          FAKE_PI_ACP_REQUEST_LOG: requestLogPath
        }
      }),
      port.start({
        env: {
          FAKE_PI_ACP_REQUEST_LOG: requestLogPath
        }
      })
    ]);

    expect(port.getState()).toBe("ready");
    const requests = readRequestLog(requestLogPath);
    const initializeRequests = requests.filter(
      (request) => request.method === "initialize"
    );
    expect(initializeRequests).toHaveLength(1);
    expect(new Set(initializeRequests.map((request) => request.pid)).size).toBe(1);
  });

  it("cleans up a failed initialize and allows the next start to retry", async () => {
    const port = createPort();
    disposers.push(() => port.stop());

    await expect(
      port.start({
        env: {
          FAKE_PI_ACP_EXIT_ON_METHOD: "initialize",
          FAKE_PI_ACP_EXIT_CODE: "31"
        }
      })
    ).rejects.toThrow();
    expect(port.getState()).toBe("failed");

    await port.start();
    expect(port.getState()).toBe("ready");

    const response = await sendTurn(port, {
      requestId: "send-after-retry",
      sessionId: "session-retry",
      content: "hello after retry"
    });
    expect(response.ok).toBe(true);
  });

  it("moves to failed after prompt process exit and restarts on the next start", async () => {
    const port = createPort();
    const events: AcpRuntimeEvent[] = [];
    port.subscribe((event) => events.push(event));
    disposers.push(() => port.stop());

    await port.start({
      env: {
        FAKE_PI_ACP_EXIT_ON_METHOD: "prompt",
        FAKE_PI_ACP_EXIT_CODE: "32"
      }
    });

    const failedResponse = await sendTurn(port, {
      requestId: "send-crash",
      sessionId: "session-crash",
      content: "crash during prompt"
    });

    expect(failedResponse.ok).toBe(false);
    await waitFor(() => port.getState() === "failed");
    expect(events.some((event) =>
      event.event === "runtime.error" &&
      (event.payload.code === "PI_ACP_EXIT" ||
        event.payload.code === "PI_ACP_CONNECTION_CLOSED")
    )).toBe(true);

    await port.start();
    expect(port.getState()).toBe("ready");
    const recoveredResponse = await sendTurn(port, {
      requestId: "send-recovered",
      sessionId: "session-crash",
      content: "hello recovered"
    });
    expect(recoveredResponse.ok).toBe(true);
  });

  it("resolves pending approval requests when a turn is interrupted", async () => {
    const port = createPort();
    const events: AcpRuntimeEvent[] = [];
    port.subscribe((event) => events.push(event));
    disposers.push(() => port.stop());

    await port.start({
      env: {
        FAKE_PI_ACP_REQUEST_PERMISSION: "1"
      }
    });

    const promptPromise = sendTurn(port, {
      requestId: "send-approval",
      sessionId: "session-approval",
      content: "needs permission"
    });

    await waitFor(() =>
      events.some((event) => event.event === "approval.requested")
    );

    const cancelResponse = await port.request({
      id: "cancel-approval",
      method: "turn.interrupt",
      params: {
        sessionId: "session-approval"
      }
    });
    expect(cancelResponse.ok).toBe(true);

    const promptResponse = await promptPromise;
    expect(promptResponse.ok).toBe(true);
    expect(promptResponse.result).toMatchObject({
      stopReason: "cancelled"
    });
    expect(events.some((event) =>
      event.event === "approval.resolved" &&
      event.payload.action === "defer"
    )).toBe(true);
    expect(events.some((event) =>
      event.event === "turn.completed" &&
      event.payload.finishReason === "interrupted"
    )).toBe(true);
  });
});
