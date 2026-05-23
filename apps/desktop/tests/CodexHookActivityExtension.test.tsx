import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CodexHookActivityExtension } from "../src/features/engine-extensions/codex/CodexHookActivityExtension.js";

describe("CodexHookActivityExtension", () => {
  it("renders hook run status, source, and typed output entries", () => {
    const markup = renderToStaticMarkup(
      <CodexHookActivityExtension
        runs={[
          {
            id: "hook-run-1",
            eventName: "preToolUse",
            handlerType: "command",
            executionMode: "sync",
            scope: "turn",
            sourcePath: "D:/workspace/.codex/hooks.json",
            source: "project",
            displayOrder: 1,
            status: "completed",
            statusMessage: null,
            startedAt: 1700000000000,
            completedAt: 1700000000025,
            durationMs: 25,
            entries: [
              {
                kind: "warning",
                text: "checked command policy"
              },
              {
                kind: "context",
                text: "workspace hook context"
              }
            ]
          }
        ]}
      />
    );

    expect(markup).toContain("Hook activity");
    expect(markup).toContain("preToolUse · command");
    expect(markup).toContain("completed · 25ms");
    expect(markup).toContain("sync · turn · project");
    expect(markup).toContain("hooks.json");
    expect(markup).toContain("warning: checked command policy");
    expect(markup).toContain("context: workspace hook context");
  });
});
