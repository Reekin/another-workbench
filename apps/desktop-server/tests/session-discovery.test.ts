import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../src/codex-app-server-generated/v2/Thread.js";
import {
  CodexSessionDiscoveryProvider,
  SessionReconciliationService
} from "../src/session-discovery.js";
import { SessionIndexStore } from "../src/session-index.js";
import { WorkbenchRuntimeService } from "../src/runtime-service.js";
import { WorkspaceRegistryService } from "../src/workspace-registry.js";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-session-discovery-"));
  tempDirs.push(dir);
  return dir;
};

const createThread = (input: {
  id: string;
  source?: Thread["source"];
  name?: string | null;
  preview?: string;
}): Thread => ({
  id: input.id,
  preview: input.preview ?? `Preview ${input.id}`,
  ephemeral: false,
  modelProvider: "openai",
  createdAt: 1_776_420_000,
  updatedAt: 1_776_420_120,
  status: {
    type: "idle"
  },
  path: `I:/rollouts/${input.id}.md`,
  cwd: "I:/workspace-alpha",
  cliVersion: "1.0.0",
  source: input.source ?? "appServer",
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: input.name ?? null,
  turns: []
});

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("Session discovery and reconciliation", () => {
  it("discovers codex threads, derives subagent relations, and hydrates discovered sessions", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const sessionIndexStore = new SessionIndexStore({
      baseDir
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    });

    const rootThread = createThread({
      id: "thread-root",
      name: "Root Thread",
      preview: "Root preview"
    });
    const childThread = createThread({
      id: "thread-child",
      name: "Child Thread",
      preview: "Child preview",
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: "thread-root",
            depth: 1,
            agent_nickname: "child",
            agent_role: "reviewer"
          }
        }
      }
    });

    const attachThreadToSession = vi.fn();
    const readThread = vi.fn().mockResolvedValue({
      ...rootThread,
      turns: [
        {
          id: "turn-1",
          status: "completed",
          error: null,
          items: [
            {
              type: "userMessage",
              id: "msg-user-1",
              content: [
                {
                  type: "text",
                  text: "Reply with exactly hi.",
                  text_elements: []
                }
              ]
            },
            {
              type: "agentMessage",
              id: "msg-1",
              text: "Hydrated root response",
              phase: null,
              memoryCitation: null
            }
          ]
        },
        {
          id: "turn-2",
          status: "failed",
          error: {
            message: "Boom",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: "Try again later."
          },
          items: []
        }
      ]
    });
    const listThreads = vi.fn().mockResolvedValue({
      data: [rootThread, childThread],
      nextCursor: null
    });

    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        listThreads,
        readThread,
        attachThreadToSession
      } as never
    });

    const runtimeService = new WorkbenchRuntimeService({
      agents: [
        {
          agentId: "codex",
          displayName: "Codex",
          capabilities: ["chat"]
        }
      ]
    });

    const reconciliation = new SessionReconciliationService({
      workspaceRegistry,
      sessionIndexStore,
      runtimeService,
      providers: [provider]
    });

    await expect(reconciliation.reconcileWorkspace("workspace-1")).resolves.toEqual({
      workspaces: 1,
      sessions: 2,
      relations: 1
    });

    expect(sessionIndexStore.getEntry("codex-thread:thread-root")).toMatchObject({
      providerKind: "codex-thread",
      providerSessionId: "thread-root",
      conversationId: "conversation-discovered:codex-thread:thread-root",
      source: "reconciled"
    });
    expect(sessionIndexStore.getEntry("codex-thread:thread-child")).toMatchObject({
      providerSessionId: "thread-child",
      conversationId: "conversation-discovered:codex-thread:thread-root"
    });
    expect(sessionIndexStore.listRelations("workspace-1")).toEqual([
      expect.objectContaining({
        parentSessionId: "codex-thread:thread-root",
        childSessionId: "codex-thread:thread-child",
        relationType: "subagent"
      })
    ]);

    await expect(
      reconciliation.ensureSessionLoaded("codex-thread:thread-root")
    ).resolves.toBe(true);

    expect(attachThreadToSession).toHaveBeenCalledWith(
      "codex-thread:thread-root",
      "thread-root"
    );
    expect(runtimeService.listSessions({ includeArchived: true })).toEqual([
      expect.objectContaining({
        sessionId: "codex-thread:thread-root",
        conversationId: "conversation-discovered:codex-thread:thread-root"
      })
    ]);
    expect(runtimeService.getSnapshot().messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "codex-thread:thread-root",
          role: "user",
          text: "Reply with exactly hi."
        }),
        expect.objectContaining({
          sessionId: "codex-thread:thread-root",
          role: "assistant",
          text: "Hydrated root response"
        }),
        expect.objectContaining({
          sessionId: "codex-thread:thread-root",
          turnId: "turn-2",
          role: "system",
          text: "Runtime error (usageLimitExceeded): Boom\n\nTry again later."
        })
      ])
    );
    expect(runtimeService.getSnapshot().turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: "turn-2",
          status: "completed",
          finishReason: "failed"
        })
      ])
    );
  });
});
