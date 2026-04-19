import type { CommandEnvelope, RuntimeEvent } from "@another-workbench/shared";
import type { AdapterMapper } from "../mapper.js";
import type { AdapterMapperContext } from "../mapper.js";
import {
  createEventEnvelope,
  defaultCommandResultFromResponse,
  normalizeRuntimeEvent
} from "../mapper-helpers.js";
import type {
  CodexRuntimeEvent,
  CodexRuntimeRequest,
  CodexRuntimeResponse
} from "./types.js";

const codexMethodByCommandType: Record<
  CommandEnvelope["command"]["type"],
  CodexRuntimeRequest["method"]
> = {
  initialize: "initialize",
  createSession: "thread/start",
  listSessions: "thread/list",
  resumeSession: "thread/resume",
  archiveSession: "thread/archive",
  forkSession: "thread/fork",
  sendUserMessage: "turn/start",
  interruptTurn: "turn/interrupt",
  respondApproval: "approval/respond",
  disposeSession: "session/dispose"
};

const codexEventTypeByMethod: Record<string, RuntimeEvent["type"]> = {
  "conversation.updated": "conversation.updated",
  "session.created": "session.created",
  "session.updated": "session.updated",
  "session.archived": "session.archived",
  "session.disposed": "session.disposed",
  "turn.started": "turn.started",
  "turn.completed": "turn.completed",
  "message.started": "message.started",
  "message.delta": "message.delta",
  "message.completed": "message.completed",
  "tool.started": "tool.started",
  "tool.delta": "tool.delta",
  "tool.completed": "tool.completed",
  "terminal.started": "terminal.started",
  "terminal.output": "terminal.output",
  "terminal.completed": "terminal.completed",
  "approval.requested": "approval.requested",
  "approval.resolved": "approval.resolved",
  "participant.updated": "participant.updated",
  "runtime.error": "runtime.error"
};

export type CodexMapperOptions = {
  fallbackAgentId: string;
};

export class CodexMapper
  implements
    AdapterMapper<CodexRuntimeRequest, CodexRuntimeResponse, CodexRuntimeEvent>
{
  private readonly fallbackAgentId: string;

  public constructor(options: CodexMapperOptions) {
    this.fallbackAgentId = options.fallbackAgentId;
  }

  public mapCommand(
    envelope: CommandEnvelope,
    _context: AdapterMapperContext
  ): CodexRuntimeRequest {
    const method: CodexRuntimeRequest["method"] =
      codexMethodByCommandType[envelope.command.type];
    return {
      id: envelope.commandId,
      method,
      params: {
        ...envelope.command
      }
    };
  }

  public mapCommandResult(
    response: CodexRuntimeResponse,
    envelope: CommandEnvelope
  ) {
    if (response.error) {
      return defaultCommandResultFromResponse(envelope, response, {
        accepted: false,
        error: {
          code: response.error.code ?? "codex_runtime_error",
          message: response.error.message,
          details: response.error.details
        }
      });
    }

    return defaultCommandResultFromResponse(envelope, response, {
      accepted: response.ok ?? true
    });
  }

  public mapRuntimeEvent(
    event: CodexRuntimeEvent,
    context: AdapterMapperContext
  ) {
    const eventType = codexEventTypeByMethod[event.method];
    if (!eventType) {
      return [];
    }

    const runtimeEvent = normalizeRuntimeEvent(
      eventType,
      event.params,
      this.fallbackAgentId
    );

    return [
      createEventEnvelope(runtimeEvent, context, {
        eventId: event.eventId,
        cursor: event.cursor,
        occurredAt: event.occurredAt
      })
    ];
  }
}
