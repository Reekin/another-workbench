import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream
} from "@agentclientprotocol/sdk";

const sessions = new Map();
const cancelledSessionIds = new Set();
const requestLogPath = process.env.FAKE_PI_ACP_REQUEST_LOG;

const record = (method, params = {}) => {
  if (!requestLogPath) {
    return;
  }
  appendFileSync(
    requestLogPath,
    `${JSON.stringify({
      method,
      pid: process.pid,
      params
    })}\n`
  );
};

const maybeExit = (method) => {
  if (process.env.FAKE_PI_ACP_EXIT_ON_METHOD !== method) {
    return;
  }
  const exitCode = Number(process.env.FAKE_PI_ACP_EXIT_CODE ?? "23");
  process.exit(Number.isFinite(exitCode) ? exitCode : 23);
};

const maybeHang = async (method) => {
  if (process.env.FAKE_PI_ACP_HANG_ON_METHOD !== method) {
    return;
  }
  await new Promise(() => {});
};

const beforeMethod = async (method, params = {}) => {
  record(method, params);
  maybeExit(method);
  await maybeHang(method);
};

const promptToText = (prompt) =>
  prompt
    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
    .join("\n")
    .trim();

const shouldRequestPermission = (promptText) =>
  process.env.FAKE_PI_ACP_REQUEST_PERMISSION === "1" ||
  promptText.includes("[approval]");

const createAgent = (connection) => ({
  async initialize() {
    await beforeMethod("initialize");
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: "fake-pi-acp",
        version: "0.0.0-test"
      },
      agentCapabilities: {
        promptCapabilities: {}
      }
    };
  },

  async newSession({ cwd }) {
    await beforeMethod("newSession", {
      cwd
    });
    const sessionId = `pi-session-${randomUUID()}`;
    sessions.set(sessionId, {
      cwd,
      updatedAt: new Date().toISOString(),
      title: "Fake Pi ACP Session"
    });
    return {
      sessionId
    };
  },

  async prompt({ sessionId, prompt }) {
    await beforeMethod("prompt", {
      sessionId
    });
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const promptText = promptToText(prompt);
    const updatedAt = new Date().toISOString();
    session.updatedAt = updatedAt;
    session.title = `Pi: ${promptText.slice(0, 24) || "session"}`;

    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title: session.title,
        updatedAt
      }
    });
    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "## Skills\n- fake-skill-one\n- fake-skill-two\n"
        }
      }
    });
    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          {
            name: "skill:fake-one",
            description: "fake skill one"
          },
          {
            name: "skill:fake-two",
            description: "fake skill two"
          }
        ]
      }
    });
    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `Pi ACP says: ${promptText}`
        }
      }
    });
    const toolCallId = `tool-${randomUUID()}`;

    if (shouldRequestPermission(promptText)) {
      const permissionResponse = await connection.requestPermission({
        sessionId,
        options: [
          {
            optionId: "allow-once",
            kind: "allow_once",
            name: "Allow once"
          },
          {
            optionId: "reject-once",
            kind: "reject_once",
            name: "Reject once"
          }
        ],
        toolCall: {
          toolCallId,
          title: "Permission gated shell command",
          kind: "execute",
          status: "pending",
          rawInput: {
            command: "echo approval"
          }
        }
      });

      if (permissionResponse.outcome.outcome === "cancelled") {
        return {
          stopReason: "cancelled"
        };
      }
    }

    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Execute shell command",
        kind: "execute",
        status: "in_progress",
        rawInput: {
          command: "pwd"
        }
      }
    });

    if (cancelledSessionIds.has(sessionId)) {
      cancelledSessionIds.delete(sessionId);
      return {
        stopReason: "cancelled"
      };
    }

    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: "Execute shell command",
        kind: "execute",
        status: "completed",
        rawInput: {
          command: "pwd"
        },
        rawOutput: {
          stdout: "D:/workspace\n"
        },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "D:/workspace\n"
            }
          }
        ]
      }
    });

    return {
      stopReason: "end_turn"
    };
  },

  async cancel({ sessionId }) {
    await beforeMethod("cancel", {
      sessionId
    });
    cancelledSessionIds.add(sessionId);
  }
});

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = new AgentSideConnection((conn) => createAgent(conn), stream);

await connection.closed;
