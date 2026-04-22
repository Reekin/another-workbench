import type { AdapterRuntimePort } from "@another-workbench/adapters";
import type {
  AcpRuntimeEvent,
  AcpRuntimeRequest,
  AcpRuntimeResponse,
  CodexRuntimeEvent,
  CodexRuntimeRequest,
  CodexRuntimeResponse
} from "@another-workbench/adapters";
import type { EventType } from "@another-workbench/shared";

type DemoStoryContext = {
  sessionId: string;
  turnId: string;
  messageId: string;
  toolCallId: string;
  terminalId: string;
  requestId: string;
  content: string;
};

type ApprovalContinuation<TEvent> = {
  sessionId: string;
  requestId: string;
  continueWith: (action: "approve" | "deny" | "defer") => TEvent[];
};

type DemoRuntimePortOptions<TRequest, TResponse, TEvent> = {
  engineId: string;
  kind: "codex" | "acp";
  responseFlavor: string;
  okResponse: (id: string) => TResponse;
  createEvent: (name: EventType, payload: Record<string, unknown>, sequence: string) => TEvent;
  parseRequest: (request: TRequest) => {
    id: string;
    method: string;
    params: Record<string, unknown>;
  };
};

const chunkText = (value: string): string[] => {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += 48) {
    chunks.push(value.slice(index, index + 48));
  }
  return chunks.length > 0 ? chunks : [value];
};

