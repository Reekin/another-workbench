import { describe, expect, it, vi } from "vitest";
import { WorkspaceSelectionService } from "../src/workspace-selection-service.js";

describe("WorkspaceSelectionService", () => {
  it("preserves the active session only when reselecting the current workspace", async () => {
    const ready = vi.fn().mockResolvedValue(undefined);
    const getState = vi
      .fn()
      .mockReturnValueOnce({
        lastActiveWorkspaceId: "workspace-1",
        lastActiveSessionId: "session-1"
      })
      .mockReturnValueOnce({
        lastActiveWorkspaceId: "workspace-1",
        lastActiveSessionId: "session-1"
      });
    const setLastActiveSelection = vi.fn().mockResolvedValue(undefined);
    const service = new WorkspaceSelectionService({
      workspaceRegistry: {
        ready,
        getState,
        setLastActiveSelection
      } as never
    });

    await expect(service.selectWorkspace("workspace-1")).resolves.toEqual({
      workspaceId: "workspace-1",
      activeSessionId: "session-1"
    });
    await expect(service.selectWorkspace("workspace-2")).resolves.toEqual({
      workspaceId: "workspace-2",
      activeSessionId: undefined
    });
    expect(setLastActiveSelection).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      sessionId: "session-1"
    });
    expect(setLastActiveSelection).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-2",
      sessionId: undefined
    });
  });

  it("writes explicit session activation selections", async () => {
    const setLastActiveSelection = vi.fn().mockResolvedValue(undefined);
    const service = new WorkspaceSelectionService({
      workspaceRegistry: {
        setLastActiveSelection
      } as never
    });

    await service.activateSelection({
      workspaceId: "workspace-1",
      sessionId: "session-9"
    });

    expect(setLastActiveSelection).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-9"
    });
  });
});
