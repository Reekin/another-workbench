import readline from "node:readline";

let nextThreadNumber = 1;
let nextTurnNumber = 1;
let nextApprovalRequestId = 0;
const pendingApprovalByRequestId = new Map();
let lastThreadStartParams = null;

const send = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const emitHappyPath = ({ threadId, turnId, prompt, messagePhase = null }) => {
  const messageId = `msg-${turnId}`;
  const commandId = `cmd-${turnId}`;
  const renderedPrompt =
    prompt === "__THREAD_START_PARAMS__"
      ? JSON.stringify(lastThreadStartParams ?? {})
      : prompt;
  const output = "$ pwd\nD:/workspace\n";

  send({
    method: "thread/status/changed",
    params: {
      threadId,
      status: { type: "active" }
    }
  });
  send({
    method: "turn/started",
    params: {
      threadId,
      turn: { id: turnId }
    }
  });
  send({
    method: "item/started",
    params: {
      threadId,
      turnId,
      item: {
        type: "agentMessage",
        id: messageId,
        text: "",
        phase: messagePhase,
        memoryCitation: null
      }
    }
  });
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId,
      turnId,
      itemId: messageId,
      delta: `Real Codex says: ${renderedPrompt}\n`
    }
  });
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: {
        type: "agentMessage",
        id: messageId,
        text: `Real Codex says: ${renderedPrompt}\n`,
        phase: messagePhase,
        memoryCitation: null
      }
    }
  });
  send({
    method: "item/started",
    params: {
      threadId,
      turnId,
      item: {
        type: "commandExecution",
        id: commandId,
        command: "pwd",
        cwd: "D:/workspace",
        processId: "proc-1",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null
      }
    }
  });
  send({
    method: "item/commandExecution/outputDelta",
    params: {
      threadId,
      turnId,
      itemId: commandId,
      delta: "$ pwd\n"
    }
  });
  send({
    method: "item/commandExecution/outputDelta",
    params: {
      threadId,
      turnId,
      itemId: commandId,
      delta: "D:/workspace\n"
    }
  });
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: {
        type: "commandExecution",
        id: commandId,
        command: "pwd",
        cwd: "D:/workspace",
        processId: "proc-1",
        status: "completed",
        commandActions: [],
        aggregatedOutput: output,
        exitCode: 0,
        durationMs: 4
      }
    }
  });
  send({
    method: "thread/status/changed",
    params: {
      threadId,
      status: { type: "idle" }
    }
  });
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        status: "completed"
      }
    }
  });
};

const emitCollabPath = ({ threadId, turnId }) => {
  const collabId = `collab-${turnId}`;
  send({
    method: "thread/status/changed",
    params: {
      threadId,
      status: { type: "active" }
    }
  });
  send({
    method: "turn/started",
    params: {
      threadId,
      turn: { id: turnId }
    }
  });
  send({
    method: "item/started",
    params: {
      threadId,
      turnId,
      item: {
        type: "collabAgentToolCall",
        id: collabId,
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: threadId,
        receiverThreadIds: ["sub-thread-1"],
        prompt: "Review this file",
        model: "gpt-5",
        reasoningEffort: "high",
        agentsStates: {
          "sub-thread-1": {
            status: "pendingInit",
            message: null
          }
        }
      }
    }
  });
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: {
        type: "collabAgentToolCall",
        id: collabId,
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: threadId,
        receiverThreadIds: ["sub-thread-1"],
        prompt: "Review this file",
        model: "gpt-5",
        reasoningEffort: "high",
        agentsStates: {
          "sub-thread-1": {
            status: "completed",
            message: "Reviewed successfully"
          }
        }
      }
    }
  });
  send({
    method: "thread/status/changed",
    params: {
      threadId,
      status: { type: "idle" }
    }
  });
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        status: "completed"
      }
    }
  });
};

const emitFileChangePath = ({ threadId, turnId }) => {
  send({
    method: "thread/status/changed",
    params: {
      threadId,
      status: { type: "active" }
    }
  });
  send({
    method: "turn/started",
    params: {
      threadId,
      turn: { id: turnId }
    }
  });
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: {
        type: "fileChange",
        id: `file-${turnId}`,
        status: "completed",
        changes: [
          {
            path: "apps/desktop/abc.txt",
            kind: {
              type: "update",
              move_path: null
            },
            diff: "@@ -1 +1,3 @@\n-\n+第一行内容\n+第二行内容\n+第三行内容\n"
          }
        ]
      }
    }
  });
  send({
    method: "thread/status/changed",
    params: {
      threadId,
      status: { type: "idle" }
    }
  });
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        status: "completed"
      }
    }
  });
};

