import type { WorkspaceRegistryService } from "./workspace-registry.js";

export type WorkspaceSelectionServiceOptions = {
  workspaceRegistry?: WorkspaceRegistryService;
};

export class WorkspaceSelectionService {
  private readonly workspaceRegistry?: WorkspaceRegistryService;

  public constructor(options: WorkspaceSelectionServiceOptions = {}) {
    this.workspaceRegistry = options.workspaceRegistry;
  }

  public async selectWorkspace(workspaceId: string): Promise<{
    workspaceId: string;
    activeSessionId?: string;
  }> {
    const registry = this.workspaceRegistry;
    if (!registry) {
      return {
        workspaceId
      };
    }

    await registry.ready();
    const state = registry.getState();
    const activeSessionId =
      state.lastActiveWorkspaceId === workspaceId ? state.lastActiveSessionId : undefined;
    await registry.setLastActiveSelection({
      workspaceId,
      sessionId: activeSessionId
    });
    return {
      workspaceId,
      activeSessionId
    };
  }

  public async activateSelection(input: {
    workspaceId?: string;
    sessionId?: string;
  }): Promise<void> {
    if (!this.workspaceRegistry) {
      return;
    }
    await this.workspaceRegistry.setLastActiveSelection(input);
  }
}
