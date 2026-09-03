import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRegistryService } from "../src/workspace-registry.js";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-workspace-registry-"));
  tempDirs.push(dir);
  return dir;
};

const writeRegistry = async (
  baseDir: string,
  value: Record<string, unknown>
): Promise<string> => {
  const filePath = join(baseDir, "workspace-registry.json");
  await mkdir(baseDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(value), "utf8");
  return filePath;
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("WorkspaceRegistryService", () => {
  it("persists workspaces, expansion state, and last active selection", async () => {
    const baseDir = await createTempDir();
    const service = new WorkspaceRegistryService({
      baseDir,
      now: (() => {
        let tick = 0;
        return () => `2026-04-18T00:00:${String(++tick).padStart(2, "0")}Z`;
      })(),
      createWorkspaceId: (() => {
        let index = 0;
        return () => `workspace-${++index}`;
      })()
    });

    const alpha = await service.registerWorkspace({
      absolutePath: "D:/workspace/another-workbench"
    });
    const beta = await service.registerWorkspace({
      absolutePath: "D:/workspace/tools",
      label: "Tools"
    });
    await service.reorderWorkspaces([beta.workspaceId, alpha.workspaceId]);
    await service.setWorkspaceExpanded(beta.workspaceId, true);
    await service.setSessionExpanded("session-42", true);
    await service.setSessionPinned("session-42", true);
    await service.setLastActiveSelection({
      workspaceId: beta.workspaceId,
      sessionId: "session-42"
    });
    await service.updateSettings({
      defaultNewSessionEngineId: "pi",
      allowedModelIdsByEngineId: {
        codex: ["gpt-5.5-codex"],
        "pi-acp": []
      },
      customModelReasoningOptionIdsByEngineId: {
        codex: {
          "custom-model": ["low", "high"]
        }
      },
      serviceTierPreferencesByEngineId: {
        codex: {
          "gpt-5.5-codex": "priority"
        }
      },
      lastExecutionByEngineId: {
        codex: {
          modelId: "gpt-5.5-codex",
          reasoningOptionId: "high"
        }
      }
    });

    const reloaded = new WorkspaceRegistryService({
      baseDir
    });
    await reloaded.ready();

    expect(reloaded.listWorkspaces().map((workspace) => workspace.workspaceId)).toEqual([
      beta.workspaceId,
      alpha.workspaceId
    ]);
    expect(reloaded.getState()).toMatchObject({
      expandedWorkspaceIds: [beta.workspaceId],
      expandedSessionIds: ["session-42"],
      pinnedSessionIds: ["session-42"],
      defaultNewSessionEngineId: "pi",
      allowedModelIdsByEngineId: {
        codex: ["gpt-5.5-codex"],
        "pi-acp": []
      },
      customModelReasoningOptionIdsByEngineId: {
        codex: {
          "custom-model": ["low", "high"]
        }
      },
      serviceTierPreferencesByEngineId: {
        codex: {
          "gpt-5.5-codex": "priority"
        }
      },
      lastExecutionByEngineId: {
        codex: {
          modelId: "gpt-5.5-codex",
          reasoningOptionId: "high"
        }
      },
      lastActiveWorkspaceId: beta.workspaceId,
      lastActiveSessionId: "session-42"
    });
  });

  it("toggles pinned sessions without duplicating persisted ids", async () => {
    const baseDir = await createTempDir();
    const service = new WorkspaceRegistryService({ baseDir });

    await service.setSessionPinned("session-1", true);
    await service.setSessionPinned("session-1", true);
    expect(service.getState().pinnedSessionIds).toEqual(["session-1"]);

    await service.setSessionPinned("session-1", false);
    expect(service.getState().pinnedSessionIds).toEqual([]);
  });

  it("clones model settings and preserves unrelated settings", async () => {
    const baseDir = await createTempDir();
    const service = new WorkspaceRegistryService({ baseDir });
    await service.updateSettings({ defaultNewSessionEngineId: "codex" });
    await service.updateSettings({
      engineProgramPathsByEngineId: {
        codex: " C:\\tools\\codex.exe ",
        "pi-acp": ""
      }
    });
    const configured = { codex: ["gpt-5.5-codex"], "pi-acp": [] };
    const customReasoning = {
      codex: { "custom-model": ["low", "high"] }
    };
    const serviceTierPreferences = {
      codex: { "gpt-5.5-codex": "priority" as string | null }
    };
    const lastExecution = {
      codex: {
        modelId: "gpt-5.5-codex",
        reasoningOptionId: "high",
        serviceTierId: "priority"
      }
    };

    await service.updateSettings({ allowedModelIdsByEngineId: configured });
    await service.updateSettings({
      customModelReasoningOptionIdsByEngineId: customReasoning
    });
    await service.updateSettings({
      serviceTierPreferencesByEngineId: serviceTierPreferences
    });
    await service.updateSettings({ lastExecutionByEngineId: lastExecution });
    configured.codex.push("mutated-after-write");
    customReasoning.codex["custom-model"].push("mutated-after-write");
    serviceTierPreferences.codex["gpt-5.5-codex"] = null;
    lastExecution.codex.modelId = "mutated-after-write";
    const firstRead = service.getState();
    firstRead.allowedModelIdsByEngineId.codex.push("mutated-after-read");
    firstRead.customModelReasoningOptionIdsByEngineId.codex["custom-model"].push(
      "mutated-after-read"
    );
    firstRead.serviceTierPreferencesByEngineId.codex["gpt-5.5-codex"] = null;
    firstRead.lastExecutionByEngineId.codex.modelId = "mutated-after-read";

    expect(service.getState()).toMatchObject({
      defaultNewSessionEngineId: "codex",
      engineProgramPathsByEngineId: {
        codex: "C:\\tools\\codex.exe"
      },
      allowedModelIdsByEngineId: {
        codex: ["gpt-5.5-codex"],
        "pi-acp": []
      },
      customModelReasoningOptionIdsByEngineId: {
        codex: {
          "custom-model": ["low", "high"]
        }
      },
      serviceTierPreferencesByEngineId: {
        codex: {
          "gpt-5.5-codex": "priority"
        }
      },
      lastExecutionByEngineId: {
        codex: {
          modelId: "gpt-5.5-codex",
          reasoningOptionId: "high",
          serviceTierId: "priority"
        }
      }
    });
  });

  it("serializes concurrent writes and flushes the latest registry state", async () => {
    const baseDir = await createTempDir();
    let releaseFirstSave: (() => void) | undefined;
    let markFirstSaveStarted: (() => void) | undefined;
    const firstSaveStarted = new Promise<void>((resolve) => {
      markFirstSaveStarted = resolve;
    });
    const firstSaveBlocked = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const snapshots: unknown[] = [];
    const saveDocument = vi.fn(async (_filePath: string, value: unknown) => {
      snapshots.push(structuredClone(value));
      if (snapshots.length === 1) {
        markFirstSaveStarted?.();
        await firstSaveBlocked;
      }
    });
    const service = new WorkspaceRegistryService({
      baseDir,
      saveDocument
    });

    const settingsWrite = service.updateSettings({
      lastExecutionByEngineId: {
        codex: {
          modelId: "gpt-5.5-codex",
          serviceTierId: "priority"
        }
      }
    });
    await firstSaveStarted;
    const selectionWrite = service.setLastActiveSelection({
      workspaceId: "workspace-1",
      sessionId: "session-1"
    });

    expect(saveDocument).toHaveBeenCalledTimes(1);
    releaseFirstSave?.();
    await Promise.all([settingsWrite, selectionWrite]);

    expect(saveDocument).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)).toMatchObject({
      lastExecutionByEngineId: {
        codex: {
          modelId: "gpt-5.5-codex",
          serviceTierId: "priority"
        }
      },
      lastActiveWorkspaceId: "workspace-1",
      lastActiveSessionId: "session-1"
    });
  });

  it("defaults last execution settings for existing registry files", async () => {
    const baseDir = await createTempDir();
    await writeRegistry(baseDir, {
      version: 1,
      workspaces: [],
      expandedWorkspaceIds: [],
      expandedSessionIds: [],
      allowedModelIdsByEngineId: {},
      customModelReasoningOptionIdsByEngineId: {}
    });

    const service = new WorkspaceRegistryService({ baseDir });
    await service.ready();

    expect(service.getState().lastExecutionByEngineId).toEqual({});
    expect(service.getState().serviceTierPreferencesByEngineId).toEqual({});
  });

  it("migrates the existing last speed selection into model preferences once", async () => {
    const baseDir = await createTempDir();
    const registryPath = await writeRegistry(baseDir, {
      version: 1,
      workspaces: [],
      expandedWorkspaceIds: [],
      expandedSessionIds: [],
      pinnedSessionIds: [],
      engineProgramPathsByEngineId: {},
      allowedModelIdsByEngineId: {},
      customModelReasoningOptionIdsByEngineId: {},
      lastExecutionByEngineId: {
        codex: {
          modelId: "gpt-5.5-codex",
          serviceTierId: "priority"
        }
      }
    });

    const service = new WorkspaceRegistryService({ baseDir });
    await service.ready();

    expect(service.getState().serviceTierPreferencesByEngineId).toEqual({
      codex: {
        "gpt-5.5-codex": "priority"
      }
    });
    expect(
      (JSON.parse(await readFile(registryPath, "utf8")) as {
        serviceTierPreferencesByEngineId: unknown;
      }).serviceTierPreferencesByEngineId
    ).toEqual({
      codex: {
        "gpt-5.5-codex": "priority"
      }
    });
  });

  it("reuses existing workspace ids for duplicate paths and updates labels", async () => {
    const baseDir = await createTempDir();
    const service = new WorkspaceRegistryService({
      baseDir,
      createWorkspaceId: () => "workspace-fixed"
    });

    const first = await service.registerWorkspace({
      absolutePath: "D:/workspace/another-workbench"
    });
    const second = await service.registerWorkspace({
      absolutePath: "D:/workspace/another-workbench",
      label: "Workbench"
    });

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(service.listWorkspaces()).toHaveLength(1);
    expect(service.getWorkspace(first.workspaceId)?.label).toBe("Workbench");
  });

  it("treats windows extended-length paths as the same workspace identity", async () => {
    const baseDir = await createTempDir();
    const service = new WorkspaceRegistryService({
      baseDir,
      createWorkspaceId: (() => {
        let index = 0;
        return () => `workspace-${++index}`;
      })()
    });

    const first = await service.registerWorkspace({
      absolutePath: "D:/workspace"
    });
    const second = await service.registerWorkspace({
      absolutePath: "\\\\?\\D:\\workspace",
      label: "Workspace"
    });

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(service.listWorkspaces()).toHaveLength(1);
    expect(service.getWorkspace(first.workspaceId)).toMatchObject({
      absolutePath: "D:\\workspace",
      label: "Workspace"
    });
  });

  it("rejects invalid persisted data without replacing it", async () => {
    const baseDir = await createTempDir();
    const registryPath = join(baseDir, "workspace-registry.json");
    await mkdir(baseDir, { recursive: true });
    await writeFile(registryPath, "{not-valid-json", "utf8");

    const service = new WorkspaceRegistryService({
      baseDir
    });
    await expect(service.ready()).rejects.toThrow("Failed to read persistent store");

    expect(await readFile(registryPath, "utf8")).toBe("{not-valid-json");
  });
});
