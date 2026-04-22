import type { FileActionKindRpc, FileActionResultRpc } from "@another-workbench/shared";
import { createFileReferenceFromPath } from "@another-workbench/shared";

type HostActionCallback = (path: string) => Promise<string | void> | string | void;

export type FileActionServiceOptions = {
  openPath?: HostActionCallback;
  revealPath?: HostActionCallback;
};

export class FileActionService {
  private readonly openPath?: HostActionCallback;
  private readonly revealPath?: HostActionCallback;

  public constructor(options: FileActionServiceOptions = {}) {
    this.openPath = options.openPath;
    this.revealPath = options.revealPath;
  }

  public async runAction(input: {
    path: string;
    action: FileActionKindRpc;
  }): Promise<FileActionResultRpc> {
    const target = createFileReferenceFromPath(input.path, "inline_path");
    const callback =
      input.action === "open" ? this.openPath : this.revealPath;

    if (!callback) {
      return {
        action: input.action,
        ok: false,
        displayPath: target.displayPath,
        fileUrl: target.fileUrl,
        errorMessage: "Host file actions are unavailable in this environment."
      };
    }

    try {
      const errorMessage = await callback(input.path);
      return {
        action: input.action,
        ok: !errorMessage,
        displayPath: target.displayPath,
        fileUrl: target.fileUrl,
        errorMessage: errorMessage || undefined
      };
    } catch (error) {
      return {
        action: input.action,
        ok: false,
        displayPath: target.displayPath,
        fileUrl: target.fileUrl,
        errorMessage: error instanceof Error ? error.message : "Unknown file action failure."
      };
    }
  }
}
