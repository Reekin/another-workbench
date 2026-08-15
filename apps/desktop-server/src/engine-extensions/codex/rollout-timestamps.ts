import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { ThreadItem } from "../../codex-app-server-generated/v2/ThreadItem.js";

export type CodexRolloutTimestampedItem = {
  type: ThreadItem["type"];
  timestamp: string;
  contentKey?: string;
};

export type CodexRolloutTimestampGroup = {
  turnId: string;
  startedAt?: string;
  completedAt?: string;
  items: CodexRolloutTimestampedItem[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const normalizeCodexTimestamp = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
};

const resolveRolloutTimestampedItemType = (
  entryType: unknown,
  payload: Record<string, unknown>
): ThreadItem["type"] | undefined => {
  if (entryType === "event_msg") {
    if (payload.type === "user_message") {
      return "userMessage";
    }
    if (payload.type === "exec_command_end") {
      return "commandExecution";
    }
    if (payload.type === "agent_message") {
      return "agentMessage";
    }
    if (payload.type === "agent_reasoning") {
      return "reasoning";
    }
    if (payload.type === "context_compacted") {
      return "contextCompaction";
    }
    return undefined;
  }
  if (entryType === "compacted") {
    return "contextCompaction";
  }
  if (entryType !== "response_item") {
    return undefined;
  }
  if (
    payload.type === "message" &&
    payload.role === "user" &&
    !isSyntheticCodexUserMessage(payload)
  ) {
    return "userMessage";
  }
  if (payload.type === "message" && payload.role === "assistant") {
    return "agentMessage";
  }
  if (payload.type === "reasoning") {
    return "reasoning";
  }
  if (payload.type === "web_search_call") {
    return "webSearch";
  }
  if (payload.type === "compaction") {
    return "contextCompaction";
  }
  return undefined;
};

const readString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const readTextParts = (
  content: unknown,
  contentType: "input_text" | "output_text"
): string[] =>
  Array.isArray(content)
    ? content
        .filter(isRecord)
        .filter((item) => item.type === contentType)
        .map((item) => readString(item.text))
        .filter((value): value is string => Boolean(value))
    : [];

const isSyntheticCodexUserMessage = (payload: Record<string, unknown>): boolean => {
  const text = readTextParts(payload.content, "input_text").join("\n");
  return (
    text.includes("# AGENTS.md instructions for ") ||
    text.includes("<environment_context>") ||
    text.includes("<developer_context>")
  );
};

const normalizeContentKey = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const resolveRolloutContentKey = (
  entryType: unknown,
  payload: Record<string, unknown>
): string | undefined => {
  if (entryType === "event_msg") {
    return normalizeContentKey(readString(payload.message));
  }
  if (entryType !== "response_item" || payload.type !== "message") {
    return undefined;
  }
  return normalizeContentKey(
    readTextParts(
      payload.content,
      payload.role === "user" ? "input_text" : "output_text"
    ).join("\n")
  );
};

const resolveThreadItemContentKey = (item: ThreadItem): string | undefined => {
  if (item.type === "agentMessage") {
    return normalizeContentKey(item.text);
  }
  if (item.type !== "userMessage") {
    return undefined;
  }
  return normalizeContentKey(
    item.content
      .map((input) =>
        input.type === "text" ? input.text : undefined
      )
      .filter((value): value is string => Boolean(value))
      .join("\n")
  );
};

const pushRolloutTimestamp = (
  group: CodexRolloutTimestampGroup,
  item: CodexRolloutTimestampedItem
): void => {
  const previousItem = group.items.at(-1);
  if (
    item.type === "contextCompaction" &&
    previousItem?.type === "contextCompaction" &&
    Math.abs(Date.parse(item.timestamp) - Date.parse(previousItem.timestamp)) <= 1_000
  ) {
    return;
  }
  if (
    item.contentKey &&
    previousItem?.type === item.type &&
    previousItem.contentKey === item.contentKey &&
    Math.abs(Date.parse(item.timestamp) - Date.parse(previousItem.timestamp)) <= 1_000
  ) {
    return;
  }
  if (
    group.items.some(
      (existing) => existing.type === item.type && existing.timestamp === item.timestamp
    )
  ) {
    return;
  }
  group.items.push(item);
};

export const readCodexRolloutTimestampGroups = async (
  rolloutPath: string | null
): Promise<CodexRolloutTimestampGroup[]> => {
  if (!rolloutPath) {
    return [];
  }

  const groups: CodexRolloutTimestampGroup[] = [];
  let currentGroup: CodexRolloutTimestampGroup | undefined;
  const lines = createInterface({
    input: createReadStream(rolloutPath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY
  });
  try {
    for await (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(entry)) {
        continue;
      }
      const payload = isRecord(entry.payload) ? entry.payload : {};
      const timestamp = normalizeCodexTimestamp(entry.timestamp);
      if (entry.type === "event_msg" && payload.type === "task_started") {
        const turnId = readString(payload.turn_id) ?? `rollout-turn:${groups.length}`;
        currentGroup = { turnId, startedAt: timestamp, items: [] };
        groups.push(currentGroup);
        continue;
      }
      if (!currentGroup || !timestamp) {
        continue;
      }
      if (entry.type === "event_msg" && payload.type === "task_complete") {
        currentGroup.completedAt = timestamp;
        continue;
      }
      const itemType = resolveRolloutTimestampedItemType(entry.type, payload);
      if (itemType) {
        pushRolloutTimestamp(currentGroup, {
          type: itemType,
          timestamp,
          contentKey: resolveRolloutContentKey(entry.type, payload)
        });
      }
    }
  } catch {
    return [];
  } finally {
    lines.close();
  }
  return groups;
};

export const readCodexRolloutModifiedAt = async (
  rolloutPath: string | null
): Promise<string | undefined> => {
  if (!rolloutPath) {
    return undefined;
  }
  try {
    return new Date((await stat(rolloutPath)).mtimeMs).toISOString();
  } catch {
    return undefined;
  }
};

export const resolveCodexThreadItemTimestamp = (item: ThreadItem): string | undefined =>
  normalizeCodexTimestamp((item as { timestamp?: unknown }).timestamp);

export const consumeCodexRolloutTimestamp = (
  timestamps: CodexRolloutTimestampedItem[],
  itemType: ThreadItem["type"]
): string | undefined => {
  const index = timestamps.findIndex((item) => item.type === itemType);
  if (index < 0) {
    return undefined;
  }
  const [timestampedItem] = timestamps.splice(index, 1);
  return timestampedItem?.timestamp;
};

export const consumeCodexRolloutTimestampForItem = (
  timestamps: CodexRolloutTimestampedItem[],
  item: ThreadItem
): string | undefined => {
  const contentKey = resolveThreadItemContentKey(item);
  const exactIndex = contentKey
    ? timestamps.findIndex(
        (timestampedItem) =>
          timestampedItem.type === item.type && timestampedItem.contentKey === contentKey
      )
    : -1;
  if (exactIndex >= 0) {
    const [timestampedItem] = timestamps.splice(exactIndex, 1);
    return timestampedItem?.timestamp;
  }
  return consumeCodexRolloutTimestamp(timestamps, item.type);
};
