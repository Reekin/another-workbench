import {
  filePathToFileUri,
  isImageMimeType,
  type Attachment
} from "@another-workbench/shared";
import { buildLocalImagePreviewSrc } from "./local-image-preview.js";

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
  replaced: ComposerAttachment[];
  skipped: ComposerAttachment[];
};

export type AttachmentDisplayMaterializer = (input: {
  attachmentId: string;
  dataUri: string;
  mimeType: string;
  name?: string;
}) => Promise<{ displayUri: string }>;

export type CreateComposerAttachmentOptions = {
  materializeDataUri?: AttachmentDisplayMaterializer;
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

const buildVersionedFileUri = (
  nativeFilePath: string,
  file: File
): string => {
  const fileUri = filePathToFileUri(nativeFilePath);
  const url = new URL(fileUri);
  url.searchParams.set("awb_file_mtime", String(file.lastModified));
  url.searchParams.set("awb_file_size", String(file.size));
  return url.toString();
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

const resolveDefaultMaterializer = (): AttachmentDisplayMaterializer | undefined =>
  typeof window === "undefined"
    ? undefined
    : window.workbenchLocalAssets?.materializeAttachmentDataUri;

const tryMaterializeDisplayUri = async (
  input: Parameters<AttachmentDisplayMaterializer>[0],
  options: CreateComposerAttachmentOptions
): Promise<string | undefined> => {
  const materializer = options.materializeDataUri ?? resolveDefaultMaterializer();
  if (!materializer) {
    return undefined;
  }
  try {
    const result = await materializer(input);
    return result.displayUri.trim() || undefined;
  } catch {
    return undefined;
  }
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
  origin: ComposerAttachmentOrigin,
  options: CreateComposerAttachmentOptions = {}
): Promise<ComposerAttachment> => {
  const normalized = normalizeFile(file, origin);
  const mimeType = normalized.type || fallbackMimeType;
  const isImage = isImageMimeType(mimeType);
  const attachmentId = createAttachmentId();
  const nativeFilePath = origin !== "paste" ? resolveNativeFilePath(normalized) : undefined;
  const uri = nativeFilePath
    ? isImage
      ? buildVersionedFileUri(nativeFilePath, normalized)
      : filePathToFileUri(nativeFilePath)
    : await blobToDataUri(normalized, mimeType);
  const displayUri =
    isImage && !nativeFilePath
      ? await tryMaterializeDisplayUri(
          {
            attachmentId,
            dataUri: uri,
            mimeType,
            name: normalized.name
          },
          options
        )
      : undefined;
  const previewUrl = isImage
    ? nativeFilePath
      ? (buildLocalImagePreviewSrc(
          uri,
          `${nativeFilePath}:${normalized.lastModified}:${normalized.size}`
        ) ?? uri)
      : (buildLocalImagePreviewSrc(displayUri, `${attachmentId}:${normalized.size}`) ??
        displayUri ??
        uri)
    : undefined;

  return {
    attachment: {
      attachmentId,
      mimeType,
      uri,
      ...(displayUri ? { displayUri } : {}),
      name: normalized.name
    },
    dedupeKey: nativeFilePath || `${normalized.name}:${mimeType}:${normalized.size}:${uri}`,
    displayName: normalized.name,
    isImage,
    mimeType,
    previewUrl,
    releasePreviewUrl: false,
    size: normalized.size,
    sizeLabel: formatComposerAttachmentSize(normalized.size)
  };
};

export const createComposerAttachments = async (
  files: Iterable<File>,
  origin: ComposerAttachmentOrigin,
  options: CreateComposerAttachmentOptions = {}
): Promise<ComposerAttachment[]> =>
  Promise.all(
    [...files]
      .filter((file) => file.size > 0 || file.type.trim().length > 0 || file.name.trim())
      .map((file) => createComposerAttachment(file, origin, options))
  );

export const mergeComposerAttachments = (
  existing: ComposerAttachment[],
  incoming: ComposerAttachment[]
): MergeComposerAttachmentsResult => {
  const attachments = [...existing];
  const replaced: ComposerAttachment[] = [];
  const skipped: ComposerAttachment[] = [];
  const attachmentIndexByKey = new Map(
    attachments.map((attachment, index) => [attachment.dedupeKey, index] as const)
  );

  for (const attachment of incoming) {
    const existingIndex = attachmentIndexByKey.get(attachment.dedupeKey);
    if (existingIndex !== undefined) {
      replaced.push(attachments[existingIndex]!);
      attachments[existingIndex] = attachment;
      continue;
    }
    attachmentIndexByKey.set(attachment.dedupeKey, attachments.length);
    attachments.push(attachment);
  }

  return {
    attachments,
    replaced,
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
