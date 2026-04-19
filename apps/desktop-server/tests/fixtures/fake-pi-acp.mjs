import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream
} from "@agentclientprotocol/sdk";

const sessions = new Map();
const cancelledSessionIds = new Set();

const promptToText = (prompt) =>
  prompt
    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
    .join("\n")
    .trim();

const createAgent = (connection) => ({
  async initialize() {
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
    cancelledSessionIds.add(sessionId);
  }
});

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = new AgentSideConnection((conn) => createAgent(conn), stream);

await connection.closed;
