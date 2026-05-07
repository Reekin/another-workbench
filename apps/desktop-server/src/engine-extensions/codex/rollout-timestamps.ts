import { readFile } from "node:fs/promises";
import type { ThreadItem } from "../../codex-app-server-generated/v2/ThreadItem.js";

export type CodexRolloutTimestampedItem = {
  type: ThreadItem["type"];
  timestamp: string;
};

export type CodexRolloutTimestampGroup = {
  turnId: string;
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
    return undefined;
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

const pushRolloutTimestamp = (
  group: CodexRolloutTimestampGroup,
  item: CodexRolloutTimestampedItem
): void => {
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
  let text: string;
  try {
    text = await readFile(rolloutPath, "utf8");
  } catch {
    return [];
  }

  const groups: CodexRolloutTimestampGroup[] = [];
  let currentGroup: CodexRolloutTimestampGroup | undefined;
  for (const line of text.split(/\r?\n/)) {
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
    if (entry.type === "event_msg" && payload.type === "task_started") {
      const turnId = readString(payload.turn_id) ?? `rollout-turn:${groups.length}`;
      currentGroup = { turnId, items: [] };
      groups.push(currentGroup);
      continue;
    }
    if (!currentGroup) {
      continue;
    }
    const timestamp = normalizeCodexTimestamp(entry.timestamp);
    if (!timestamp) {
      continue;
    }
    const itemType = resolveRolloutTimestampedItemType(entry.type, payload);
    if (itemType) {
      pushRolloutTimestamp(currentGroup, { type: itemType, timestamp });
    }
  }
  return groups;
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