class DemoRuntimePort<TRequest, TResponse, TEvent>
  implements AdapterRuntimePort<TRequest, TResponse, TEvent>
{
  private readonly engineId: string;
  private readonly kind: "codex" | "acp";
  private readonly responseFlavor: string;
  private readonly okResponseFactory: (id: string) => TResponse;
  private readonly createEventFactory: (
    name: EventType,
    payload: Record<string, unknown>,
    sequence: string
  ) => TEvent;
  private readonly parseRequestFactory: (
    request: TRequest
  ) => {
    id: string;
    method: string;
    params: Record<string, unknown>;
  };
  private readonly listeners = new Set<(event: TEvent) => void>();
  private readonly pendingApprovals = new Map<string, ApprovalContinuation<TEvent>>();
  private sequence = 0;
  private turnCounter = 0;

  public constructor(options: DemoRuntimePortOptions<TRequest, TResponse, TEvent>) {
    this.engineId = options.engineId;
    this.kind = options.kind;
    this.responseFlavor = options.responseFlavor;
    this.okResponseFactory = options.okResponse;
    this.createEventFactory = options.createEvent;
    this.parseRequestFactory = options.parseRequest;
  }

  public async start(): Promise<void> {}

  public async stop(): Promise<void> {
    this.listeners.clear();
    this.pendingApprovals.clear();
  }

  public async request(payload: TRequest): Promise<TResponse> {
    const request = this.parseRequestFactory(payload);

    if (
      request.method === "turn/start" ||
      request.method === "turn.send"
    ) {
      this.dispatchAsync(this.buildTurnStory(request.params));
      return this.okResponseFactory(request.id);
    }

    if (
      request.method === "approval/respond" ||
      request.method === "approval.respond"
    ) {
      const sessionId = String(request.params.sessionId ?? "");
      const requestId = String(request.params.requestId ?? "");
      const action = String(request.params.action ?? "defer") as
        | "approve"
        | "deny"
        | "defer";
      const continuation = this.pendingApprovals.get(requestId);
      if (continuation && continuation.sessionId === sessionId) {
        this.pendingApprovals.delete(requestId);
        this.dispatchAsync(continuation.continueWith(action));
      }
      return this.okResponseFactory(request.id);
    }

    if (request.method === "turn/interrupt" || request.method === "turn.interrupt") {
      const sessionId = String(request.params.sessionId ?? "");
      const turnId = String(request.params.turnId ?? `turn-${++this.turnCounter}`);
      this.dispatchAsync([
        this.createEventFactory("turn.completed", {
          sessionId,
          turnId,
          finishReason: "interrupted"
        }, this.nextSequence())
      ]);
      return this.okResponseFactory(request.id);
    }

    return this.okResponseFactory(request.id);
  }

  public subscribe(listener: (event: TEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private dispatchAsync(events: TEvent[]): void {
    void Promise.resolve().then(() => {
      for (const event of events) {
        for (const listener of this.listeners) {
          listener(event);
        }
      }
    });
  }

  private buildTurnStory(params: Record<string, unknown>): TEvent[] {
    const sessionId = String(params.sessionId ?? "");
    const content = String(params.content ?? "");
    const turnId = String(params.turnId ?? `turn-${++this.turnCounter}`);
    const messageId = String(params.messageId ?? `message-${this.turnCounter}`);
    const toolCallId = `tool-${this.turnCounter}`;
    const terminalId = `terminal-${this.turnCounter}`;
    const requestId = `approval-${this.turnCounter}`;
    const context: DemoStoryContext = {
      sessionId,
      turnId,
      messageId,
      toolCallId,
      terminalId,
      requestId,
      content
    };

    const header = `# ${this.responseFlavor} response\n\n`;
    const summary = `Prompt received: ${content.trim() || "(empty)"}\n\n`;
    const narrative =
      this.kind === "codex"
        ? "Running workspace analysis, tool execution, and terminal streaming."
        : "Running ACP session flow with normalized tool and terminal events.";
    const body = `${header}${summary}${narrative}\n\n`;
    const needsApproval = /approve|sudo|danger|write/i.test(content);
    const chunks = chunkText(body);

    const events: TEvent[] = [
      this.createEventFactory("turn.started", {
        sessionId,
        turnId
      }, this.nextSequence()),
      this.createEventFactory("message.started", {
        sessionId,
        turnId,
        messageId,
        role: "assistant",
        engineId: this.engineId
      }, this.nextSequence())
    ];

    for (const chunk of chunks) {
      events.push(
        this.createEventFactory("message.delta", {
          sessionId,
          turnId,
          messageId,
          delta: chunk,
          engineId: this.engineId
        }, this.nextSequence())
      );
    }

    events.push(
      this.createEventFactory("tool.started", {
        sessionId,
        turnId,
        toolCallId,
        toolName: this.kind === "codex" ? "exec_command" : "acp.tool.invoke",
        inputSummary: content,
        engineId: this.engineId
      }, this.nextSequence()),
      this.createEventFactory("terminal.started", {
        sessionId,
        turnId,
        terminalId,
        toolCallId,
        engineId: this.engineId
      }, this.nextSequence()),
      this.createEventFactory("terminal.output", {
        sessionId,
        turnId,
        terminalId,
        chunk: `> ${this.responseFlavor.toLowerCase()} preparing workspace...\n`,
        engineId: this.engineId
      }, this.nextSequence()),
      this.createEventFactory("terminal.output", {
        sessionId,
        turnId,
        terminalId,
        chunk: `> ${this.responseFlavor.toLowerCase()} running tool step\n`,
        engineId: this.engineId
      }, this.nextSequence())
    );

    if (needsApproval) {
      events.push(
        this.createEventFactory("approval.requested", {
          sessionId,
          turnId,
          requestId,
          approvalKind: "command",
          title: `${this.responseFlavor} requests approval`,
          details: "Demo runtime paused for explicit approval flow.",
          engineId: this.engineId
        }, this.nextSequence())
      );
      this.pendingApprovals.set(requestId, {
        sessionId,
        requestId,
        continueWith: (action) => this.buildApprovalResolution(context, action)
      });
      return events;
    }

    return [...events, ...this.buildCompletionEvents(context, "completed")];
  }

  private buildApprovalResolution(
    context: DemoStoryContext,
    action: "approve" | "deny" | "defer"
  ): TEvent[] {
    const base: TEvent[] = [
      this.createEventFactory("approval.resolved", {
        sessionId: context.sessionId,
        turnId: context.turnId,
        requestId: context.requestId,
        action,
        engineId: this.engineId
      }, this.nextSequence())
    ];

    if (action === "deny") {
      return [
        ...base,
        this.createEventFactory("tool.completed", {
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: context.toolCallId,
          status: "failed",
          outputSummary: "Approval denied by the user.",
          engineId: this.engineId
        }, this.nextSequence()),
        this.createEventFactory("message.delta", {
          sessionId: context.sessionId,
          turnId: context.turnId,
          messageId: context.messageId,
          delta: "\nApproval was denied, so the action was cancelled.",
          engineId: this.engineId
        }, this.nextSequence()),
        this.createEventFactory("message.completed", {
          sessionId: context.sessionId,
          turnId: context.turnId,
          messageId: context.messageId,
          engineId: this.engineId
        }, this.nextSequence()),
        this.createEventFactory("turn.completed", {
          sessionId: context.sessionId,
          turnId: context.turnId,
          finishReason: "failed"
        }, this.nextSequence())
      ];
    }

    return [
      ...base,
      ...this.buildCompletionEvents(
        context,
        action === "defer" ? "cancelled" : "completed",
        action === "defer"
          ? "\nApproval deferred. The demo marks the tool as cancelled."
          : "\nApproval granted. The demo continued successfully."
      )
    ];
  }

  private buildCompletionEvents(
    context: DemoStoryContext,
    toolStatus: "completed" | "cancelled",
    trailingMessage = "\nTool and terminal execution finished."
  ): TEvent[] {
    return [
      this.createEventFactory("terminal.output", {
        sessionId: context.sessionId,
        turnId: context.turnId,
        terminalId: context.terminalId,
        chunk: "> command finished\n",
        engineId: this.engineId
      }, this.nextSequence()),
      this.createEventFactory("terminal.completed", {
        sessionId: context.sessionId,
        turnId: context.turnId,
        terminalId: context.terminalId,
        exitCode: toolStatus === "completed" ? 0 : 130,
        engineId: this.engineId
      }, this.nextSequence()),
      this.createEventFactory("tool.completed", {
        sessionId: context.sessionId,
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        status: toolStatus,
        outputSummary:
          toolStatus === "completed"
            ? "Completed with streamed terminal output."
            : "Cancelled after deferred approval.",
        engineId: this.engineId
      }, this.nextSequence()),
      this.createEventFactory("message.delta", {
        sessionId: context.sessionId,
        turnId: context.turnId,
        messageId: context.messageId,
        delta: trailingMessage,
        engineId: this.engineId
      }, this.nextSequence()),
      this.createEventFactory("message.completed", {
        sessionId: context.sessionId,
        turnId: context.turnId,
        messageId: context.messageId,
        engineId: this.engineId
      }, this.nextSequence()),
      this.createEventFactory("turn.completed", {
        sessionId: context.sessionId,
        turnId: context.turnId,
        finishReason: toolStatus === "completed" ? "completed" : "interrupted"
      }, this.nextSequence())
    ];
  }

  private nextSequence(): string {
    this.sequence += 1;
    return String(this.sequence);
  }
}

export const createCodexDemoRuntimePort = (
  engineId = "codex"
): AdapterRuntimePort<
  CodexRuntimeRequest,
  CodexRuntimeResponse,
  CodexRuntimeEvent
> =>
  new DemoRuntimePort({
    engineId,
    kind: "codex",
    responseFlavor: "Codex",
    parseRequest: (request) => request,
    okResponse: (id) => ({
      id,
      ok: true,
      result: {
        accepted: true
      }
    }),
    createEvent: (method, params, cursor): CodexRuntimeEvent => ({
      method,
      params,
      eventId: `codex-${cursor}`,
      cursor
    })
  });

export const createAcpDemoRuntimePort = (
  engineId = "acp"
): AdapterRuntimePort<
  AcpRuntimeRequest,
  AcpRuntimeResponse,
  AcpRuntimeEvent
> =>
  new DemoRuntimePort({
    engineId,
    kind: "acp",
    responseFlavor: "ACP",
    parseRequest: (request) => ({
      id: request.id,
      method: request.method,
      params: request.params
    }),
    okResponse: (id) => ({
      id,
      ok: true,
      result: {
        accepted: true
      }
    }),
    createEvent: (event, payload, cursor): AcpRuntimeEvent => ({
      event,
      payload,
      eventId: `acp-${cursor}`,
      cursor
    })
  });