const emitRuntimeErrorPath = ({ threadId, turnId }) => {
  send({
    method: "thread/status/changed",
    params: {
      threadId,
      status: { type: "active" }
    }
  });
  send({
    method: "turn/started",
    params: {
      threadId,
      turn: { id: turnId }
    }
  });
  send({
    method: "error",
    params: {
      threadId,
      turnId,
      error: {
        message: "Boom from app-server",
        codexErrorInfo: "other",
        additionalDetails: "extra details"
      },
      willRetry: false
    }
  });
  send({
    method: "thread/status/changed",
    params: {
      threadId,
      status: { type: "idle" }
    }
  });
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        status: "failed",
        error: {
          message: "Boom from app-server",
          codexErrorInfo: "other",
          additionalDetails: "extra details"
        }
      }
    }
  });
};

const emitApprovalResolution = ({ threadId, turnId, requestId, action }) => {
  const commandId = `cmd-${turnId}`;

  send({
    method: "serverRequest/resolved",
    params: {
      threadId,
      requestId
    }
  });

  if (action !== "approve") {
    send({
      method: "thread/status/changed",
      params: {
        threadId,
        status: { type: "idle" }
      }
    });
    return;
  }

  send({
    method: "thread/status/changed",
    params: {
      threadId,
      status: { type: "active" }
    }
  });
  send({
    method: "item/started",
    params: {
      threadId,
      turnId,
      item: {
        type: "commandExecution",
        id: commandId,
        command: "rm -rf tmp",
        cwd: "D:/workspace",
        processId: "proc-2",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null
      }
    }
  });
  send({
    method: "item/commandExecution/outputDelta",
    params: {
      threadId,
      turnId,
      itemId: commandId,
      delta: "approved\n"
    }
  });
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: {
        type: "commandExecution",
        id: commandId,
        command: "rm -rf tmp",
        cwd: "D:/workspace",
        processId: "proc-2",
        status: "completed",
        commandActions: [],
        aggregatedOutput: "approved\n",
        exitCode: 0,
        durationMs: 3
      }
    }
  });
  send({
    method: "thread/status/changed",
    params: {
      threadId,
      status: { type: "idle" }
    }
  });
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        status: "completed"
      }
    }
  });
};

const handleRequest = (payload) => {
  if (payload.method === "initialized") {
    return;
  }

  if (typeof payload.method === "string") {
    switch (payload.method) {
      case "initialize":
        send({
          id: payload.id,
          result: {
            accepted: true
          }
        });
        return;
      case "thread/start": {
        lastThreadStartParams = payload.params ?? null;
        const threadId = `thread-${nextThreadNumber++}`;
        send({
          id: payload.id,
          result: {
            thread: {
              id: threadId
            }
          }
        });
        return;
      }
      case "turn/start": {
        const threadId = String(payload.params.threadId);
        const prompt = String(payload.params.input?.[0]?.text ?? "");
        const turnId = `turn-${nextTurnNumber++}`;

        send({
          id: payload.id,
          result: {
            turn: {
              id: turnId
            }
          }
        });

        queueMicrotask(() => {
          if (prompt.includes("approval")) {
            send({
              method: "thread/status/changed",
              params: {
                threadId,
                status: { type: "active" }
              }
            });
            send({
              method: "turn/started",
              params: {
                threadId,
                turn: { id: turnId }
              }
            });
            const requestId = nextApprovalRequestId++;
            pendingApprovalByRequestId.set(requestId, { threadId, turnId });
            send({
              id: requestId,
              method: "item/commandExecution/requestApproval",
              params: {
                threadId,
                turnId,
                itemId: `cmd-${turnId}`,
                reason: "Need permission to continue",
                command: "rm -rf tmp",
                availableDecisions: ["acceptForSession", "decline", "cancel"]
              }
            });
            return;
          }

          if (prompt.includes("subagent")) {
            emitCollabPath({ threadId, turnId });
            return;
          }

          if (prompt.includes("file-change")) {
            emitFileChangePath({ threadId, turnId });
            return;
          }

          if (prompt.includes("runtime-error")) {
            emitRuntimeErrorPath({ threadId, turnId });
            return;
          }

          emitHappyPath({
            threadId,
            turnId,
            prompt,
            messagePhase: prompt.includes("final-answer") ? "final_answer" : null
          });
        });
        return;
      }
      case "turn/interrupt":
        send({
          id: payload.id,
          result: {
            interrupted: true
          }
        });
        return;
      default:
        send({
          id: payload.id,
          result: {
            accepted: true
          }
        });
        return;
    }
  }

  if (payload.id !== undefined && payload.result) {
    const approval = pendingApprovalByRequestId.get(payload.id);
    if (!approval) {
      return;
    }
    pendingApprovalByRequestId.delete(payload.id);
    const action =
      payload.result?.decision === "acceptForSession" ||
      payload.result?.scope === "session"
        ? "approve"
        : payload.result?.decision === "decline"
          ? "deny"
          : "defer";
    queueMicrotask(() => {
      emitApprovalResolution({
        ...approval,
        requestId: payload.id,
        action
      });
    });
  }
};

const reader = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

reader.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  handleRequest(JSON.parse(line));
});
