import { describe, expect, it, vi } from "vitest";
import type { DesktopTransport } from "../src/transport/desktop-transport.js";
import {
  openWorkspaceDirectory,
  workspaceDirectoryActionLabel
} from "../src/ui/chat-shell/workspace-actions.js";

describe("workspace actions", () => {
  it("opens the workspace root through the file action transport", async () => {
    const runAction = vi.fn().mockResolvedValue({
      action: "open",
      ok: true,
      displayPath: "I:/workspace-alpha",
      fileUrl: "file:///I:/workspace-alpha"
    });
    const onStatusNotice = vi.fn();

    await openWorkspaceDirectory({
      transport: {
        file: {
          runAction
        }
      } as unknown as DesktopTransport,
      workspace: {
        label: "Alpha",
        rootPath: "I:/workspace-alpha"
      },
      onStatusNotice
    });

    expect(workspaceDirectoryActionLabel).toBe("Open workspace directory");
    expect(runAction).toHaveBeenCalledWith({
      path: "I:/workspace-alpha",
      action: "open"
    });
    expect(onStatusNotice).toHaveBeenCalledWith({
      message: "Opened workspace Alpha",
      source: "workspace-action"
    });
  });

  it("surfaces host failures as persistent status notices", async () => {
    const runAction = vi.fn().mockResolvedValue({
      action: "open",
      ok: false,
      displayPath: "I:/workspace-alpha",
      fileUrl: "file:///I:/workspace-alpha",
      errorMessage: "Explorer unavailable"
    });
    const onStatusNotice = vi.fn();

    await openWorkspaceDirectory({
      transport: {
        file: {
          runAction
        }
      } as unknown as DesktopTransport,
      workspace: {
        label: "Alpha",
        rootPath: "I:/workspace-alpha"
      },
      onStatusNotice
    });

    expect(onStatusNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Open workspace directory failed: Explorer unavailable",
        persistent: true,
        severity: "error",
        source: "workspace-action"
      })
    );
  });
});
