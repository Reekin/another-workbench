import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FilesDetailPanel } from "../src/ui/chat-shell/FilesDetailPanel.js";

describe("FilesDetailPanel", () => {
  it("keeps empty search and preview states visually quiet", () => {
    const html = renderToStaticMarkup(
      <FilesDetailPanel
        workspaceLabel="agent-wrappers"
        hasWorkspace
        query=""
        onQueryChange={() => undefined}
        isSearching={false}
        searchResults={[]}
        selectedFile={undefined}
        preview={undefined}
        isLoadingPreview={false}
        onSelectFile={() => undefined}
        onRunFileAction={() => undefined}
        onOpenImage={() => undefined}
      />
    );

    expect(html).toContain("Search Results");
    expect(html).not.toContain("Preview");
    expect(html).not.toContain("Enter a file name or path fragment");
    expect(html).not.toContain("Select a file");
    expect(html).not.toContain("Choose a file from search results");
  });

  it("still renders a real preview once a file is selected", () => {
    const html = renderToStaticMarkup(
      <FilesDetailPanel
        workspaceLabel="agent-wrappers"
        hasWorkspace
        query="chat"
        onQueryChange={() => undefined}
        isSearching={false}
        searchResults={[
          {
            path: "I:\\repo\\src\\chat.ts",
            relativePath: "src/chat.ts",
            fileName: "chat.ts"
          }
        ]}
        selectedFile={{
          path: "I:\\repo\\src\\chat.ts",
          relativePath: "src/chat.ts",
          displayPath: "I:\\repo\\src\\chat.ts",
          fileName: "chat.ts",
          source: "search"
        }}
        preview={{
          kind: "text",
          target: {
            path: "I:\\repo\\src\\chat.ts",
            relativePath: "src/chat.ts",
            displayPath: "I:\\repo\\src\\chat.ts",
            label: "chat.ts",
            fileName: "chat.ts"
          },
          text: "export const chat = true;",
          truncated: false
        }}
        isLoadingPreview={false}
        onSelectFile={() => undefined}
        onRunFileAction={() => undefined}
        onOpenImage={() => undefined}
      />
    );

    expect(html).toContain("chat.ts");
    expect(html).toContain("export const chat = true;");
  });

  it("cache-busts local image previews with modified time and size", () => {
    const renderImagePreview = (modifiedAtMs: number): string => renderToStaticMarkup(
      <FilesDetailPanel
        workspaceLabel="agent-wrappers"
        hasWorkspace
        query="diagram"
        onQueryChange={() => undefined}
        isSearching={false}
        searchResults={[]}
        selectedFile={{
          path: "I:\\repo\\assets\\diagram.png",
          displayPath: "I:\\repo\\assets\\diagram.png",
          fileUrl: "file:///I:/repo/assets/diagram.png",
          label: "diagram.png",
          fileName: "diagram.png",
          extension: "png",
          isImage: true,
          source: "markdown_image"
        }}
        preview={{
          kind: "image",
          target: {
            path: "I:\\repo\\assets\\diagram.png",
            displayPath: "I:\\repo\\assets\\diagram.png",
            fileUrl: "file:///I:/repo/assets/diagram.png",
            label: "diagram.png",
            fileName: "diagram.png",
            extension: "png",
            isImage: true,
            source: "markdown_image"
          },
          exists: true,
          fileSizeBytes: 1200,
          modifiedAtMs,
          mimeType: "image/png",
          imageUrl: "file:///I:/repo/assets/diagram.png"
        }}
        isLoadingPreview={false}
        onSelectFile={() => undefined}
        onRunFileAction={() => undefined}
        onOpenImage={() => undefined}
      />
    );
    const firstHtml = renderImagePreview(111);
    const secondHtml = renderImagePreview(222);

    expect(firstHtml).toContain("diagram.png");
    expect(firstHtml).toContain(
      'src="file:///I:/repo/assets/diagram.png?awb_image_cache=I%3A%5Crepo%5Cassets%5Cdiagram.png%3A111%3A1200"'
    );
    expect(secondHtml).toContain(
      'src="file:///I:/repo/assets/diagram.png?awb_image_cache=I%3A%5Crepo%5Cassets%5Cdiagram.png%3A222%3A1200"'
    );
    expect(firstHtml).not.toBe(secondHtml);
  });
});
