import type { CommandEnvelope, EventEnvelope } from "@another-workbench/shared";
import type { AdapterCommandResult } from "./types.js";

export type AdapterMapperContext = {
  adapterId: string;
  now: () => string;
  createId: () => string;
};

export interface AdapterMapper<TRequest, TResponse, TEvent> {
  mapCommand(
    envelope: CommandEnvelope,
    context: AdapterMapperContext
  ): TRequest;
  mapCommandResult(
    response: TResponse,
    envelope: CommandEnvelope,
    context: AdapterMapperContext
  ): AdapterCommandResult;
  mapRuntimeEvent(
    event: TEvent,
    context: AdapterMapperContext
  ): EventEnvelope[];
}

