import { describe, expect, it } from "vitest";
import { buildLocalImagePreviewSrc } from "../src/ui/chat-shell/local-image-preview.js";

describe("buildLocalImagePreviewSrc", () => {
  it("leaves non-file image sources unchanged", () => {
    expect(buildLocalImagePreviewSrc("data:image/png;base64,AAAA", "v1")).toBe(
      "data:image/png;base64,AAAA"
    );
    expect(buildLocalImagePreviewSrc("https://example.test/image.png", "v1")).toBe(
      "https://example.test/image.png"
    );
  });

  it("leaves malformed sources unchanged", () => {
    expect(buildLocalImagePreviewSrc("not a url", "v1")).toBe("not a url");
  });

  it("adds a cache token to local file URLs", () => {
    expect(buildLocalImagePreviewSrc("file:///I:/images/a.png", "v1")).toBe(
      "file:///I:/images/a.png?awb_image_cache=v1"
    );
  });

  it("preserves existing query parameters and hash fragments", () => {
    expect(
      buildLocalImagePreviewSrc("file:///I:/images/a.png?mtime=1#preview", "v2")
    ).toBe("file:///I:/images/a.png?mtime=1&awb_image_cache=v2#preview");
  });

  it("changes the preview URL when the caller supplies a new version", () => {
    const src = "file:///I:/images/a.png";

    expect(buildLocalImagePreviewSrc(src, "mtime-1")).not.toBe(
      buildLocalImagePreviewSrc(src, "mtime-2")
    );
  });
});
