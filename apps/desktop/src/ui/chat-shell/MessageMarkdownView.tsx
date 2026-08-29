import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type ReactElement
} from "react";
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
import { buildLocalImagePreviewSrc } from "./local-image-preview.js";

export type MessageMarkdownViewProps = {
  block: MessageBlock;
  copyBlocks?: readonly MessageBlock[];
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

const externalLinkProtocols = new Set(["http:", "https:", "mailto:"]);
const unsupportedLinkHrefPrefix = "#awb-unsupported-link:";

const isExternalLinkHref = (href: string): boolean => {
  try {
    return externalLinkProtocols.has(new URL(href).protocol);
  } catch {
    return false;
  }
};

const isSupportedLinkHref = (href: string): boolean =>
  isExternalLinkHref(href) || href.toLowerCase().startsWith("file:");

type HtmlAstNode = {
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HtmlAstNode[];
};

const protectUnsupportedLinkTargets = () => {
  const visit = (node: HtmlAstNode): void => {
    const href = node.tagName === "a" ? node.properties?.href : undefined;
    if (typeof href === "string" && href.length > 0 && !isSupportedLinkHref(href)) {
      node.properties = {
        ...node.properties,
        href: `${unsupportedLinkHrefPrefix}${encodeURIComponent(href)}`
      };
    }
    node.children?.forEach(visit);
  };
  return visit;
};

const openExternalLink = (href: string): void => {
  if (typeof window === "undefined") {
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
};

const isRenderableMarkdownBlock = (block: MessageBlock): boolean =>
  block.kind === "markdown" || block.kind === "plain_text";

type CodeCommentDirective = {
  title?: string;
  body?: string;
  file?: string;
  start?: string;
  end?: string;
  priority?: string;
};

type RenderableSegment =
  | {
      kind: "markdown";
      text: string;
    }
  | {
      kind: "directive";
      directive: CodeCommentDirective;
    }
  | {
      kind: "mermaid";
      source: string;
    };

type StreamingMarkdownParts = {
  stableMarkdown: string;
  tailText: string;
};

type UserMessageParts = {
  text: string;
  attachmentMarkdown?: string;
};

const codeCommentLinePattern = /^::code-comment\{(?<attributes>.*)\}$/;
const directiveAttributeKeys = new Set<keyof CodeCommentDirective>([
  "title",
  "body",
  "file",
  "start",
  "end",
  "priority"
]);

const readQuotedDirectiveValue = (
  attributes: string,
  startIndex: number,
  quote: string
): { value: string; nextIndex: number } => {
  let value = "";
  let index = startIndex;
  while (index < attributes.length) {
    const character = attributes[index];
    const nextCharacter = attributes[index + 1];
    if (character === quote) {
      return { value, nextIndex: index + 1 };
    }
    if (character === "\\" && (nextCharacter === quote || nextCharacter === "\\")) {
      value += nextCharacter;
      index += 2;
      continue;
    }
    value += character;
    index += 1;
  }
  return { value, nextIndex: index };
};

const readBareDirectiveValue = (
  attributes: string,
  startIndex: number
): { value: string; nextIndex: number } => {
  let index = startIndex;
  while (index < attributes.length && !/[\s,}]/.test(attributes[index]!)) {
    index += 1;
  }
  return {
    value: attributes.slice(startIndex, index),
    nextIndex: index
  };
};

const parseDirectiveAttributes = (attributes: string): CodeCommentDirective => {
  const directive: CodeCommentDirective = {};
  let index = 0;
  while (index < attributes.length) {
    while (index < attributes.length && /[\s,]/.test(attributes[index]!)) {
      index += 1;
    }

    const keyStart = index;
    while (index < attributes.length && /[A-Za-z0-9_]/.test(attributes[index]!)) {
      index += 1;
    }
    const key = attributes.slice(keyStart, index) as keyof CodeCommentDirective;

    while (index < attributes.length && /\s/.test(attributes[index]!)) {
      index += 1;
    }
    if (!key || attributes[index] !== "=") {
      index += 1;
      continue;
    }
    index += 1;
    while (index < attributes.length && /\s/.test(attributes[index]!)) {
      index += 1;
    }

    const quote = attributes[index];
    const parsedValue =
      quote === '"' || quote === "'"
        ? readQuotedDirectiveValue(attributes, index + 1, quote)
        : readBareDirectiveValue(attributes, index);
    if (directiveAttributeKeys.has(key)) {
      directive[key] = parsedValue.value;
    }
    index = parsedValue.nextIndex;
  }
  return directive;
};

const parseCodeCommentDirective = (
  line: string
): CodeCommentDirective | undefined => {
  const match = line.match(codeCommentLinePattern);
  const attributes = match?.groups?.attributes;
  if (!attributes) {
    return undefined;
  }

  const directive = parseDirectiveAttributes(attributes);

  if (!directive.title && !directive.body && !directive.file) {
    return undefined;
  }
  return directive;
};

const mermaidFencePattern = /^(`{3,}|~{3,})\s*mermaid\s*$/i;
const markdownFenceStartPattern = /^(`{3,}|~{3,})/;

const splitLinesWithEndings = (value: string): string[] => {
  const lines = value.match(/[^\n]*(?:\n|$)/g) ?? [];
  return lines.filter((line, index) => line.length > 0 || index < lines.length - 1);
};

const stripLineEnding = (line: string): string =>
  line.endsWith("\n")
    ? line.slice(0, line.endsWith("\r\n") ? -2 : -1)
    : line;

export const splitStreamingMarkdown = (sourceText: string): StreamingMarkdownParts => {
  let offset = 0;
  let lastStableBoundary = 0;
  let openFence:
    | {
        startOffset: number;
        marker: string;
      }
    | undefined;

  for (const rawLine of splitLinesWithEndings(sourceText)) {
    const lineStartOffset = offset;
    offset += rawLine.length;
    const line = stripLineEnding(rawLine);
    const trimmedLine = line.trim();

    if (openFence) {
      const closingFencePattern = new RegExp(
        `^${openFence.marker[0]}{${openFence.marker.length},}\\s*$`
      );
      if (closingFencePattern.test(trimmedLine)) {
        openFence = undefined;
        lastStableBoundary = offset;
      }
      continue;
    }

    const fenceMatch = trimmedLine.match(markdownFenceStartPattern);
    if (fenceMatch) {
      openFence = {
        startOffset: lineStartOffset,
        marker: fenceMatch[1]!
      };
      continue;
    }

    if (trimmedLine.length === 0) {
      lastStableBoundary = offset;
    }
  }

  const boundary = openFence?.startOffset ?? lastStableBoundary;
  if (boundary <= 0) {
    return {
      stableMarkdown: "",
      tailText: sourceText
    };
  }

  return {
    stableMarkdown: sourceText.slice(0, boundary),
    tailText: sourceText.slice(boundary)
  };
};

const resolveRenderableMarkdownText = (block: MessageBlock, text: string): StreamingMarkdownParts =>
  block.role === "assistant" && !block.completedAt
    ? splitStreamingMarkdown(text)
    : { stableMarkdown: text, tailText: "" };

export const splitUserMessageText = (sourceText: string): UserMessageParts => {
  const sections = sourceText.split(/\r?\n\r?\n/u);
  const attachmentMarkdown = sections.at(-1) ?? "";
  const isAttachmentBlock = attachmentMarkdown
    .split(/\r?\n/u)
    .every((line) => /^!?\[[^\]\r\n]*\]\((?:file:|data:image\/|blob:)[^\r\n]+\)$/u.test(line));
  if (!attachmentMarkdown || !isAttachmentBlock) {
    return { text: sourceText };
  }

  return {
    text: sections.length > 1 ? sections.slice(0, -1).join("\n\n") : "",
    attachmentMarkdown
  };
};

