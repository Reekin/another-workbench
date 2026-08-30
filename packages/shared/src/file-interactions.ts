import { filePathToFileUri, isImageMimeType } from "./attachments.js";
import { toDisplayPath } from "./paths.js";

const windowsDrivePathPattern = /^[A-Za-z]:[\\/]/u;
const uncPathPattern = /^\\\\[^\\]/u;
const posixAbsolutePathPattern = /^\/[^\0]+/u;

export type FileReference = {
  path: string;
  displayPath: string;
  fileUrl: string;
  label: string;
  fileName: string;
  extension?: string;
  isImage: boolean;
  source: "inline_path";
};

const basenameFromPath = (value: string): string => {
  const normalized = value.replace(/\\/gu, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.at(-1) ?? value;
};

const extensionFromPath = (value: string): string | undefined => {
  const basename = basenameFromPath(value);
  const lastDotIndex = basename.lastIndexOf(".");
  if (lastDotIndex <= 0 || lastDotIndex === basename.length - 1) {
    return undefined;
  }
  return basename.slice(lastDotIndex + 1).toLowerCase();
};

const inferMimeTypeFromExtension = (extension: string | undefined): string | undefined => {
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    default:
      return undefined;
  }
};

export const isAbsoluteFilePath = (value: string): boolean => {
  const candidate = value.trim();
  return (
    windowsDrivePathPattern.test(candidate) ||
    uncPathPattern.test(candidate) ||
    posixAbsolutePathPattern.test(candidate)
  );
};

export const fileUriToPath = (uri: string): string | undefined => {
  if (!uri.toLowerCase().startsWith("file:")) {
    return undefined;
  }
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:") {
      return undefined;
    }
    const pathname = decodeURIComponent(parsed.pathname ?? "");
    if (parsed.host && parsed.host !== "localhost") {
      return `\\\\${decodeURIComponent(parsed.host)}${pathname.replace(/\//g, "\\")}`;
    }
    if (/^\/[a-z]:/i.test(pathname)) {
      return pathname.slice(1).replace(/\//g, "\\");
    }
    return pathname;
  } catch {
    return undefined;
  }
};

export const createFileReferenceFromPath = (
  path: string,
  source: "inline_path",
  label?: string
): FileReference => {
  const displayPath = toDisplayPath(path);
  const fileName = basenameFromPath(displayPath);
  const extension = extensionFromPath(displayPath);
  return {
    path: displayPath,
    displayPath,
    fileUrl: filePathToFileUri(displayPath),
    label: label?.trim() || fileName,
    fileName,
    extension,
    isImage: isImageMimeType(inferMimeTypeFromExtension(extension)),
    source
  };
};
