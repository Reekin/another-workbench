import { AcpAdapter, type AcpAdapterOptions } from "./acp/adapter.js";
import type { AcpRuntimeEvent, AcpRuntimeRequest, AcpRuntimeResponse } from "./acp/types.js";
import { CodexAdapter, type CodexAdapterOptions } from "./codex/adapter.js";
import type {
  CodexRuntimeEvent,
  CodexRuntimeRequest,
  CodexRuntimeResponse
} from "./codex/types.js";
import type { AdapterRuntimePort } from "./runtime-port.js";

export const createCodexAdapter = (
  runtimePort: AdapterRuntimePort<
    CodexRuntimeRequest,
    CodexRuntimeResponse,
    CodexRuntimeEvent
  >,
  options: Omit<CodexAdapterOptions, "runtimePort"> = {}
) =>
  new CodexAdapter({
    ...options,
    runtimePort
  });

export const createAcpAdapter = (
  runtimePort: AdapterRuntimePort<
    AcpRuntimeRequest,
    AcpRuntimeResponse,
    AcpRuntimeEvent
  >,
  options: Omit<AcpAdapterOptions, "runtimePort"> = {}
) =>
  new AcpAdapter({
    ...options,
    runtimePort
  });

