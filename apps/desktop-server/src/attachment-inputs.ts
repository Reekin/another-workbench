import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
  appendAttachmentMarkdown,
  fileUriToPath,
  isImageAttachment,
  resolveAttachmentDisplayName,
  type Attachment
} from "@another-workbench/shared";
import type { UserInput } from "./codex-app-server-generated/v2/UserInput.js";

const dataUriPattern = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/isu;

const joinTextSections = (sections: Array<string | undefined>): string =>
  sections.map((section) => section?.trim() ?? "").filter(Boolean).join("\n\n");

const parseDataUri = (
  uri: string
): {
  mimeType: string;
  data: string;
} | null => {
  const match = dataUriPattern.exec(uri);
  if (!match) {
    return null;
  }
  const mimeType = match[1]?.trim() || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  if (!isBase64) {
    return null;
  }
  const body = match[3] ?? "";
  return {
    mimeType,
    data: body
  };
};

const buildCodexAttachmentContext = (attachment: Attachment): string => {
  const label = resolveAttachmentDisplayName(attachment);
  const filePath = fileUriToPath(attachment.uri);
  if (filePath) {
    return `Attached file: ${label}\nPath: ${filePath}`;
  }
  return `Attached file: ${label}\nURI: ${attachment.uri}`;
};

export const buildLocalEchoMessageText = (
  content: string,
  attachments: Attachment[]
): string => appendAttachmentMarkdown(content, attachments);

export const buildCodexTurnInput = (
  content: string,
  attachments: Attachment[]
): UserInput[] => {
  const inputs: UserInput[] = [];
  const textSections: string[] = [];

  if (content.trim().length > 0) {
    textSections.push(content);
  }

  for (const attachment of attachments) {
    if (isImageAttachment(attachment)) {
      const filePath = fileUriToPath(attachment.uri);
      if (filePath) {
        inputs.push({
          type: "localImage",
          path: filePath
        });
        continue;
      }
      inputs.push({
        type: "image",
        url: attachment.uri
      });
      continue;
    }

    textSections.push(buildCodexAttachmentContext(attachment));
  }

  const text = joinTextSections(textSections);
  if (text) {
    inputs.unshift({
      type: "text",
      text,
      text_elements: []
    });
  }

  return inputs;
};

export const buildAcpPromptContent = (
  content: string,
  attachments: Attachment[]
): ContentBlock[] => {
  const blocks: ContentBlock[] = [];

  if (content.trim().length > 0) {
    blocks.push({
      type: "text",
      text: content.trim()
    });
  }

  for (const attachment of attachments) {
    if (isImageAttachment(attachment)) {
      const dataUri = parseDataUri(attachment.uri);
      if (dataUri) {
        blocks.push({
          type: "image",
          mimeType: dataUri.mimeType,
          data: dataUri.data,
          uri: attachment.uri
        });
        continue;
      }
    }

    blocks.push({
      type: "resource_link",
      name: resolveAttachmentDisplayName(attachment),
      title: resolveAttachmentDisplayName(attachment),
      uri: attachment.uri,
      mimeType: attachment.mimeType || null
    });
  }

  return blocks;
};
