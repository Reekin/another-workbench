import { describe, expect, it, vi } from "vitest";
import { TurnChangeService } from "../src/turn-change-service.js";

describe("TurnChangeService", () => {
  it("canonicalizes absolute-path diffs before reverse apply", async () => {
    const runGitApply = vi
      .fn()
      .mockResolvedValueOnce({
        undone: true
      })
      .mockResolvedValueOnce({
        undone: true
      });
    const service = new TurnChangeService({
      runGitApply
    });

    await expect(
      service.undoTurnChanges({
        cwd: "I:\\gpt-projects\\agent-wrappers\\another-workbench",
        diff: `diff --git a/D:/workspace/another-workbench/apps/desktop/abc.txt b/D:/workspace/another-workbench/apps/desktop/abc.txt
--- a/D:/workspace/another-workbench/apps/desktop/abc.txt
+++ b/D:/workspace/another-workbench/apps/desktop/abc.txt
@@ -1 +1,3 @@
-
+第一行内容
+第二行内容
+第三行内容
`
      })
    ).resolves.toEqual({
      undone: true
    });

    expect(runGitApply).toHaveBeenNthCalledWith(1, {
      cwd: "I:\\gpt-projects\\agent-wrappers\\another-workbench",
      reverse: true,
      check: true,
      diff: `diff --git a/apps/desktop/abc.txt b/apps/desktop/abc.txt
--- a/apps/desktop/abc.txt
+++ b/apps/desktop/abc.txt
@@ -1 +1,3 @@
-
+第一行内容
+第二行内容
+第三行内容
`
    });
  });
});
