import type { Attachment } from "./commands.js";

const windowsDrivePathPattern = /^[A-Za-z]:[\\/]/u;
const uncPathPattern = /^\\\\[^\\]/u;

const encodeFileUriPath = (value: string): string =>
  encodeURI(value.replace(/\\/gu, "/"));

const basenameFromUri = (uri: string): string | undefined => {
  const normalized = uri.split("?")[0]?.split("#")[0] ?? uri;
  const segments = normalized.split("/");
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) {
    return undefined;
  }
  try {
    return decodeURIComponent(lastSegment);
  } catch {
    return lastSegment;
  }
};

const escapeMarkdownText = (value: string): string =>
  value.replace(/([\\[\]])/gu, "\\$1");

export const isImageMimeType = (mimeType: string | undefined): boolean =>
  Boolean(mimeType && mimeType.toLowerCase().startsWith("image/"));

export const isImageAttachment = (attachment: Attachment): boolean =>
  isImageMimeType(attachment.mimeType);

export const resolveAttachmentDisplayName = (attachment: Attachment): string =>
  attachment.name?.trim() ||
  basenameFromUri(attachment.uri) ||
  attachment.attachmentId;

export const resolveAttachmentDisplayUri = (attachment: Attachment): string =>
  attachment.displayUri?.trim() || attachment.uri;

export const filePathToFileUri = (path: string): string => {
  if (uncPathPattern.test(path)) {
    const normalized = path.replace(/\\/gu, "/");
    return `file:${encodeURI(normalized)}`;
  }

  const normalized = encodeFileUriPath(path);
  if (windowsDrivePathPattern.test(path)) {
    return `file:///${normalized}`;
  }
  if (normalized.startsWith("/")) {
    return `file://${normalized}`;
  }
  return `file:///${normalized}`;
};

export const buildAttachmentMarkdown = (attachments: Attachment[]): string =>
  attachments
    .map((attachment) => {
      const label = escapeMarkdownText(resolveAttachmentDisplayName(attachment));
      return isImageAttachment(attachment)
        ? `![${label}](${resolveAttachmentDisplayUri(attachment)})`
        : `[${label}](${resolveAttachmentDisplayUri(attachment)})`;
    })
    .join("\n");

export const appendAttachmentMarkdown = (
  content: string,
  attachments: Attachment[]
): string => {
  const attachmentMarkdown = buildAttachmentMarkdown(attachments);
  if (!attachmentMarkdown) {
    return content;
  }
  if (!content) {
    return attachmentMarkdown;
  }
  return `${content}\n\n${attachmentMarkdown}`;
};
