import { filePathToFileUri, isImageMimeType } from "./attachments.js";
import { normalizePathForIdentity, toDisplayPath } from "./paths.js";

const markdownImagePattern = /!\[([^\]]*)\]\(([^)\s]+)\)/gu;
const markdownLinkPattern = /(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/gu;
const inlineWindowsPathPattern = /[A-Za-z]:\\[^\s<>"'`|]+/gu;
const backtickPattern = /`([^`\r\n]+)`/gu;
const windowsDrivePathPattern = /^[A-Za-z]:[\\/]/u;
const uncPathPattern = /^\\\\[^\\]/u;
const posixAbsolutePathPattern = /^\/[^\0]+/u;

export type FileReferenceSource =
  | "markdown_link"
  | "markdown_image"
  | "inline_path";

export type ExtractedFileReference = {
  path: string;
  displayPath: string;
  fileUrl: string;
  label: string;
  fileName: string;
  extension?: string;
  isImage: boolean;
  source: FileReferenceSource;
};

const trailingInlinePathPunctuation = /[).,;]+$/u;

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

const trimTrailingInlinePathPunctuation = (value: string): string => {
  let current = value.trim();
  for (;;) {
    const next = current.replace(trailingInlinePathPunctuation, "");
    if (next === current) {
      return current;
    }
    current = next;
  }
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

export const fileTargetToPath = (target: string): string | undefined => {
  const trimmedTarget = target.trim();
  const fileUriPath = fileUriToPath(trimmedTarget);
  if (fileUriPath) {
    return fileUriPath;
  }

  const pathCandidate = trimTrailingInlinePathPunctuation(trimmedTarget);
  if (isAbsoluteFilePath(pathCandidate)) {
    return pathCandidate;
  }

  return undefined;
};

export const createFileReferenceFromPath = (
  path: string,
  source: FileReferenceSource,
  label?: string
): ExtractedFileReference => {
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

const pushUniqueReference = (
  references: ExtractedFileReference[],
  seen: Set<string>,
  reference: ExtractedFileReference
): void => {
  const identity = normalizePathForIdentity(reference.path);
  if (seen.has(identity)) {
    return;
  }
  seen.add(identity);
  references.push(reference);
};

const extractFileUriReferences = (
  text: string,
  pattern: RegExp,
  source: FileReferenceSource,
  references: ExtractedFileReference[],
  seen: Set<string>
): void => {
  for (const match of text.matchAll(pattern)) {
    const label = match[1]?.trim();
    const target = match[2]?.trim();
    if (!target) {
      continue;
    }
    const path = fileTargetToPath(target);
    if (!path) {
      continue;
    }
    pushUniqueReference(
      references,
      seen,
      createFileReferenceFromPath(path, source, label)
    );
  }
};

const extractInlineWindowsPaths = (
  text: string,
  references: ExtractedFileReference[],
  seen: Set<string>
): void => {
  for (const match of text.matchAll(inlineWindowsPathPattern)) {
    const candidate = trimTrailingInlinePathPunctuation(match[0] ?? "");
    if (!candidate || !isAbsoluteFilePath(candidate)) {
      continue;
    }
    pushUniqueReference(
      references,
      seen,
      createFileReferenceFromPath(candidate, "inline_path")
    );
  }
};

const extractBacktickPaths = (
  text: string,
  references: ExtractedFileReference[],
  seen: Set<string>
): void => {
  for (const match of text.matchAll(backtickPattern)) {
    const candidate = trimTrailingInlinePathPunctuation(match[1] ?? "");
    if (!candidate || !isAbsoluteFilePath(candidate)) {
      continue;
    }
    pushUniqueReference(
      references,
      seen,
      createFileReferenceFromPath(candidate, "inline_path")
    );
  }
};

export const extractFileReferencesFromText = (
  text: string | undefined
): ExtractedFileReference[] => {
  if (!text?.trim()) {
    return [];
  }

  const references: ExtractedFileReference[] = [];
  const seen = new Set<string>();

  extractFileUriReferences(
    text,
    markdownImagePattern,
    "markdown_image",
    references,
    seen
  );
  extractFileUriReferences(
    text,
    markdownLinkPattern,
    "markdown_link",
    references,
    seen
  );
  extractBacktickPaths(text, references, seen);
  extractInlineWindowsPaths(text, references, seen);

  return references;
};