const buildRenderableSegments = (sourceText: string): RenderableSegment[] => {
  const lines = sourceText.split(/\r?\n/);
  const segments: RenderableSegment[] = [];
  const markdownBuffer: string[] = [];

  const flushMarkdown = (): void => {
    if (markdownBuffer.length === 0) {
      return;
    }
    segments.push({
      kind: "markdown",
      text: markdownBuffer.join("\n")
    });
    markdownBuffer.length = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const mermaidFence = line.trim().match(mermaidFencePattern);
    if (mermaidFence) {
      const fence = mermaidFence[1]!;
      const fencePrefix = fence[0]!;
      const closingFencePattern = new RegExp(
        `^${fencePrefix}{${fence.length},}\\s*$`
      );
      const chartLines: string[] = [];
      let closingIndex: number | undefined;
      for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
        const nextLine = lines[nextIndex]!;
        if (closingFencePattern.test(nextLine.trim())) {
          closingIndex = nextIndex;
          break;
        }
        chartLines.push(nextLine);
      }

      if (closingIndex !== undefined) {
        flushMarkdown();
        segments.push({
          kind: "mermaid",
          source: chartLines.join("\n").trim()
        });
        index = closingIndex;
        continue;
      }
    }

    const directive = parseCodeCommentDirective(line.trim());
    if (!directive) {
      markdownBuffer.push(line);
      continue;
    }
    flushMarkdown();
    segments.push({
      kind: "directive",
      directive
    });
  }

  flushMarkdown();
  return segments;
};

