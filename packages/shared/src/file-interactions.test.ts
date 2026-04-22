import { describe, expect, it } from "vitest";
import { extractFileReferencesFromText } from "./file-interactions.js";

describe("file interactions", () => {
  it("extracts markdown links, markdown images, and inline absolute paths", () => {
    const references = extractFileReferencesFromText(`
      Please review [Spec](file:///C:/repo/docs/spec.md)
      and ![Diagram](file:///C:/repo/assets/diagram.png).
      Notes live in \`C:\\repo\\notes\\todo.txt\`.
    `);

    expect(references).toEqual([
      expect.objectContaining({
        path: "C:\\repo\\assets\\diagram.png",
        label: "Diagram",
        fileName: "diagram.png",
        extension: "png",
        isImage: true,
        source: "markdown_image"
      }),
      expect.objectContaining({
        path: "C:\\repo\\docs\\spec.md",
        label: "Spec",
        fileName: "spec.md",
        extension: "md",
        isImage: false,
        source: "markdown_link"
      }),
      expect.objectContaining({
        path: "C:\\repo\\notes\\todo.txt",
        label: "todo.txt",
        fileName: "todo.txt",
        extension: "txt",
        isImage: false,
        source: "inline_path"
      })
    ]);
  });

  it("deduplicates the same file when it appears in both markdown and backtick path forms", () => {
    const references = extractFileReferencesFromText(`
      Open [Readme](file:///C:/repo/docs/README.md)
      and compare with \`C:\\repo\\docs\\README.md\`
    `);

    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      path: "C:\\repo\\docs\\README.md",
      label: "Readme",
      fileName: "README.md",
      source: "markdown_link"
    });
  });

  it("extracts markdown links that target absolute Windows paths and trims trailing punctuation from inline matches", () => {
    const references = extractFileReferencesFromText(`
      See [Block](I:\\repo\\src\\MarkdownPdfBlock.tsx)
      and also I:\\repo\\src\\MarkdownPdfBlock.tsx).
    `);

    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      path: "I:\\repo\\src\\MarkdownPdfBlock.tsx",
      label: "Block",
      fileName: "MarkdownPdfBlock.tsx",
      source: "markdown_link"
    });
  });
});
