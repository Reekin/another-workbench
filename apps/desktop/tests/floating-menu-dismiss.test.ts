import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatSessionCopyStatusNotice,
  shouldDismissFloatingMenuForContextMenu
} from "../src/ui/chat-shell/use-session-actions-controller.js";
import { writeClipboardText } from "../src/ui/chat-shell/clipboard.js";

class FakeElement {
  public constructor(private readonly isInsideMenu: boolean) {}

  public closest(selector: string): FakeElement | null {
    if (selector !== ".awb-session-menu" || !this.isInsideMenu) {
      return null;
    }
    return this;
  }
}

describe("floating context menu dismissal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the menu open when right-clicking inside a floating menu", () => {
    vi.stubGlobal("Element", FakeElement);

    expect(
      shouldDismissFloatingMenuForContextMenu({
        target: new FakeElement(true)
      } as unknown as MouseEvent)
    ).toBe(false);
  });

  it("dismisses the menu when right-clicking outside a floating menu", () => {
    vi.stubGlobal("Element", FakeElement);

    expect(
      shouldDismissFloatingMenuForContextMenu({
        target: new FakeElement(false)
      } as unknown as MouseEvent)
    ).toBe(true);
  });

  it("labels session copy status notices by identifier type", () => {
    expect(formatSessionCopyStatusNotice("copy_session_id", "thread-1")).toBe(
      "Copied session id thread-1"
    );
    expect(
      formatSessionCopyStatusNotice("copy_awb_session_id", "session-1")
    ).toBe("Copied AWB session id session-1");
  });

  it("uses the focus-independent desktop clipboard when available", async () => {
    const desktop = vi.fn(async () => {});
    const browser = vi.fn(async () => {});
    vi.stubGlobal("window", {
      workbenchDesktop: {
        writeClipboardText: desktop
      }
    });
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: browser
      }
    });

    await writeClipboardText("thread-1");

    expect(desktop).toHaveBeenCalledWith("thread-1");
    expect(browser).not.toHaveBeenCalled();
  });

  it("falls back to the browser clipboard outside the desktop host", async () => {
    const browser = vi.fn(async () => {});
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: browser
      }
    });

    await writeClipboardText("thread-1");

    expect(browser).toHaveBeenCalledWith("thread-1");
  });
});