const renderLocationLabel = (directive: CodeCommentDirective): string | undefined => {
  if (!directive.file) {
    return undefined;
  }
  if (!directive.start) {
    return directive.file;
  }
  return directive.end && directive.end !== directive.start
    ? `${directive.file}:${directive.start}-${directive.end}`
    : `${directive.file}:${directive.start}`;
};

const renderPriorityLabel = (priority: string | undefined): string | undefined => {
  if (!priority) {
    return undefined;
  }
  return `P${priority}`;
};

const hashMermaidSource = (value: string): string => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
};

const buildMermaidRenderId = (blockId: string, index: number, source: string): string =>
  `awb-mermaid-${blockId.replace(/[^A-Za-z0-9_-]/g, "-")}-${index}-${hashMermaidSource(source)}`;

type MarkdownRendererProps = {
  text: string;
  cacheKey: string;
  onActivateResourceLink?: (reference: ExtractedFileReference) => void;
  onPreviewImage?: (input: { src: string; alt: string }) => void;
};

const MarkdownRenderer = memo(({
  text,
  cacheKey,
  onActivateResourceLink,
  onPreviewImage
}: MarkdownRendererProps): ReactElement => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    rehypePlugins={[protectUnsupportedLinkTargets, [rehypeSanitize, sanitizeSchema]]}
    urlTransform={allowLocalFileUrls}
    components={{
      a: ({ href, children, node: _ignoredNode, ...props }) => {
        const unsupportedTarget = href?.startsWith(unsupportedLinkHrefPrefix)
          ? decodeURIComponent(href.slice(unsupportedLinkHrefPrefix.length))
          : undefined;
        if (unsupportedTarget) {
          return (
            <span className="awb-message__unsupported-link">
              {children}
              <code className="awb-message__unsupported-link-target">
                {unsupportedTarget}
              </code>
            </span>
          );
        }
        const filePath = href ? fileTargetToPath(href) : undefined;
        if (!href || !filePath || !onActivateResourceLink) {
          if (href && isExternalLinkHref(href)) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                {...props}
                onClick={(event) => {
                  event.preventDefault();
                  openExternalLink(href);
                }}
              >
                {children}
              </a>
            );
          }
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
                createFileReferenceFromPath(filePath, "markdown_link", label || undefined)
              );
            }}
          >
            {children}
          </a>
        );
      },
      img: ({ src, alt, ...props }) => {
        const previewSrc = buildLocalImagePreviewSrc(src, cacheKey);
        if (!src || !onPreviewImage) {
          return <img src={previewSrc} alt={alt ?? ""} {...props} />;
        }
        return (
          <button
            type="button"
            className="awb-inline-image-button"
            onClick={() =>
              onPreviewImage({ src: previewSrc ?? src, alt: alt ?? "Image preview" })
            }
          >
            <img src={previewSrc} alt={alt ?? ""} {...props} />
          </button>
        );
      }
    }}
  >
    {text}
  </ReactMarkdown>
));

type MermaidBlockProps = {
  source: string;
  renderId: string;
};

const MermaidFallbackCode = ({ source }: { source: string }): ReactElement => (
  <pre className="awb-mermaid__fallback">
    <code>{source}</code>
  </pre>
);

const MermaidBlock = ({ source, renderId }: MermaidBlockProps): ReactElement => {
  const [state, setState] = useState<
    | { status: "pending" }
    | { status: "rendered"; svg: string }
    | { status: "failed"; error: string }
  >({ status: "pending" });

  useEffect(() => {
    let disposed = false;
    if (source.trim().length === 0) {
      setState({ status: "failed", error: "Empty Mermaid diagram." });
      return () => {
        disposed = true;
      };
    }

    void import("mermaid")
      .then(async (module) => {
        const mermaid = module.default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "strict"
        });
        const result = await mermaid.render(renderId, source);
        if (!disposed) {
          setState({ status: "rendered", svg: result.svg });
        }
      })
      .catch((error) => {
        if (!disposed) {
          setState({
            status: "failed",
            error: error instanceof Error ? error.message : "Mermaid render failed."
          });
        }
      });

    return () => {
      disposed = true;
    };
  }, [renderId, source]);

  return (
    <figure className="awb-mermaid" aria-label="Mermaid diagram">
      {state.status === "rendered" ? (
        <div
          className="awb-mermaid__surface"
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      ) : (
        <MermaidFallbackCode source={source} />
      )}
      {state.status === "failed" && (
        <figcaption className="awb-mermaid__error">{state.error}</figcaption>
      )}
    </figure>
  );
};

const StreamingPlainTextTail = ({ text }: { text: string }): ReactElement => (
  <div className="awb-message__streaming-tail">{text}</div>
);

