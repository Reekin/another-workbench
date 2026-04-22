import { describe, expect, it } from "vitest";
import { mergeFileChangeDiffs, normalizeFileChangeDiff } from "../src/file-change-diff.js";

describe("file change diff normalization", () => {
  it("wraps hunk-only updates into a standard unified diff", () => {
    expect(
      normalizeFileChangeDiff({
        path: "apps/desktop/abc.txt",
        kind: {
          type: "update",
          move_path: null
        },
        diff: `@@ -1 +1,3 @@
-
+第一行内容
+第二行内容
+第三行内容
`
      })
    ).toBe(`diff --git a/apps/desktop/abc.txt b/apps/desktop/abc.txt
--- a/apps/desktop/abc.txt
+++ b/apps/desktop/abc.txt
@@ -1 +1,3 @@
-
+第一行内容
+第二行内容
+第三行内容`);
  });

  it("wraps added files with /dev/null as the old side", () => {
    expect(
      normalizeFileChangeDiff({
        path: "apps/desktop/abc.txt",
        kind: {
          type: "add"
        },
        diff: `@@ -0,0 +1 @@
+
`
      })
    ).toBe(`diff --git a/apps/desktop/abc.txt b/apps/desktop/abc.txt
--- /dev/null
+++ b/apps/desktop/abc.txt
@@ -0,0 +1 @@
+`);
  });

  it("preserves an already complete diff and merges multiple changes", () => {
    expect(
      mergeFileChangeDiffs([
        {
          path: "src/foo.ts",
          kind: {
            type: "update",
            move_path: null
          },
          diff: `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new`
        },
        {
          path: "src/bar.ts",
          kind: {
            type: "delete"
          },
          diff: `@@ -1 +0,0 @@
-gone`
        }
      ])
    ).toBe(`diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone`);
  });
});
