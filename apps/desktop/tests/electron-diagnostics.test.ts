import { describe, expect, it } from "vitest";
import {
  isBlankRendererHealth,
  shouldReloadForChildProcessGone,
  shouldReloadForLoadFailure,
  shouldReloadForRenderProcessGone
} from "../src/electron/electron-diagnostics.js";

describe("Electron diagnostics", () => {
  it("detects a completed renderer document with an empty root as blank", () => {
    expect(
      isBlankRendererHealth({
        rootExists: true,
        rootChildCount: 0,
        rootTextLength: 0,
        bodyTextLength: 0,
        readyState: "complete",
        href: "file:///app/index.html"
      })
    ).toBe(true);
    expect(
      isBlankRendererHealth({
        rootExists: true,
        rootChildCount: 1,
        rootTextLength: 12,
        bodyTextLength: 12,
        readyState: "complete",
        href: "file:///app/index.html"
      })
    ).toBe(false);
  });

  it("reloads for renderer crashes but not clean exits", () => {
    expect(shouldReloadForRenderProcessGone({ reason: "crashed", exitCode: 1 })).toBe(
      true
    );
    expect(shouldReloadForRenderProcessGone({ reason: "clean-exit", exitCode: 0 })).toBe(
      false
    );
  });

  it("reloads only main-frame load failures and ignores aborted loads", () => {
    expect(shouldReloadForLoadFailure({ errorCode: -105, isMainFrame: true })).toBe(
      true
    );
    expect(shouldReloadForLoadFailure({ errorCode: -105, isMainFrame: false })).toBe(
      false
    );
    expect(shouldReloadForLoadFailure({ errorCode: -3, isMainFrame: true })).toBe(
      false
    );
  });

  it("reloads windows after GPU child-process loss", () => {
    expect(shouldReloadForChildProcessGone({ type: "GPU", reason: "crashed" })).toBe(
      true
    );
    expect(shouldReloadForChildProcessGone({ type: "Utility", reason: "crashed" })).toBe(
      false
    );
    expect(shouldReloadForChildProcessGone({ type: "GPU", reason: "clean-exit" })).toBe(
      false
    );
  });
});
