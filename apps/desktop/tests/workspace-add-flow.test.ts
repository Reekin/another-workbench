import { describe, expect, it, vi } from "vitest";
import type { DesktopTransport } from "../src/transport/desktop-transport.js";
import { runAddWorkspaceFlow } from "../src/ui/chat-shell/use-workspace-browser-controller.js";

const workspace = {
  workspaceId: "workspace-new",
  absolutePath: "I:\\repo-new",
  label: "repo-new",
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z"
};

const buildTransport = (input?: {
  add?: () => Promise<typeof workspace>;
}): DesktopTransport =>
  ({
    workspace: {
      pickDirectory: vi.fn().mockResolvedValue({
        canceled: false,
        rootPath: workspace.absolutePath
      }),
      add: vi.fn(input?.add ?? (() => Promise.resolve(workspace)))
    }
  }) as never;

describe("workspace add flow", () => {
  it("commits the durable workspace result before refreshing derived sessions", async () => {
    let resolveRefresh: (() => void) | undefined;
    const syncWorkspace = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      })
    );
    const onWorkspaceCommitted = vi.fn();
    const onStatusNotice = vi.fn();

    const pending = runAddWorkspaceFlow({
      transport: buildTransport(),
      onWorkspaceCommitted,
      syncWorkspace,
      onStatusNotice
    });
    await vi.waitFor(() => expect(syncWorkspace).toHaveBeenCalledWith("workspace-new"));

    expect(onWorkspaceCommitted).toHaveBeenCalledWith(workspace);
    expect(onStatusNotice).toHaveBeenCalledWith({
      message: `Added workspace ${workspace.absolutePath}`,
      source: "workspace-add"
    });

    resolveRefresh?.();
    await pending;
  });

  it("keeps add committed when the follow-up refresh fails", async () => {
    const onWorkspaceCommitted = vi.fn();
    const onStatusNotice = vi.fn();

    await runAddWorkspaceFlow({
      transport: buildTransport(),
      onWorkspaceCommitted,
      syncWorkspace: vi.fn().mockRejectedValue(new Error("refresh failed")),
      onStatusNotice
    });

    expect(onWorkspaceCommitted).toHaveBeenCalledWith(workspace);
    expect(onStatusNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Workspace added, but session browser refresh failed")
      })
    );
    expect(onStatusNotice).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Add workspace failed") })
    );
  });

  it("does not commit or refresh when registration fails", async () => {
    const onWorkspaceCommitted = vi.fn();
    const syncWorkspace = vi.fn();
    const onStatusNotice = vi.fn();

    await runAddWorkspaceFlow({
      transport: buildTransport({
        add: () => Promise.reject(new Error("registration failed"))
      }),
      onWorkspaceCommitted,
      syncWorkspace,
      onStatusNotice
    });

    expect(onWorkspaceCommitted).not.toHaveBeenCalled();
    expect(syncWorkspace).not.toHaveBeenCalled();
    expect(onStatusNotice).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Add workspace failed") })
    );
  });
});
