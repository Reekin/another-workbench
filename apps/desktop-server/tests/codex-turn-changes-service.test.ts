import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexTurnChangesService } from "../src/engine-extensions/codex/turn-changes-service.js";
import {
  clearCodexTurnChangesStore,
  recordCodexTurnChanges
} from "../src/engine-extensions/codex/turn-changes-store.js";

describe("CodexTurnChangesService", () => {
  afterEach(() => {
    clearCodexTurnChangesStore();
  });

  it("hydrates absolute file references for a recorded Codex turn", async () => {
    recordCodexTurnChanges({
      sessionId: "session-1",
      turnId: "turn-1",
      changes: [
        {
          path: "src/foo.ts",
          changeKind: "update",
          diff: `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new`
        }
      ],
      mergedDiff: `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new`
    });

    const service = new CodexTurnChangesService({
      resolveSessionAgentId: () => "codex",
      resolveWorkingDirectory: vi.fn().mockResolvedValue("I:\\repo"),
      undoTurnChanges: vi.fn()
    });

    await expect(
      service.getTurnChanges({
        sessionId: "session-1",
        turnId: "turn-1"
      })
    ).resolves.toEqual({
      engineId: "codex",
      sessionId: "session-1",
      turnId: "turn-1",
      changedFiles: [
        expect.objectContaining({
          path: "I:\\repo\\src\\foo.ts",
          displayPath: "I:\\repo\\src\\foo.ts",
          label: "foo.ts",
          fileName: "foo.ts",
          extension: "ts",
          changeKind: "update"
        })
      ],
      canUndo: true
    });
  });

  it("runs undo against the resolved workspace root using the recorded merged diff", async () => {
    const undoTurnChanges = vi.fn().mockResolvedValue({
      undone: true
    });

    recordCodexTurnChanges({
      sessionId: "session-1",
      turnId: "turn-1",
      changes: [
        {
          path: "src/foo.ts",
          changeKind: "update",
          diff: `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new`
        }
      ],
      mergedDiff: `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new`
    });

    const service = new CodexTurnChangesService({
      resolveSessionAgentId: () => "codex",
      resolveWorkingDirectory: vi.fn().mockResolvedValue("I:\\repo"),
      undoTurnChanges
    });

    await expect(
      service.undoTurnChanges({
        sessionId: "session-1",
        turnId: "turn-1"
      })
    ).resolves.toEqual({
      engineId: "codex",
      sessionId: "session-1",
      turnId: "turn-1",
      undone: true,
      displayPath: "I:\\repo",
      errorMessage: undefined
    });
    expect(undoTurnChanges).toHaveBeenCalledWith({
      cwd: "I:\\repo",
      diff: `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new`
    });
  });
});
