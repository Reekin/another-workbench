import type { ChatSession } from "@another-workbench/shared";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerRuntimePort } from "../src/codex-app-server-runtime-port.js";
import type { WorkbenchRuntimeService } from "../src/runtime-service.js";
import { SessionActionsProvider } from "../src/session-actions.js";

const createSession = (input: {
  sessionId: string;
  agentId: string;
  archivedAt?: string;
}): ChatSession => ({
  sessionId: input.sessionId,
  conversationId: "conversation-1",
  agentId: input.agentId,
  status: "idle",
  title: input.sessionId,
  createdAt: "2026-04-18T00:00:01Z",
  updatedAt: "2026-04-18T00:00:01Z",
  archivedAt: input.archivedAt
});

describe("SessionActionsProvider", () => {
  it("lists action descriptors with codex rollout capability and archive disable reasons", async () => {
    const runtimeService = {
      listSessions: vi.fn().mockReturnValue([
        createSession({
          sessionId: "session-codex",
          agentId: "codex",
          archivedAt: "2026-04-18T00:01:00Z"
        })
      ])
    } as unknown as WorkbenchRuntimeService;
    const codexRuntimePort = {
      getThreadIdForSession: vi.fn().mockReturnValue(undefined)
    } as unknown as CodexAppServerRuntimePort;
    const provider = new SessionActionsProvider({
      runtimeService,
      codexRuntimePort,
      sessionIndexStore: {
        getEntry: vi.fn().mockReturnValue(undefined)
      } as never
    });

    const actions = await provider.listActions("session-codex");
    const unknown = await provider.listActions("session-missing");

    expect(unknown).toEqual([
      {
        action: "copy_session_id",
        label: "Copy session id"
      }
    ]);
    expect(actions).toEqual([
      {
        action: "copy_session_id",
        label: "Copy session id"
      },
      {
        action: "archive",
        label: "Archive",
        disabled: true,
        reason: "Session is already archived."
      },
      {
        action: "reload",
        label: "Reload"
      },
      {
        action: "open_rollout",
        label: "Open rollout",
        disabled: true,
        reason: "Rollout is not available until the thread is created."
      }
    ]);
  });

  it("runs archive and reload actions by forwarding runtime commands", async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      commandId: "ignored",
      commandType: "listSessions",
      accepted: true
    });
    const runtimeService = {
      listSessions: vi.fn().mockReturnValue([
        createSession({
          sessionId: "session-1",
          agentId: "codex"
        })
      ]),
      executeCommand
    } as unknown as WorkbenchRuntimeService;
    const codexRuntimePort = {
      getThreadIdForSession: vi.fn().mockReturnValue("thread-1"),
      readThread: vi.fn()
    } as unknown as CodexAppServerRuntimePort;
    const provider = new SessionActionsProvider({
      runtimeService,
      codexRuntimePort,
      sessionIndexStore: {
        getEntry: vi.fn((sessionId: string) =>
          sessionId === "session-missing"
            ? {
                sessionId,
                providerSessionId: "thread-missing"
              }
            : undefined
        )
      } as never
    });

    const archiveResult = await provider.runAction("session-1", "archive");
    const reloadResult = await provider.runAction("session-1", "reload");
    const copyResult = await provider.runAction("session-missing", "copy_session_id");

    expect(archiveResult).toEqual({
      action: "archive",
      archived: true
    });
    expect(reloadResult).toEqual({
      action: "reload",
      resumed: true
    });
    expect(copyResult).toEqual({
      action: "copy_session_id",
      copiedText: "thread-missing"
    });
    expect(executeCommand).toHaveBeenNthCalledWith(1, {
      commandId: "archive-session-1",
      command: {
        type: "archiveSession",
        sessionId: "session-1"
      }
    });
    expect(executeCommand).toHaveBeenNthCalledWith(2, {
      commandId: "resume-session-1",
      command: {
        type: "resumeSession",
        sessionId: "session-1"
      }
    });
  });

  it("resolves rollout paths only for codex sessions with an available thread path", async () => {
    const runtimeService = {
      listSessions: vi.fn().mockReturnValue([
        createSession({
          sessionId: "session-codex",
          agentId: "codex"
        }),
        createSession({
          sessionId: "session-acp",
          agentId: "acp"
        })
      ])
    } as unknown as WorkbenchRuntimeService;
    const getThreadIdForSession = vi.fn((sessionId: string) => {
      if (sessionId === "session-codex") {
        return "thread-1";
      }
      return undefined;
    });
    const readThread = vi.fn().mockResolvedValue({
      path: "I:/rollouts/thread-1.md"
    });
    const provider = new SessionActionsProvider({
      runtimeService,
      codexRuntimePort: {
        getThreadIdForSession,
        readThread
      } as unknown as CodexAppServerRuntimePort,
      sessionIndexStore: {
        getEntry: vi.fn().mockReturnValue(undefined)
      } as never
    });

    await expect(provider.runAction("session-acp", "open_rollout")).rejects.toThrow(
      "Open rollout is not supported for acp sessions."
    );

    getThreadIdForSession.mockImplementation(() => undefined);
    await expect(provider.runAction("session-codex", "open_rollout")).rejects.toThrow(
      "Rollout path is unavailable before the thread is created."
    );

    getThreadIdForSession.mockImplementation(() => "thread-1");
    readThread.mockResolvedValueOnce({});
    await expect(provider.runAction("session-codex", "open_rollout")).rejects.toThrow(
      "Codex thread does not expose a rollout path."
    );

    readThread.mockResolvedValueOnce({
      path: "I:/rollouts/thread-1.md"
    });
    await expect(provider.runAction("session-codex", "open_rollout")).resolves.toEqual({
      action: "open_rollout",
      rolloutPath: "I:/rollouts/thread-1.md"
    });
  });

  it("rejects non-copy actions for unknown sessions", async () => {
    const runtimeService = {
      listSessions: vi.fn().mockReturnValue([])
    } as unknown as WorkbenchRuntimeService;
    const provider = new SessionActionsProvider({
      runtimeService,
      codexRuntimePort: {
        getThreadIdForSession: vi.fn()
      } as unknown as CodexAppServerRuntimePort,
      sessionIndexStore: {
        getEntry: vi.fn().mockReturnValue(undefined)
      } as never
    });

    await expect(provider.runAction("session-missing", "archive")).rejects.toThrow(
      "Unknown session: session-missing"
    );
  });

  it("prefers the provider-native session id when copying a codex session reference", async () => {
    const runtimeService = {
      listSessions: vi.fn().mockReturnValue([
        createSession({
          sessionId: "session-codex",
          agentId: "codex"
        })
      ])
    } as unknown as WorkbenchRuntimeService;
    const provider = new SessionActionsProvider({
      runtimeService,
      codexRuntimePort: {
        getThreadIdForSession: vi.fn().mockReturnValue("thread-123"),
        readThread: vi.fn()
      } as unknown as CodexAppServerRuntimePort,
      sessionIndexStore: {
        getEntry: vi.fn().mockReturnValue(undefined)
      } as never
    });

    await expect(provider.runAction("session-codex", "copy_session_id")).resolves.toEqual({
      action: "copy_session_id",
      copiedText: "thread-123"
    });
  });
});
