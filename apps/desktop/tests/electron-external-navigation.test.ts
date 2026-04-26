import { describe, expect, it } from "vitest";
import {
  resolveWillNavigate,
  resolveWindowOpenNavigation
} from "../src/electron/external-navigation.js";

describe("Electron external navigation", () => {
  it("opens web popups in the external browser instead of an Electron child window", () => {
    expect(resolveWindowOpenNavigation("https://example.com/docs")).toEqual({
      action: "deny",
      externalUrl: "https://example.com/docs"
    });
  });

  it("keeps same-origin dev-server navigation inside the renderer", () => {
    expect(
      resolveWillNavigate(
        "http://127.0.0.1:4173/demo.html",
        "http://127.0.0.1:4173/"
      )
    ).toEqual({
      action: "allow"
    });
  });

  it("redirects external top-level navigation to the system browser", () => {
    expect(
      resolveWillNavigate(
        "https://example.com/docs",
        "http://127.0.0.1:4173/"
      )
    ).toEqual({
      action: "deny",
      externalUrl: "https://example.com/docs"
    });
  });
});
