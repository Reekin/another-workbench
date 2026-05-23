import type { ResponseItem } from "../../codex-app-server-generated/ResponseItem.js";
import type { ThreadItem } from "../../codex-app-server-generated/v2/ThreadItem.js";
import { filePathToFileUri } from "@another-workbench/shared";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const isCodexReasoningThreadItem = (
  item: ThreadItem | Record<string, unknown>
): item is Extract<ThreadItem, { type: "reasoning" }> =>
  isRecord(item) && item.type === "reasoning" && typeof item.id === "string";

export const isCodexWebSearchThreadItem = (
  item: ThreadItem | Record<string, unknown>
): item is Extract<ThreadItem, { type: "webSearch" }> =>
  isRecord(item) && item.type === "webSearch" && typeof item.id === "string";

export const isCodexContextCompactionThreadItem = (
  item: ThreadItem | Record<string, unknown>
): item is Extract<ThreadItem, { type: "contextCompaction" }> =>
  isRecord(item) && item.type === "contextCompaction" && typeof item.id === "string";

export const isCodexImageViewThreadItem = (
  item: ThreadItem | Record<string, unknown>
): item is Extract<ThreadItem, { type: "imageView" }> =>
  isRecord(item) && item.type === "imageView" && typeof item.id === "string";

export const isCodexImageGenerationThreadItem = (
  item: ThreadItem | Record<string, unknown>
): item is Extract<ThreadItem, { type: "imageGeneration" }> =>
  isRecord(item) && item.type === "imageGeneration" && typeof item.id === "string";

export const summarizeCodexReasoningThreadItem = (
  item: Extract<ThreadItem, { type: "reasoning" }>
): string | undefined => {
  const parts = [...item.summary, ...item.content]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
};

export const summarizeCodexRawReasoningItem = (
  item: Extract<ResponseItem, { type: "reasoning" }>
): string | undefined => {
  const summary = item.summary
    .map((part) => part.text.trim())
    .filter((value) => value.length > 0);
  const content = (item.content ?? [])
    .map((part) => part.text.trim())
    .filter((value) => value.length > 0);
  const parts = summary.length > 0 ? summary : content;
  return parts.length > 0 ? parts.join("\n\n") : undefined;
};

export const summarizeCodexFunctionOutputBody = (
  output: Extract<ResponseItem, { type: "custom_tool_call_output" }>["output"]
): string | undefined => {
  if (typeof output === "string") {
    return output.trim().length > 0 ? output : undefined;
  }
  const parts = output
    .map((entry) => {
      if (entry.type === "input_text") {
        return entry.text;
      }
      if (entry.type === "input_image") {
        return entry.image_url;
      }
      return undefined;
    })
    .filter((value): value is string => Boolean(value && value.trim().length > 0));
  return parts.length > 0 ? parts.join("\n") : undefined;
};

const escapeMarkdownImageAlt = (value: string): string =>
  value.replace(/[[\]\\]/gu, "\\$&");

const isUrlLikeImageSource = (value: string): boolean =>
  /^(?:https?:|file:|data:image\/)/iu.test(value);

const isSmallBase64ImagePayload = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 180_000 &&
  /^[A-Za-z0-9+/=\r\n]+$/u.test(value);

const imageMarkdown = (alt: string, src: string): string =>
  `![${escapeMarkdownImageAlt(alt)}](${src})`;

export const summarizeCodexImageViewInput = (
  item: Extract<ThreadItem, { type: "imageView" }>
): string => item.path;

export const summarizeCodexImageViewOutput = (
  item: Extract<ThreadItem, { type: "imageView" }>
): string => [imageMarkdown("Viewed image", filePathToFileUri(item.path)), `path: ${item.path}`].join("\n");

const codexImageGenerationSource = (
  item: Extract<ThreadItem, { type: "imageGeneration" }>
): string | undefined => {
  if (item.savedPath) {
    return filePathToFileUri(item.savedPath);
  }
  const result = item.result.trim();
  if (!result) {
    return undefined;
  }
  if (isUrlLikeImageSource(result)) {
    return result;
  }
  if (isSmallBase64ImagePayload(result)) {
    return `data:image/png;base64,${result.replace(/\s+/gu, "")}`;
  }
  return undefined;
};

export const summarizeCodexImageGenerationInput = (
  item: Extract<ThreadItem, { type: "imageGeneration" }>
): string =>
  item.revisedPrompt?.trim() ||
  (item.status ? `status: ${item.status}` : "Generate image");

export const summarizeCodexImageGenerationOutput = (
  item: Extract<ThreadItem, { type: "imageGeneration" }>
): string | undefined => {
  const imageSource = codexImageGenerationSource(item);
  const parts = [
    imageSource ? imageMarkdown("Generated image", imageSource) : undefined,
    item.revisedPrompt?.trim() ? `prompt: ${item.revisedPrompt.trim()}` : undefined,
    item.savedPath ? `path: ${item.savedPath}` : undefined,
    item.status ? `status: ${item.status}` : undefined,
    !imageSource && item.result.trim() ? "image result available" : undefined
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join("\n") : undefined;
};

export const codexRawCustomToolCallId = (
  turnId: string,
  callId: string
): string => `raw-custom-tool:${turnId}:${callId}`;

export const summarizeCodexWebSearchAction = (
  action: unknown,
  fallbackQuery?: string
): string | undefined => {
  if (!isRecord(action) || typeof action.type !== "string") {
    return fallbackQuery ? `Search\nquery: ${fallbackQuery}` : undefined;
  }

  switch (action.type) {
    case "search": {
      const query =
        typeof action.query === "string" && action.query.trim()
          ? action.query.trim()
          : fallbackQuery;
      const queries = Array.isArray(action.queries)
        ? action.queries
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        : [];
      const parts = [
        "Search",
        query ? `query: ${query}` : undefined,
        queries.length > 0
          ? `queries:\n${queries.map((value) => `- ${value}`).join("\n")}`
          : undefined
      ].filter((value): value is string => Boolean(value));
      return parts.length > 0 ? parts.join("\n") : undefined;
    }
    case "openPage":
    case "open_page":
      return typeof action.url === "string" && action.url.trim()
        ? `Open page\nurl: ${action.url.trim()}`
        : "Open page";
    case "findInPage":
    case "find_in_page": {
      const parts = [
        "Find in page",
        typeof action.url === "string" && action.url.trim()
          ? `url: ${action.url.trim()}`
          : undefined,
        typeof action.pattern === "string" && action.pattern.trim()
          ? `pattern: ${action.pattern.trim()}`
          : undefined
      ].filter((value): value is string => Boolean(value));
      return parts.join("\n");
    }
    default:
      return fallbackQuery ? `Web search\nquery: ${fallbackQuery}` : "Web search";
  }
};

const stableHash = (value: string): string => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
};

export const codexRawResponseToolCallId = (
  turnId: string,
  item: ResponseItem,
  toolName: string
): string => `raw-response:${turnId}:${toolName}:${stableHash(JSON.stringify(item))}`;

export const mapCodexResponseItemStatus = (
  status: string | undefined
): "completed" | "failed" | "cancelled" =>
  status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "completed";
