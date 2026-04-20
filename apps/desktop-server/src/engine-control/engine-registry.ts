import type { EngineDefinitionRpc } from "@another-workbench/shared";
import type { EngineDefinition } from "./engine-definition.js";

type EngineRegistryServiceOptions = {
  engines?: EngineDefinition[];
};

export class EngineRegistryService {
  private readonly enginesById = new Map<string, EngineDefinition>();

  public constructor(options: EngineRegistryServiceOptions = {}) {
    for (const engine of options.engines ?? []) {
      this.register(engine);
    }
  }

  public register(engine: EngineDefinition): void {
    this.enginesById.set(engine.engineId, { ...engine });
  }

  public list(): EngineDefinitionRpc[] {
    return [...this.enginesById.values()].map((engine) => ({ ...engine }));
  }

  public get(engineId: string): EngineDefinitionRpc | undefined {
    const engine = this.enginesById.get(engineId);
    return engine ? { ...engine } : undefined;
  }
}
