import type { DesktopTransport } from "../../transport/desktop-transport.js";
import type { WorkspaceBrowserViewNode } from "./workspace-browser-tree.js";
import {
  statusNoticeErrorDetails,
  type ComposerStatusNotice
} from "./composer-status.js";

type StatusNoticeSetter = (
  notice: ComposerStatusNotice | undefined
) => void;

export const workspaceDirectoryActionLabel = "Open workspace directory";

export const openWorkspaceDirectory = async (input: {
  transport?: DesktopTransport;
  workspace: Pick<WorkspaceBrowserViewNode, "label" | "rootPath">;
  onStatusNotice: StatusNoticeSetter;
}): Promise<void> => {
  if (!input.transport) {
    return;
  }

  try {
    const result = await input.transport.file.runAction({
      path: input.workspace.rootPath,
      action: "open"
    });
    if (!result.ok) {
      throw new Error(result.errorMessage ?? "Open workspace directory failed.");
    }
    input.onStatusNotice({
      message: `Opened workspace ${input.workspace.label}`,
      source: "workspace-action"
    });
  } catch (error) {
    input.onStatusNotice({
      message: `Open workspace directory failed: ${(error as Error).message}`,
      persistent: true,
      source: "workspace-action",
      ...statusNoticeErrorDetails(error)
    });
  }
};
