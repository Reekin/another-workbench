import { describe, expect, it } from "vitest";
import {
  resolveComposerExecutionSelection,
  resolveComposerModels,
  snapshotComposerExecution
} from "../src/ui/chat-shell/use-composer-controller.js";

const catalog = {
  engineId: "codex",
  models: [
    {
      modelId: "gpt-5.5-codex",
      displayName: "GPT-5.5 Codex",
      reasoningOptions: [
        { optionId: "xhigh", displayName: "Extra high" }
      ],
      isDefault: true
    },
    {
      modelId: "gpt-5.4-mini",
      displayName: "GPT-5.4 Mini",
      reasoningOptions: [],
      isDefault: false
    }
  ]
} as const;

describe("composer execution configuration", () => {
  it("uses every catalog model when the configured allowlist is missing or empty", () => {
    expect(resolveComposerModels({ catalog })).toHaveLength(2);
    expect(resolveComposerModels({ catalog, allowedModelIds: [] })).toHaveLength(2);
  });

  it("filters by exact configured IDs while preserving unavailable custom IDs", () => {
    expect(
      resolveComposerModels({
        catalog,
        allowedModelIds: ["gpt-5.4-mini", "future-provider-model"]
      })
    ).toEqual([
      expect.objectContaining({ modelId: "gpt-5.4-mini" }),
      {
        modelId: "future-provider-model",
        displayName: "future-provider-model",
        reasoningOptions: [],
        isDefault: false
      }
    ]);
  });

  it("uses configured provider-native reasoning options for added models", () => {
    expect(
      resolveComposerModels({
        catalog,
        allowedModelIds: ["provider/custom-model"],
        customModelReasoningOptionIds: {
          "provider/custom-model": ["low", "extra"]
        }
      })
    ).toEqual([
      {
        modelId: "provider/custom-model",
        displayName: "provider/custom-model",
        reasoningOptions: [
          { optionId: "low", displayName: "low" },
          { optionId: "extra", displayName: "extra" }
        ],
        isDefault: false
      }
    ]);
  });

  it("snapshots provider-native execution IDs for queued messages", () => {
    const selection = {
      modelId: "gpt-5.5-codex",
      reasoningOptionId: "xhigh"
    };
    const queuedSnapshot = snapshotComposerExecution(selection);

    expect(queuedSnapshot).toEqual(selection);
    expect(queuedSnapshot).not.toBe(selection);
  });

  it("restores the persisted model and provider-native reasoning option", () => {
    expect(
      resolveComposerExecutionSelection({
        models: [...catalog.models],
        persistedProfile: {
          engineId: "codex",
          modelId: "gpt-5.5-codex",
          reasoningOptionId: "xhigh"
        }
      })
    ).toEqual({
      modelId: "gpt-5.5-codex",
      reasoningOptionId: "xhigh"
    });
  });

  it("uses the engine's last execution for a new session without a model profile", () => {
    expect(
      resolveComposerExecutionSelection({
        models: [...catalog.models],
        persistedProfile: { engineId: "codex" },
        lastExecution: {
          modelId: "gpt-5.4-mini"
        }
      })
    ).toEqual({
      modelId: "gpt-5.4-mini",
      reasoningOptionId: undefined
    });
  });

  it("keeps an existing session profile ahead of the engine's last execution", () => {
    expect(
      resolveComposerExecutionSelection({
        models: [...catalog.models],
        persistedProfile: {
          engineId: "codex",
          modelId: "gpt-5.5-codex",
          reasoningOptionId: "xhigh"
        },
        lastExecution: {
          modelId: "gpt-5.4-mini"
        }
      })
    ).toEqual({
      modelId: "gpt-5.5-codex",
      reasoningOptionId: "xhigh"
    });
  });

  it("keeps the current unsent selection ahead of persisted and engine defaults", () => {
    expect(
      resolveComposerExecutionSelection({
        models: [...catalog.models],
        current: { modelId: "gpt-5.4-mini" },
        persistedProfile: {
          engineId: "codex",
          modelId: "gpt-5.5-codex",
          reasoningOptionId: "xhigh"
        },
        lastExecution: { modelId: "gpt-5.5-codex" }
      })
    ).toEqual({
      modelId: "gpt-5.4-mini",
      reasoningOptionId: undefined
    });
  });

  it("drops stale reasoning options while preserving the selected model", () => {
    expect(
      resolveComposerExecutionSelection({
        models: [...catalog.models],
        current: {
          modelId: "gpt-5.5-codex",
          reasoningOptionId: "extra"
        }
      })
    ).toEqual({
      modelId: "gpt-5.5-codex",
      reasoningOptionId: undefined
    });
  });
});
