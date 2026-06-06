import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldDismissFloatingMenuForContextMenu } from "../src/ui/chat-shell/use-session-actions-controller.js";

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
});
