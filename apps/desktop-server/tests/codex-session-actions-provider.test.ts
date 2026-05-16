import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerRuntimePort } from "../src/codex-app-server-runtime-port.js";
import { CodexSessionActionsProvider } from "../src/codex-session-actions-provider.js";

describe("CodexSessionActionsProvider", () => {
  it("prefers the live thread id when copying the displayed session id", () => {
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {
        getThreadIdForSession: vi.fn().mockReturnValue("thread-live")
      } as unknown as CodexAppServerRuntimePort
    });

    expect(
      provider.resolveDisplayedSessionId({
        sessionId: "session-1",
        engineId: "codex",
        runtimeService: {} as never,
        sessionIndexStore: {} as never,
        indexEntry: {
          sessionId: "session-1",
          providerSessionId: "thread-indexed"
        } as never
      })
    ).toBe("thread-live");
  });

  it("exposes rollout action availability based on thread identity", async () => {
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {
        getThreadIdForSession: vi.fn().mockReturnValue(undefined)
      } as unknown as CodexAppServerRuntimePort
    });

    await expect(
      provider.listAdditionalActions({
        sessionId: "session-1",
        engineId: "codex",
        runtimeService: {} as never,
        sessionIndexStore: {} as never
      })
    ).resolves.toEqual([
      {
        action: "open_rollout",
        label: "Open rollout",
        disabled: true,
        reason: "Rollout is not available until the thread is created."
      }
    ]);
  });

  it("archives the underlying Codex thread before the generic archive flow continues", async () => {
    const archiveThread = vi.fn().mockResolvedValue(undefined);
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {
        getThreadIdForSession: vi.fn().mockReturnValue("thread-1"),
        archiveThread
      } as unknown as CodexAppServerRuntimePort
    });

    await provider.prepareArchive({
      sessionId: "session-1",
      engineId: "codex",
      runtimeService: {} as never,
      sessionIndexStore: {} as never
    });

    expect(archiveThread).toHaveBeenCalledWith("thread-1");
  });

  it("refreshes Codex user config, MCP servers, and skill discovery", async () => {
    const reloadUserConfig = vi.fn().mockResolvedValue(undefined);
    const reloadMcpServers = vi.fn().mockResolvedValue(undefined);
    const listSkills = vi.fn().mockResolvedValue([]);
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {
        getThreadIdForSession: vi.fn().mockReturnValue("thread-1"),
        reloadUserConfig,
        reloadMcpServers,
        listSkills
      } as unknown as CodexAppServerRuntimePort
    });

    await expect(
      provider.runAction({
        sessionId: "session-1",
        engineId: "codex",
        action: "refresh",
        runtimeService: {} as never,
        sessionIndexStore: {} as never
      })
    ).resolves.toEqual({
      action: "refresh",
      refreshed: true,
      details: "Reloaded user config, refreshed skills, and queued MCP server reloads for loaded Codex threads."
    });

    expect(reloadUserConfig).toHaveBeenCalledTimes(1);
    expect(reloadMcpServers).toHaveBeenCalledTimes(1);
    expect(listSkills).toHaveBeenCalledWith({
      forceReload: true
    });
  });

  it("interrupts, unsubscribes, and resumes the underlying Codex thread before reattaching it", async () => {
    const interruptThread = vi.fn().mockResolvedValue(undefined);
    const unsubscribeThread = vi.fn().mockResolvedValue(undefined);
    const resumeThread = vi.fn().mockResolvedValue({
      id: "thread-2"
    });
    const attachThreadToSession = vi.fn();
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {
        getThreadIdForSession: vi.fn().mockReturnValue("thread-1"),
        interruptThread,
        unsubscribeThread,
        resumeThread,
        attachThreadToSession
      } as unknown as CodexAppServerRuntimePort
    });

    await expect(
      provider.runAction({
        sessionId: "session-1",
        engineId: "codex",
        action: "resume",
        runtimeService: {} as never,
        sessionIndexStore: {} as never
      })
    ).resolves.toEqual({
      action: "resume",
      resumed: true
    });

    expect(interruptThread).toHaveBeenCalledWith("thread-1", {
      bestEffort: true
    });
    expect(unsubscribeThread).toHaveBeenCalledWith("thread-1");
    expect(resumeThread).toHaveBeenCalledWith("thread-1");
    expect(attachThreadToSession).toHaveBeenCalledWith("session-1", "thread-2");
  });

  it("opens rollout paths through the Codex thread reader", async () => {
    const readThread = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        path: "\\\\?\\I:\\rollouts\\thread-1.md"
      });
    const provider = new CodexSessionActionsProvider({
      codexRuntimePort: {
        getThreadIdForSession: vi.fn().mockReturnValue("thread-1"),
        readThread
      } as unknown as CodexAppServerRuntimePort
    });

    await expect(
      provider.runAction({
        sessionId: "session-1",
        engineId: "codex",
        action: "open_rollout",
        runtimeService: {} as never,
        sessionIndexStore: {} as never
      })
    ).rejects.toThrow("Codex thread does not expose a rollout path.");

    await expect(
      provider.runAction({
        sessionId: "session-1",
        engineId: "codex",
        action: "open_rollout",
        runtimeService: {} as never,
        sessionIndexStore: {} as never
      })
    ).resolves.toEqual({
      action: "open_rollout",
      rolloutPath: "\\\\?\\I:\\rollouts\\thread-1.md",
      rolloutDisplayPath: "I:\\rollouts\\thread-1.md",
      rolloutFileUrl: "file:///I:/rollouts/thread-1.md"
    });
  });
});
