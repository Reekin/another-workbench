import { readFile, stat } from "node:fs/promises";
import type { FilePreviewRpc } from "@another-workbench/shared";
import { createFileReferenceFromPath } from "@another-workbench/shared";

const textLikeExtensions = new Set([
  "txt",
  "md",
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "csv",
  "log",
  "env"
]);

const codeLikeExtensions = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "css",
  "scss",
  "html",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "sh",
  "ps1",
  "rb",
  "php",
  "sql"
]);

const imageExtensions = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico"
]);

const languageByExtension: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  sh: "bash",
  ps1: "powershell",
  html: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
  json: "json",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml"
};

const previewByteBudget = 64 * 1024;
const previewCharacterBudget = 8_000;

const decodeUtf8 = (buffer: Uint8Array): string =>
  new TextDecoder("utf-8").decode(buffer);

const hasBinarySignature = (buffer: Uint8Array): boolean =>
  buffer.indexOf(0) >= 0;

export type FilePreviewServiceOptions = {
  maxBytes?: number;
  maxCharacters?: number;
};

export class FilePreviewService {
  private readonly maxBytes: number;
  private readonly maxCharacters: number;

  public constructor(options: FilePreviewServiceOptions = {}) {
    this.maxBytes = options.maxBytes ?? previewByteBudget;
    this.maxCharacters = options.maxCharacters ?? previewCharacterBudget;
  }

  public async getPreview(path: string): Promise<FilePreviewRpc> {
    const target = createFileReferenceFromPath(path, "inline_path");

    let fileStats: Awaited<ReturnType<typeof stat>>;
    try {
      fileStats = await stat(path);
    } catch {
      return {
        kind: "missing",
        target,
        exists: false,
        reason: "This file is no longer available on disk."
      };
    }

    if (!fileStats.isFile()) {
      return {
        kind: "unsupported",
        target,
        exists: true,
        fileSizeBytes: fileStats.size,
        reason: "Only regular files can be previewed."
      };
    }

    const extension = target.extension?.toLowerCase();
    if (extension && imageExtensions.has(extension)) {
      return {
        kind: "image",
        target,
        exists: true,
        fileSizeBytes: fileStats.size,
        modifiedAtMs: fileStats.mtimeMs,
        mimeType: `image/${extension === "svg" ? "svg+xml" : extension}`,
        imageUrl: target.fileUrl
      };
    }

    if (fileStats.size > 5 * 1024 * 1024 && !textLikeExtensions.has(extension ?? "")) {
      return {
        kind: "unsupported",
        target,
        exists: true,
        fileSizeBytes: fileStats.size,
        reason: "This file is too large for inline preview."
      };
    }

    let contents: Uint8Array;
    try {
      contents = await readFile(path);
    } catch (error) {
      return {
        kind: "error",
        target,
        exists: true,
        reason:
          error instanceof Error ? error.message : "Failed to read the selected file."
      };
    }

    if (hasBinarySignature(contents)) {
      return {
        kind: "unsupported",
        target,
        exists: true,
        fileSizeBytes: fileStats.size,
        reason: "Binary files are not previewed inline."
      };
    }

    const truncatedBytes =
      contents.byteLength > this.maxBytes ? contents.subarray(0, this.maxBytes) : contents;
    const fullText = decodeUtf8(truncatedBytes);
    const truncated =
      contents.byteLength > this.maxBytes || fullText.length > this.maxCharacters;
    const text = truncated ? fullText.slice(0, this.maxCharacters) : fullText;
    const lineCount = text.length === 0 ? 0 : text.split(/\r?\n/).length;

    if (extension && codeLikeExtensions.has(extension)) {
      return {
        kind: "code",
        target,
        exists: true,
        fileSizeBytes: fileStats.size,
        text,
        truncated,
        lineCount,
        language: languageByExtension[extension]
      };
    }

    if (extension && textLikeExtensions.has(extension)) {
      return {
        kind: "text",
        target,
        exists: true,
        fileSizeBytes: fileStats.size,
        text,
        truncated,
        lineCount
      };
    }

    return {
      kind: "unsupported",
      target,
      exists: true,
      fileSizeBytes: fileStats.size,
      reason: "This file type opens externally."
    };
  }
}
