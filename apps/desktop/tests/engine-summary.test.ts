import { describe, expect, it } from "vitest";
import { buildEngineInspectorViewModel } from "../src/ui/chat-shell/engine-summary.js";

describe("buildEngineInspectorViewModel", () => {
  it("summarizes integration tier, capabilities, and extensions for the selected engine", () => {
    expect(
      buildEngineInspectorViewModel({
        selectedEngineId: "codex",
        engines: [
          {
            engineId: "codex",
            displayName: "Codex",
            integrationTier: "native"
          }
        ],
        surfacesByEngineId: {
          codex: {
            engineId: "codex",
            sharedCapabilities: ["chat", "terminal"],
            extensions: [
              {
                engineId: "codex",
                key: "worktree",
                displayName: "Worktree Inspector",
                available: true
              }
            ]
          }
        }
      })
    ).toEqual({
      engineLabel: "Codex",
      integrationLabel: "Integration: native",
      capabilitiesLabel: "Capabilities: chat, terminal",
      extensionsLabel: "Extensions: Worktree Inspector"
    });
  });
});
