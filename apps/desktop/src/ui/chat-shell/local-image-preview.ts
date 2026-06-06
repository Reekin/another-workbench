const localFileImageProtocols = new Set(["file:"]);

export const buildLocalImagePreviewSrc = (
  src: string | undefined,
  cacheKey: string
): string | undefined => {
  if (!src) {
    return src;
  }

  try {
    const url = new URL(src);
    if (!localFileImageProtocols.has(url.protocol)) {
      return src;
    }
    url.searchParams.set("awb_image_cache", cacheKey);
    return url.toString();
  } catch {
    return src;
  }
};
