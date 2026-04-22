import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, summarizeUnifiedDiff } from "./unified-diff.js";

describe("summarizeUnifiedDiff", () => {
  it("extracts file counts and line stats from unified diffs", () => {
    const summary = summarizeUnifiedDiff(`diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
 const answer = 41;
+const next = 42;
 export { answer };
diff --git a/docs/readme.md b/docs/readme.md
index 3333333..4444444 100644
--- a/docs/readme.md
+++ b/docs/readme.md
@@ -1,2 +1,2 @@
-hello
+hello world
 second line
`);

    expect(summary.fileCount).toBe(2);
    expect(summary.linesAdded).toBe(2);
    expect(summary.linesDeleted).toBe(1);
    expect(summary.files.map((file) => file.displayPath)).toEqual([
      "src/foo.ts",
      "docs/readme.md"
    ]);
    expect(summary.files[0]).toMatchObject({
      linesAdded: 1,
      linesDeleted: 0
    });
    expect(summary.files[1]).toMatchObject({
      linesAdded: 1,
      linesDeleted: 1
    });
  });

  it("does not treat the final trailing newline as an extra context line", () => {
    const files = parseUnifiedDiff(`diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new
`);

    expect(files).toHaveLength(1);
    expect(files[0]?.hunks[0]?.lines.map((line) => line.text)).toEqual(["-old", "+new"]);
  });
});
