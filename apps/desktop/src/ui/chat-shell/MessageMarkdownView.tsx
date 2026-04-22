import { useDeferredValue, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type {
  ExtractedFileReference,
  MessageBlock
} from "@another-workbench/shared";
import {
  createFileReferenceFromPath,
  fileTargetToPath
} from "@another-workbench/shared";

export type MessageMarkdownViewProps = {
  block: MessageBlock;
  onActivateResourceLink?: (reference: ExtractedFileReference) => void;
  onPreviewImage?: (input: { src: string; alt: string }) => void;
};

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

export const MessageMarkdownView = ({
  block,
  onActivateResourceLink,
  onPreviewImage
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

  return (
    <article className={`awb-message ${roleClass}`} data-block-id={block.blockId}>
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
            components={{
              a: ({ href, children, ...props }) => {
                const filePath = href ? fileTargetToPath(href) : undefined;
                if (!href || !filePath || !onActivateResourceLink) {
                  return (
                    <a href={href} {...props}>
                      {children}
                    </a>
                  );
                }
                const label =
                  typeof children === "string"
                    ? children
                    : Array.isArray(children)
                      ? children.filter((item) => typeof item === "string").join("")
                      : "";
                return (
                  <a
                    href={href}
                    {...props}
                    onClick={(event) => {
                      event.preventDefault();
                      onActivateResourceLink(
                        createFileReferenceFromPath(
                          filePath,
                          "markdown_link",
                          label || undefined
                        )
                      );
                    }}
                  >
                    {children}
                  </a>
                );
              },
              img: ({ src, alt, ...props }) => {
                if (!src || !onPreviewImage) {
                  return <img src={src} alt={alt ?? ""} {...props} />;
                }
                return (
                  <button
                    type="button"
                    className="awb-inline-image-button"
                    onClick={() =>
                      onPreviewImage({ src, alt: alt ?? "Image preview" })
                    }
                  >
                    <img src={src} alt={alt ?? ""} {...props} />
                  </button>
                );
              }
            }}
          >
            {deferredText}
          </ReactMarkdown>
        )}
      </div>
    </article>
  );
};
