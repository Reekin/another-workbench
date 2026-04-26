import type { Attachment } from "@another-workbench/shared";

const DEFAULT_TITLE_MODEL = "gpt-5.4-mini";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PROMPT_CONTENT_LENGTH = 4_000;
const MAX_TITLE_LENGTH = 48;

type FetchLike = typeof fetch;
type MaybePromise<T> = T | Promise<T>;

export type OpenAiSessionTitleAuth = {
  apiKey?: string;
  baseUrl?: string;
};

export type SessionTitleGeneratorInput = {
  content: string;
  attachments: Attachment[];
};

export type SessionTitleGenerator = {
  generateTitle(input: SessionTitleGeneratorInput): Promise<string | undefined>;
};

export type OpenAiSessionTitleGeneratorOptions = {
  apiKey?: string;
  baseUrl?: string;
  resolveAuth?: () => MaybePromise<OpenAiSessionTitleAuth | undefined>;
  model?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
};

export const createOpenAiSessionTitleGenerator = (
  options: OpenAiSessionTitleGeneratorOptions = {}
): SessionTitleGenerator => {
  const staticApiKey = options.apiKey?.trim();
  const staticBaseUrl = options.baseUrl?.trim();
  const model = options.model?.trim() || DEFAULT_TITLE_MODEL;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async generateTitle(input) {
      const resolvedAuth = staticApiKey
        ? undefined
        : await options.resolveAuth?.();
      const apiKey = staticApiKey || resolvedAuth?.apiKey?.trim();
      if (!apiKey || !fetchImpl) {
        return undefined;
      }
      const baseUrl = normalizeBaseUrl(staticBaseUrl || resolvedAuth?.baseUrl);

      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        const response = await fetchImpl(`${responsesApiUrl(baseUrl)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            input: [
              {
                role: "developer",
                content: [
                  {
                    type: "input_text",
                    text: [
                      "Summarize the user's first message into one concise conversation title.",
                      "Return only the title.",
                      "Use the same language as the user's message when practical.",
                      `Keep it under ${MAX_TITLE_LENGTH} characters.`
                    ].join(" ")
                  }
                ]
              },
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: buildTitlePrompt(input)
                  }
                ]
              }
            ],
            max_output_tokens: 32
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          throw new Error(
            `Title generation request failed: ${response.status} ${response.statusText}`.trim()
          );
        }

        const payload = (await response.json()) as unknown;
        return sanitizeGeneratedTitle(extractResponseText(payload));
      } finally {
        clearTimeout(timeout);
      }
    }
  };
};

export const sanitizeGeneratedTitle = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return undefined;
  }

  const withoutLabel = firstLine.replace(/^(title|标题)\s*[:：]\s*/i, "");
  const unquoted = withoutLabel.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "");
  const collapsed = unquoted.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return undefined;
  }

  return [...collapsed].slice(0, MAX_TITLE_LENGTH).join("");
};

const normalizeBaseUrl = (baseUrl: string | undefined): string =>
  (baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");

const responsesApiUrl = (baseUrl: string): string =>
  /\/v1$/u.test(baseUrl) ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`;

const buildTitlePrompt = (input: SessionTitleGeneratorInput): string => {
  const content = truncatePromptContent(input.content.trim());
  const attachmentLines = input.attachments.map((attachment) =>
    [
      attachment.name ? `name=${attachment.name}` : undefined,
      `mimeType=${attachment.mimeType}`
    ]
      .filter(Boolean)
      .join(", ")
  );

  return [
    "User message:",
    content || "(empty text)",
    attachmentLines.length > 0 ? "\nAttachments:" : undefined,
    ...attachmentLines.map((line) => `- ${line}`)
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
};

const truncatePromptContent = (content: string): string => {
  const chars = [...content];
  if (chars.length <= MAX_PROMPT_CONTENT_LENGTH) {
    return content;
  }
  return `${chars.slice(0, MAX_PROMPT_CONTENT_LENGTH).join("")}\n…`;
};

const extractResponseText = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const outputText = (payload as { output_text?: unknown }).output_text;
  if (typeof outputText === "string") {
    return outputText;
  }

  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    return undefined;
  }

  const textParts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") {
        continue;
      }
      const text = (contentItem as { text?: unknown }).text;
      if (typeof text === "string") {
        textParts.push(text);
      }
    }
  }

  return textParts.join("");
};
