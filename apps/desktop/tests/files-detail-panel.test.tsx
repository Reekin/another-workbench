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
    expect(html).toContain("Preview");
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
});
