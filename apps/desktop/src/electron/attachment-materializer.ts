import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";

export type MaterializeAttachmentInput = {
  attachmentId?: unknown;
  dataUri?: unknown;
  mimeType?: unknown;
  name?: unknown;
};

export type MaterializeAttachmentResult = {
  bytesWritten: number;
  displayUri: string;
  filePath: string;
};

const dataUriPattern = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/isu;

const extensionByMimeType = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"]
]);

const extensionFromMimeType = (mimeType: string): string =>
  extensionByMimeType.get(mimeType.toLowerCase()) ?? "img";

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizePathSegment = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  const leaf = value.replace(/\\/gu, "/").split("/").filter(Boolean).pop() ?? value;
  const withoutExtension = leaf.slice(0, Math.max(0, leaf.length - extname(leaf).length));
  const normalized = withoutExtension
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return normalized || undefined;
};

const parseBase64DataUri = (
  dataUri: string
): { bytes: Buffer; mimeType: string } => {
  const match = dataUriPattern.exec(dataUri);
  if (!match || !match[2]) {
    throw new Error("Attachment data URI must be base64 encoded.");
  }
  const mimeType = match[1]?.trim() || "application/octet-stream";
  if (!mimeType.toLowerCase().startsWith("image/")) {
    throw new Error(`Attachment data URI is not an image: ${mimeType}`);
  }
  const bytes = Buffer.from((match[3] ?? "").replace(/\s+/gu, ""), "base64");
  if (bytes.length === 0) {
    throw new Error("Attachment data URI is empty.");
  }
  return { bytes, mimeType };
};

export const materializeAttachmentDataUri = async (
  input: MaterializeAttachmentInput,
  rootDirectory: string
): Promise<MaterializeAttachmentResult> => {
  const dataUri = normalizeString(input.dataUri);
  if (!dataUri) {
    throw new Error("Attachment data URI is required.");
  }

  const parsed = parseBase64DataUri(dataUri);
  const declaredMimeType = normalizeString(input.mimeType);
  const mimeType = declaredMimeType?.toLowerCase().startsWith("image/")
    ? declaredMimeType
    : parsed.mimeType;
  const hash = createHash("sha256")
    .update(mimeType)
    .update(parsed.bytes)
    .digest("hex")
    .slice(0, 16);
  const stem =
    normalizePathSegment(normalizeString(input.name)) ??
    normalizePathSegment(normalizeString(input.attachmentId)) ??
    "attachment";
  const filePath = join(rootDirectory, `${stem}-${hash}.${extensionFromMimeType(mimeType)}`);

  await mkdir(rootDirectory, { recursive: true });
  await writeFile(filePath, parsed.bytes);

  return {
    bytesWritten: parsed.bytes.length,
    displayUri: pathToFileURL(filePath).toString(),
    filePath
  };
};
