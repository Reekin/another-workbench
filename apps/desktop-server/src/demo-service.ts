import {
  createAcpAdapter,
  createCodexAdapter
} from "@another-workbench/adapters";
import { createAcpDemoRuntimePort, createCodexDemoRuntimePort } from "./demo-runtime-port.js";
import { WorkbenchRuntimeService } from "./runtime-service.js";

export const createDemoWorkbenchRuntimeService = () => {
  const codexAgentId = "codex";
  const acpAgentId = "acp";

  const service = new WorkbenchRuntimeService({
    agentBindings: [
      {
        descriptor: {
          agentId: codexAgentId,
          displayName: "Codex",
          capabilities: ["chat", "tool", "terminal", "approval"]
        },
        adapter: createCodexAdapter(createCodexDemoRuntimePort(codexAgentId), {
          id: codexAgentId,
          fallbackAgentId: codexAgentId
        })
      },
      {
        descriptor: {
          agentId: acpAgentId,
          displayName: "ACP",
          capabilities: ["chat", "tool", "terminal", "approval"]
        },
        adapter: createAcpAdapter(createAcpDemoRuntimePort(acpAgentId), {
          id: acpAgentId,
          fallbackAgentId: acpAgentId
        })
      }
    ]
  });

  return service;
};
