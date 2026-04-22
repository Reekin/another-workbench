import { parseDomainSnapshot, type DomainSnapshot } from "@another-workbench/shared";

export const createDemoSnapshot = (): DomainSnapshot =>
  parseDomainSnapshot({
    conversations: [
      {
        conversationId: "conv-demo",
        workspaceId: "workspace-demo",
        participantEngineIds: ["agent-codex"],
        activeSessionId: "session-demo",
        sessionIds: ["session-demo"],
        createdAt: "2026-04-17T00:00:00.000Z",
        updatedAt: "2026-04-17T00:00:00.000Z"
      }
    ],
    sessions: [
      {
        sessionId: "session-demo",
        conversationId: "conv-demo",
        engineId: "agent-codex",
        status: "running",
        title: "Demo Session",
        createdAt: "2026-04-17T00:00:00.000Z",
        updatedAt: "2026-04-17T00:00:00.000Z",
        lastTurnId: "turn-demo-1"
      }
    ],
    turns: [
      {
        turnId: "turn-demo-1",
        sessionId: "session-demo",
        status: "streaming",
        startedAt: "2026-04-17T00:00:00.000Z",
        messageIds: ["msg-demo-1"],
        toolCallIds: ["tool-demo-1"],
        terminalIds: ["terminal-demo-1"],
        approvalRequestIds: ["approval-demo-1"]
      }
    ],
    messageBlocks: [
      {
        blockId: "msg-demo-1:md",
        messageId: "msg-demo-1",
        sessionId: "session-demo",
        turnId: "turn-demo-1",
        role: "assistant",
        kind: "markdown",
        text:
          "# Another Workbench\n\nThis transcript now renders **streaming markdown**.\n\n```ts\nconsole.log('hello from demo');\n```\n\n| Item | Status |\n| --- | --- |\n| Markdown | ready |\n| Tool timeline | ready |\n| Terminal stream | ready |",
        actor: {
          participantId: "participant-demo-1",
          engineId: "agent-codex"
        },
        startedAt: "2026-04-17T00:00:00.000Z"
      }
    ],
    toolCalls: [
      {
        toolCallId: "tool-demo-1",
        sessionId: "session-demo",
        turnId: "turn-demo-1",
        toolName: "exec_command",
        status: "running",
        inputSummary: "pnpm typecheck",
        outputSummary: "Typecheck started...",
        actor: {
          participantId: "participant-demo-1",
          engineId: "agent-codex"
        },
        startedAt: "2026-04-17T00:00:00.000Z"
      }
    ],
    terminalStreams: [
      {
        terminalId: "terminal-demo-1",
        sessionId: "session-demo",
        turnId: "turn-demo-1",
        toolCallId: "tool-demo-1",
        status: "running",
        outputText: "> checking workspace...\r> checking workspace... done\n> running tests...",
        actor: {
          participantId: "participant-demo-1",
          engineId: "agent-codex"
        },
        startedAt: "2026-04-17T00:00:00.000Z"
      }
    ],
    approvalRequests: [
      {
        requestId: "approval-demo-1",
        sessionId: "session-demo",
        turnId: "turn-demo-1",
        approvalKind: "command",
        status: "pending",
        title: "Allow command execution?",
        details: "Command requests filesystem access.",
        actor: {
          participantId: "participant-demo-1",
          engineId: "agent-codex"
        },
        requestedAt: "2026-04-17T00:00:00.000Z"
      }
    ],
    participants: [
      {
        participantId: "participant-demo-1",
        conversationId: "conv-demo",
        engineId: "agent-codex",
        role: "primary",
        capabilities: ["chat", "tool", "terminal"],
        activeSessionIds: ["session-demo"]
      }
    ],
    sessionRelations: []
  });
