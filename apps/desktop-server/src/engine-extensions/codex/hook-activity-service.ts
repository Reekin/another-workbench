import type { CodexHookActivityResultRpc } from "@another-workbench/shared";
import { getRecordedCodexHookActivity } from "./hook-activity-store.js";

export type CodexHookActivityServiceOptions = {
  resolveSessionEngineId: (sessionId: string) => string | undefined;
};

const codexAgentId = "codex";

export class CodexHookActivityService {
  private readonly resolveSessionEngineId: CodexHookActivityServiceOptions["resolveSessionEngineId"];

  public constructor(options: CodexHookActivityServiceOptions) {
    this.resolveSessionEngineId = options.resolveSessionEngineId;
  }

  public async getHookActivity(input: {
    sessionId: string;
    turnId: string;
  }): Promise<CodexHookActivityResultRpc> {
    this.assertCodexSession(input.sessionId);
    return {
      engineId: codexAgentId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      runs: getRecordedCodexHookActivity(input.sessionId, input.turnId)?.runs ?? []
    };
  }

  private assertCodexSession(sessionId: string): void {
    const engineId = this.resolveSessionEngineId(sessionId);
    if (engineId && engineId !== codexAgentId) {
      throw new Error(`Codex hook activity is unavailable for engine: ${engineId}`);
    }
  }
}
