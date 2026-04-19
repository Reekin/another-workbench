import {
  filePathToFileUri,
  isImageMimeType,
  type Attachment
} from "@another-workbench/shared";

export type ComposerAttachmentOrigin = "picker" | "drop" | "paste";

export type ComposerAttachment = {
  attachment: Attachment;
  dedupeKey: string;
  displayName: string;
  isImage: boolean;
  mimeType: string;
  previewUrl?: string;
  releasePreviewUrl: boolean;
  size: number;
  sizeLabel: string;
};

export type MergeComposerAttachmentsResult = {
  attachments: ComposerAttachment[];
  skipped: ComposerAttachment[];
};

const fallbackMimeType = "application/octet-stream";
const imageMimeTypePattern = /^image\//iu;

const createAttachmentId = (): string =>
  `attachment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

const blobToDataUri = async (blob: Blob, mimeType: string): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${mimeType};base64,${encodeBase64(bytes)}`;
};

const resolveFileExtension = (mimeType: string): string => {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "application/pdf":
      return "pdf";
    case "application/json":
      return "json";
    case "text/plain":
      return "txt";
    default:
      return imageMimeTypePattern.test(mimeType) ? "png" : "bin";
  }
};

const buildFallbackName = (
  mimeType: string,
  origin: ComposerAttachmentOrigin
): string => {
  const prefix = origin === "paste" ? "pasted-image" : "attachment";
  return `${prefix}.${resolveFileExtension(mimeType)}`;
};

const normalizeFile = (
  file: File,
  origin: ComposerAttachmentOrigin
): File => {
  if (file.name.trim()) {
    return file;
  }
  return new File([file], buildFallbackName(file.type || fallbackMimeType, origin), {
    type: file.type,
    lastModified: Date.now()
  });
};

const resolveNativeFilePath = (file: File): string | undefined => {
  const candidate = (file as File & { path?: unknown }).path;
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
};

export const formatComposerAttachmentSize = (size: number): string => {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

export const createComposerAttachment = async (
  file: File,
  origin: ComposerAttachmentOrigin
): Promise<ComposerAttachment> => {
  const normalized = normalizeFile(file, origin);
  const mimeType = normalized.type || fallbackMimeType;
  const isImage = isImageMimeType(mimeType);
  const nativeFilePath = origin !== "paste" ? resolveNativeFilePath(normalized) : undefined;
  const uri = nativeFilePath
    ? filePathToFileUri(nativeFilePath)
    : await blobToDataUri(normalized, mimeType);
  const previewUrl = isImage
    ? nativeFilePath
      ? URL.createObjectURL(normalized)
      : uri
    : undefined;

  return {
    attachment: {
      attachmentId: createAttachmentId(),
      mimeType,
      uri,
      name: normalized.name
    },
    dedupeKey: nativeFilePath || `${normalized.name}:${mimeType}:${normalized.size}:${uri}`,
    displayName: normalized.name,
    isImage,
    mimeType,
    previewUrl,
    releasePreviewUrl: Boolean(previewUrl && nativeFilePath),
    size: normalized.size,
    sizeLabel: formatComposerAttachmentSize(normalized.size)
  };
};

export const createComposerAttachments = async (
  files: Iterable<File>,
  origin: ComposerAttachmentOrigin
): Promise<ComposerAttachment[]> =>
  Promise.all(
    [...files]
      .filter((file) => file.size > 0 || file.type.trim().length > 0 || file.name.trim())
      .map((file) => createComposerAttachment(file, origin))
  );

export const mergeComposerAttachments = (
  existing: ComposerAttachment[],
  incoming: ComposerAttachment[]
): MergeComposerAttachmentsResult => {
  const attachments = [...existing];
  const skipped: ComposerAttachment[] = [];
  const seen = new Set(existing.map((attachment) => attachment.dedupeKey));

  for (const attachment of incoming) {
    if (seen.has(attachment.dedupeKey)) {
      skipped.push(attachment);
      continue;
    }
    seen.add(attachment.dedupeKey);
    attachments.push(attachment);
  }

  return {
    attachments,
    skipped
  };
};

export const releaseComposerAttachments = (
  attachments: Iterable<ComposerAttachment>
): void => {
  for (const attachment of attachments) {
    if (attachment.releasePreviewUrl && attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }
};
