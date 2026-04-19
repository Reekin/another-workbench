import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceRegistryService } from "../src/workspace-registry.js";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-workspace-registry-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await import("node:fs/promises").then(({ rm }) =>
        rm(dir, { recursive: true, force: true })
      );
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
    await service.setLastActiveSelection({
      workspaceId: beta.workspaceId,
      sessionId: "session-42"
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
      lastActiveWorkspaceId: beta.workspaceId,
      lastActiveSessionId: "session-42"
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

  it("recovers from invalid persisted data by resetting to an empty registry", async () => {
    const baseDir = await createTempDir();
    const registryPath = join(baseDir, "workspace-registry.json");
    await import("node:fs/promises").then(({ mkdir, writeFile }) =>
      mkdir(baseDir, { recursive: true }).then(() =>
        writeFile(registryPath, "{not-valid-json", "utf8")
      )
    );

    const service = new WorkspaceRegistryService({
      baseDir
    });
    await service.ready();

    expect(service.listWorkspaces()).toEqual([]);
    const repaired = JSON.parse(await readFile(registryPath, "utf8")) as {
      version: number;
      workspaces: unknown[];
    };
    expect(repaired.version).toBe(1);
    expect(repaired.workspaces).toEqual([]);
  });
});
