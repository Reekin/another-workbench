import { isAbsolute, resolve } from "node:path";
import type {
  CodexTurnChangesResultRpc,
  CodexTurnChangesUndoResultRpc
} from "@another-workbench/shared";
import {
  createFileReferenceFromPath,
  isAbsoluteFilePath
} from "@another-workbench/shared";
import { getRecordedCodexTurnChanges } from "./turn-changes-store.js";

export type CodexTurnChangesServiceOptions = {
  resolveSessionAgentId: (sessionId: string) => string | undefined;
  resolveWorkingDirectory: (sessionId: string) => Promise<string>;
  undoTurnChanges: (input: {
    cwd: string;
    diff: string;
  }) => Promise<{
    undone: boolean;
    errorMessage?: string;
  }>;
};

const codexAgentId = "codex";

const resolveFilePath = (cwd: string, path: string): string => {
  if (isAbsoluteFilePath(path) || isAbsolute(path)) {
    return path;
  }
  return resolve(cwd, path);
};

export class CodexTurnChangesService {
  private readonly resolveSessionAgentId: CodexTurnChangesServiceOptions["resolveSessionAgentId"];
  private readonly resolveWorkingDirectory: CodexTurnChangesServiceOptions["resolveWorkingDirectory"];
  private readonly undoTurnChangesImpl: CodexTurnChangesServiceOptions["undoTurnChanges"];

  public constructor(options: CodexTurnChangesServiceOptions) {
    this.resolveSessionAgentId = options.resolveSessionAgentId;
    this.resolveWorkingDirectory = options.resolveWorkingDirectory;
    this.undoTurnChangesImpl = options.undoTurnChanges;
  }

  public async getTurnChanges(input: {
    sessionId: string;
    turnId: string;
  }): Promise<CodexTurnChangesResultRpc> {
    this.assertCodexSession(input.sessionId);
    const record = getRecordedCodexTurnChanges(input.sessionId, input.turnId);
    const needsWorkingDirectory = (record?.changes ?? []).some(
      (change) => !isAbsoluteFilePath(change.path) && !isAbsolute(change.path)
    );
    const cwd = needsWorkingDirectory
      ? await this.resolveWorkingDirectory(input.sessionId)
      : undefined;

    return {
      engineId: codexAgentId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      changedFiles: (record?.changes ?? []).map((change) => ({
        ...createFileReferenceFromPath(
          cwd ? resolveFilePath(cwd, change.path) : change.path,
          "inline_path"
        ),
        changeKind: change.changeKind,
        diff: change.diff
      })),
      canUndo: Boolean(record?.mergedDiff?.trim())
    };
  }

  public async undoTurnChanges(input: {
    sessionId: string;
    turnId: string;
  }): Promise<CodexTurnChangesUndoResultRpc> {
    this.assertCodexSession(input.sessionId);
    const cwd = await this.resolveWorkingDirectory(input.sessionId);
    const diff = getRecordedCodexTurnChanges(input.sessionId, input.turnId)?.mergedDiff ?? "";
    const result = await this.undoTurnChangesImpl({
      cwd,
      diff
    });
    return {
      engineId: codexAgentId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      undone: result.undone,
      displayPath: cwd,
      errorMessage: result.errorMessage
    };
  }

  private assertCodexSession(sessionId: string): void {
    const agentId = this.resolveSessionAgentId(sessionId);
    if (agentId && agentId !== codexAgentId) {
      throw new Error(`Codex turn changes are unavailable for agent: ${agentId}`);
    }
  }
}
