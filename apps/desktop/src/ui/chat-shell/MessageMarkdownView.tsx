import { useDeferredValue, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { MessageBlock } from "@another-workbench/shared";
import { ParticipantIdentityBadge } from "./ParticipantIdentityBadge.js";
import {
  buildParticipantDirectory,
  type ParticipantDirectory,
  resolveParticipantIdentity
} from "./participant-directory.js";

export type MessageMarkdownViewProps = {
  block: MessageBlock;
  participantDirectory?: ParticipantDirectory;
};

const defaultDirectory = buildParticipantDirectory([]);
const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
    src: [...(defaultSchema.protocols?.src ?? []), "file", "data"]
  }
};
const allowLocalFileUrls = (url: string): string => url;

const isRenderableMarkdownBlock = (block: MessageBlock): boolean =>
  block.kind === "markdown" || block.kind === "plain_text";

const blockMetaLabel = (block: MessageBlock): string => {
  if (block.role === "user") {
    return "you";
  }
  if (block.role === "assistant") {
    return "assistant";
  }
  return "system";
};

export const MessageMarkdownView = ({
  block,
  participantDirectory = defaultDirectory
}: MessageMarkdownViewProps): ReactElement => {
  const sourceText = block.text ?? "";
  const deferredText = useDeferredValue(sourceText);
  const isEmpty = deferredText.trim().length === 0;
  const roleClass =
    block.role === "assistant"
      ? "is-assistant"
      : block.role === "user"
        ? "is-user"
        : "is-system";
  const identity = resolveParticipantIdentity(
    participantDirectory,
    block.actor,
    block.role
  );

  return (
    <article className={`awb-message ${roleClass}`} data-block-id={block.blockId}>
      <header className="awb-message__meta">
        <span>{blockMetaLabel(block)}</span>
        <ParticipantIdentityBadge identity={identity} compact />
      </header>
      <div className="awb-message__content">
        {!isRenderableMarkdownBlock(block) && (
          <p className="awb-message__empty">
            This block references {block.kind}. View details on the right panel.
          </p>
        )}
        {isRenderableMarkdownBlock(block) && isEmpty && (
          <p className="awb-message__empty">
            {block.completedAt ? "(empty message)" : "(streaming...)"}
          </p>
        )}
        {isRenderableMarkdownBlock(block) && !isEmpty && (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
            urlTransform={allowLocalFileUrls}
          >
            {deferredText}
          </ReactMarkdown>
        )}
      </div>
    </article>
  );
};
