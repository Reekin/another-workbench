import type { CommandEnvelope, RuntimeEvent } from "@another-workbench/shared";
import type { AdapterMapper, AdapterMapperContext } from "../mapper.js";
import {
  createEventEnvelope,
  defaultCommandResultFromResponse,
  normalizeRuntimeEvent
} from "../mapper-helpers.js";
import type {
  AcpRuntimeEvent,
  AcpRuntimeRequest,
  AcpRuntimeResponse
} from "./types.js";

const acpMethodByCommandType: Record<
  CommandEnvelope["command"]["type"],
  AcpRuntimeRequest["method"]
> = {
  initialize: "agent.initialize",
  createSession: "session.create",
  listSessions: "session.list",
  resumeSession: "session.load",
  archiveSession: "session.archive",
  forkSession: "session.fork",
  sendUserMessage: "turn.send",
  steerTurn: "turn.steer",
  interruptTurn: "turn.interrupt",
  respondApproval: "approval.respond",
  disposeSession: "session.dispose"
};

const acpEventTypeByName: Record<string, RuntimeEvent["type"]> = {
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

export type AcpMapperOptions = {
  fallbackAgentId: string;
};

export class AcpMapper
  implements AdapterMapper<AcpRuntimeRequest, AcpRuntimeResponse, AcpRuntimeEvent>
{
  private readonly fallbackAgentId: string;

  public constructor(options: AcpMapperOptions) {
    this.fallbackAgentId = options.fallbackAgentId;
  }

  public mapCommand(
    envelope: CommandEnvelope,
    _context: AdapterMapperContext
  ): AcpRuntimeRequest {
    const method: AcpRuntimeRequest["method"] =
      acpMethodByCommandType[envelope.command.type];
    return {
      id: envelope.commandId,
      method,
      params: {
        ...envelope.command
      }
    };
  }

  public mapCommandResult(
    response: AcpRuntimeResponse,
    envelope: CommandEnvelope
  ) {
    if (response.error) {
      return defaultCommandResultFromResponse(envelope, response, {
        accepted: false,
        error: {
          code: response.error.code ?? "acp_runtime_error",
          message: response.error.message,
          details: response.error.details
        }
      });
    }

    return defaultCommandResultFromResponse(envelope, response, {
      accepted: response.ok ?? true
    });
  }

  public mapRuntimeEvent(event: AcpRuntimeEvent, context: AdapterMapperContext) {
    const eventType = acpEventTypeByName[event.event];
    if (!eventType) {
      return [];
    }

    const runtimeEvent = normalizeRuntimeEvent(
      eventType,
      event.payload,
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
