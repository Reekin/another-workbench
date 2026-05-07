import type { ReactElement } from "react";
import type { TerminalStream, ToolCall } from "@another-workbench/shared";
import { normalizeTerminalOutput } from "./terminal-output.js";

export type ProcessActivityViewProps = {
  toolCalls: ToolCall[];
  terminalStreams: TerminalStream[];
};

export type ProcessActivityEntry = {
  id: string;
  startedAt?: string;
  label: string;
  summary: string;
  status: ToolCall["status"] | TerminalStream["status"];
  inputText?: string;
  outputText?: string;
  terminalStreams: TerminalStream[];
};

const truncateInline = (value: string, maxLength = 180): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;

const firstUsefulLine = (value: string | undefined): string | undefined =>
  value
    ?.split(/\r?\n/g)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

const compareIsoDateAsc = (left?: string, right?: string): number => {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }
  const leftDate = Date.parse(left);
  const rightDate = Date.parse(right);
  if (Number.isNaN(leftDate) || Number.isNaN(rightDate)) {
    return left.localeCompare(right);
  }
  return leftDate - rightDate;
};

const statusLabel = (entry: ProcessActivityEntry): string => {
  const exitCodes = entry.terminalStreams
    .map((stream) => stream.exitCode)
    .filter((exitCode): exitCode is number => typeof exitCode === "number");
  const exitCode = exitCodes.at(-1);
  if (
    (entry.status === "completed" || entry.status === "failed") &&
    typeof exitCode === "number"
  ) {
    return `${entry.status} (exit ${exitCode})`;
  }
  return entry.status;
};

const displayToolName = (toolName: string): string => {
  switch (toolName) {
    case "commandExecution":
      return "Shell";
    case "contextCompaction":
      return "Compaction";
    case "reasoning":
      return "Reasoning";
    case "webSearch":
      return "Web search";
    default:
      return toolName;
  }
};

const buildToolSummary = (toolCall: ToolCall): string => {
  if (toolCall.toolName === "contextCompaction") {
    return toolCall.status === "completed"
      ? (toolCall.outputSummary ?? "compaction finished")
      : (toolCall.inputSummary ?? "compacting...");
  }
  const input = firstUsefulLine(toolCall.inputSummary);
  const label = displayToolName(toolCall.toolName);
  return input && input.toLocaleLowerCase() !== label.toLocaleLowerCase()
    ? `${label} ${input}`
    : label;
};

const buildTerminalSummary = (stream: TerminalStream): string => {
  const output = firstUsefulLine(normalizeTerminalOutput(stream.outputText));
  return output ? `Terminal ${output}` : `Terminal ${stream.terminalId}`;
};

const mergeStatus = (
  toolCall: ToolCall,
  terminalStreams: TerminalStream[]
): ProcessActivityEntry["status"] => {
  const failedTerminal = terminalStreams.find((stream) => stream.status === "failed");
  if (failedTerminal) {
    return "failed";
  }
  const runningTerminal = terminalStreams.find((stream) => stream.status === "running");
  if (runningTerminal) {
    return "running";
  }
  return toolCall.status;
};

export const buildProcessActivityEntries = (
  toolCalls: ToolCall[],
  terminalStreams: TerminalStream[]
): ProcessActivityEntry[] => {
  const streamsByToolCallId = new Map<string, TerminalStream[]>();
  const standaloneStreams: TerminalStream[] = [];

  for (const stream of terminalStreams) {
    if (stream.toolCallId) {
      const group = streamsByToolCallId.get(stream.toolCallId) ?? [];
      group.push(stream);
      streamsByToolCallId.set(stream.toolCallId, group);
      continue;
    }
    standaloneStreams.push(stream);
  }

  const toolIds = new Set(toolCalls.map((toolCall) => toolCall.toolCallId));
  const toolEntries = toolCalls.map((toolCall) => {
    const linkedStreams = streamsByToolCallId.get(toolCall.toolCallId) ?? [];
    const terminalOutput = linkedStreams
      .map((stream) => normalizeTerminalOutput(stream.outputText))
      .filter((value) => value.length > 0)
      .join("\n\n");
    return {
      id: `tool:${toolCall.toolCallId}`,
      startedAt: toolCall.startedAt,
      label: displayToolName(toolCall.toolName),
      summary: buildToolSummary(toolCall),
      status: mergeStatus(toolCall, linkedStreams),
      inputText: toolCall.inputSummary,
      outputText: terminalOutput || toolCall.outputSummary,
      terminalStreams: linkedStreams
    };
  });

  const orphanLinkedStreams = Array.from(streamsByToolCallId.entries())
    .filter(([toolCallId]) => !toolIds.has(toolCallId))
    .flatMap(([, streams]) => streams);
  const terminalEntries = [...standaloneStreams, ...orphanLinkedStreams].map((stream) => ({
    id: `terminal:${stream.terminalId}`,
    startedAt: stream.startedAt,
    label: "Terminal",
    summary: buildTerminalSummary(stream),
    status: stream.status,
    inputText: undefined,
    outputText: normalizeTerminalOutput(stream.outputText),
    terminalStreams: [stream]
  }));

  return [...toolEntries, ...terminalEntries].sort((left, right) => {
    const byDate = compareIsoDateAsc(left.startedAt, right.startedAt);
    if (byDate !== 0) {
      return byDate;
    }
    return left.id.localeCompare(right.id);
  });
};

export const ProcessActivityItemView = ({
  entry
}: {
  entry: ProcessActivityEntry;
}): ReactElement => {
  const rawOutputText = entry.outputText?.trim();
  const inputText = entry.inputText?.trim();
  const outputText = rawOutputText && rawOutputText !== inputText ? rawOutputText : undefined;
  return (
    <details
      key={entry.id}
      className="awb-process-activity"
      open={entry.status === "running"}
    >
      <summary className="awb-process-activity__summary">
        <span className="awb-process-activity__title">
          {truncateInline(entry.summary)}
        </span>
        <span className={`awb-process-activity__status is-${entry.status}`}>
          {statusLabel(entry)}
        </span>
      </summary>
      <div className="awb-process-activity__body">
        <div className="awb-process-activity__meta">
          <span>{entry.label}</span>
          {inputText ? <code>{inputText}</code> : <code>(no parameters)</code>}
        </div>
        {outputText || entry.status === "running" ? (
          <pre className="awb-process-activity__output">
            {outputText || "(no output yet)"}
          </pre>
        ) : null}
      </div>
    </details>
  );
};

export const ProcessActivityView = ({
  toolCalls,
  terminalStreams
}: ProcessActivityViewProps): ReactElement => {
  const entries = buildProcessActivityEntries(toolCalls, terminalStreams);

  if (entries.length === 0) {
    return <p className="awb-detail__empty">No activity in this turn.</p>;
  }

  return (
    <div className="awb-process-activity-list">
      {entries.map((entry) => (
        <ProcessActivityItemView key={entry.id} entry={entry} />
      ))}
    </div>
  );
};
