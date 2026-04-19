import { useDeferredValue, useEffect, useRef, type ReactElement } from "react";
import type { TerminalStream } from "@another-workbench/shared";
import { Terminal } from "xterm";
import { ParticipantIdentityBadge } from "./ParticipantIdentityBadge.js";
import {
  buildParticipantDirectory,
  type ParticipantDirectory,
  resolveParticipantIdentity
} from "./participant-directory.js";
import { normalizeTerminalOutput } from "./terminal-output.js";
import {
  computeTerminalOutputPatch,
  type TerminalOutputPatch
} from "./terminal-output-patch.js";

export type TerminalStreamViewProps = {
  terminalStreams: TerminalStream[];
  participantDirectory?: ParticipantDirectory;
};

const defaultDirectory = buildParticipantDirectory([]);

const statusText = (stream: TerminalStream): string => {
  if (
    (stream.status === "completed" || stream.status === "failed") &&
    typeof stream.exitCode === "number"
  ) {
    return `${stream.status} (exit ${stream.exitCode})`;
  }
  return stream.status;
};

export type { TerminalOutputPatch };
export { computeTerminalOutputPatch };

const TerminalViewport = ({
  outputText,
  accessibleText
}: {
  outputText: string;
  accessibleText: string;
}): ReactElement => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const appliedLengthRef = useRef(0);

  useEffect(() => {
    if (!hostRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: false,
      cursorStyle: "bar",
      disableStdin: true,
      fontFamily: '"JetBrains Mono", "Cascadia Code", monospace',
      fontSize: 12,
      rows: 8,
      theme: {
        background: "#142738",
        foreground: "#d8e7f4"
      }
    });

    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    appliedLengthRef.current = 0;

    return () => {
      terminal.dispose();
      terminalRef.current = null;
      appliedLengthRef.current = 0;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const patch = computeTerminalOutputPatch(appliedLengthRef.current, outputText);
    if (patch.shouldReset) {
      terminal.reset();
    }
    if (patch.writeText) {
      terminal.write(patch.writeText);
    }
    appliedLengthRef.current = patch.nextAppliedLength;
  }, [outputText]);

  return (
    <>
      <div ref={hostRef} className="awb-terminal-output" aria-hidden="true" />
      <pre className="awb-sr-only" aria-label="Terminal output text">
        {accessibleText}
      </pre>
    </>
  );
};

const TerminalStreamItem = ({
  stream,
  participantDirectory
}: {
  stream: TerminalStream;
  participantDirectory: ParticipantDirectory;
}): ReactElement => {
  const deferredOutput = useDeferredValue(stream.outputText);
  const normalized = normalizeTerminalOutput(deferredOutput);
  const identity = resolveParticipantIdentity(
    participantDirectory,
    stream.actor,
    stream.terminalId
  );

  return (
    <article key={stream.terminalId} className="awb-timeline-item awb-terminal-item">
      <header className="awb-timeline-item__header">
        <div className="awb-timeline-item__meta">
          <strong>{stream.terminalId}</strong>
          <ParticipantIdentityBadge identity={identity} compact />
        </div>
        <span className={`awb-badge is-${stream.status}`}>{statusText(stream)}</span>
      </header>
      <TerminalViewport
        outputText={deferredOutput}
        accessibleText={normalized || "(waiting for output...)"}
      />
      <details className="awb-timeline-item__detail">
        <summary>Plain Text Snapshot</summary>
        <pre>{normalized || "(waiting for output...)"}</pre>
      </details>
    </article>
  );
};

export const TerminalStreamView = ({
  terminalStreams,
  participantDirectory = defaultDirectory
}: TerminalStreamViewProps): ReactElement => {
  if (terminalStreams.length === 0) {
    return <p className="awb-detail__empty">No terminal stream in this turn.</p>;
  }

  return (
    <div className="awb-terminal-list">
      {terminalStreams.map((stream) => (
        <TerminalStreamItem
          key={stream.terminalId}
          stream={stream}
          participantDirectory={participantDirectory}
        />
      ))}
    </div>
  );
};