export const MessageMarkdownView = memo(({
  block,
  copyBlocks,
  onActivateResourceLink,
  onPreviewImage
}: MessageMarkdownViewProps): ReactElement => {
  const sourceText = block.text ?? "";
  const copyText = copyBlocks
    ?.flatMap((candidate) =>
      isRenderableMarkdownBlock(candidate) && candidate.text
        ? [candidate.text]
        : []
    )
    .join("\n\n");
  const deferredText = useDeferredValue(sourceText);
  const userMessageParts = splitUserMessageText(deferredText);
  const { stableMarkdown, tailText } = useMemo(
    () => resolveRenderableMarkdownText(block, deferredText),
    [block, deferredText]
  );
  const isEmpty = deferredText.trim().length === 0;
  const renderableSegments = useMemo(
    () => buildRenderableSegments(stableMarkdown),
    [stableMarkdown]
  );
  const hasMermaidSegment = renderableSegments.some((segment) => segment.kind === "mermaid");
  const roleClass =
    block.role === "assistant"
      ? "is-assistant"
      : block.role === "user"
        ? "is-user"
        : "is-system";
  const mermaidClass = hasMermaidSegment ? " awb-message--contains-mermaid" : "";

  return (
    <article
      className={`awb-message ${roleClass}${mermaidClass}`}
      data-block-id={block.blockId}
    >
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
          <>
            {block.role === "user" && userMessageParts.text ? (
              <div className="awb-message__user-text">{userMessageParts.text}</div>
            ) : null}
            {block.role === "user" && userMessageParts.attachmentMarkdown ? (
              <MarkdownRenderer
                text={userMessageParts.attachmentMarkdown}
                cacheKey={`${block.blockId}:attachments`}
                onActivateResourceLink={onActivateResourceLink}
                onPreviewImage={onPreviewImage}
              />
            ) : null}
            {block.role !== "user" && renderableSegments.map((segment, index) => {
              if (segment.kind === "markdown") {
                return (
                  <MarkdownRenderer
                    key={`${block.blockId}:markdown:${index}`}
                    text={segment.text}
                    cacheKey={`${block.blockId}:markdown:${index}`}
                    onActivateResourceLink={onActivateResourceLink}
                    onPreviewImage={onPreviewImage}
                  />
                );
              }

              if (segment.kind === "mermaid") {
                return (
                  <MermaidBlock
                    key={`${block.blockId}:mermaid:${index}`}
                    source={segment.source}
                    renderId={buildMermaidRenderId(block.blockId, index, segment.source)}
                  />
                );
              }

              const locationLabel = renderLocationLabel(segment.directive);
              const priorityLabel = renderPriorityLabel(segment.directive.priority);
              return (
                <section
                  key={`${block.blockId}:directive:${index}`}
                  className="awb-code-comment"
                  aria-label="Code review finding"
                >
                  <header className="awb-code-comment__header">
                    <span className="awb-code-comment__eyebrow">Finding</span>
                    {priorityLabel && (
                      <span className="awb-code-comment__priority">{priorityLabel}</span>
                    )}
                  </header>
                  {segment.directive.title && (
                    <div className="awb-code-comment__title">
                      <MarkdownRenderer
                        text={segment.directive.title}
                        cacheKey={`${block.blockId}:directive:${index}:title`}
                        onActivateResourceLink={onActivateResourceLink}
                        onPreviewImage={onPreviewImage}
                      />
                    </div>
                  )}
                  {segment.directive.body && (
                    <div className="awb-code-comment__body">
                      <MarkdownRenderer
                        text={segment.directive.body}
                        cacheKey={`${block.blockId}:directive:${index}:body`}
                        onActivateResourceLink={onActivateResourceLink}
                        onPreviewImage={onPreviewImage}
                      />
                    </div>
                  )}
                  {locationLabel && (
                    <p className="awb-code-comment__meta">
                      <code>{locationLabel}</code>
                    </p>
                  )}
                </section>
              );
            })}
            {block.role !== "user" && tailText ? (
              <StreamingPlainTextTail text={tailText} />
            ) : null}
          </>
        )}
        {copyText ? (
          <button
            type="button"
            className="awb-message__copy"
            aria-label="Copy message"
            title="Copy"
            onClick={() => {
              void navigator.clipboard.writeText(copyText);
            }}
          >
            <svg aria-hidden="true" focusable="false" viewBox="0 0 20 20">
              <rect x="8" y="8" width="9" height="9" rx="1.75" />
              <path d="M12 8V5.75A1.75 1.75 0 0 0 10.25 4h-4.5A1.75 1.75 0 0 0 4 5.75v4.5A1.75 1.75 0 0 0 5.75 12H8" />
            </svg>
          </button>
        ) : null}
      </div>
    </article>
  );
});
