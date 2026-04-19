import { useEffect, useRef, type RefObject } from "react";

type PendingPrependScroll = {
  sessionId: string;
  previousScrollHeight: number;
  previousScrollTop: number;
};

type PendingViewportTarget = {
  sessionId: string;
  type: "bottom" | "turn";
  turnId?: string;
};

export type TranscriptViewportController = {
  transcriptRef: RefObject<HTMLElement | null>;
  displayedSessionIdRef: RefObject<string | undefined>;
  setDisplayedSessionIdRef: (sessionId: string | undefined) => void;
  queuePrependScrollRestore: (input: PendingPrependScroll) => void;
  queueViewportTarget: (input: PendingViewportTarget | undefined) => void;
  clearPendingViewportState: () => void;
};

export const useTranscriptViewportController = (input: {
  displayedSessionId: string | undefined;
  isOpeningSelectedSession: boolean;
  windowStartTurnId?: string;
  windowEndTurnId?: string;
  renderedTranscriptRowCount: number;
}): TranscriptViewportController => {
  const transcriptRef = useRef<HTMLElement | null>(null);
  const displayedSessionIdRef = useRef<string | undefined>(undefined);
  const pendingPrependScrollRef = useRef<PendingPrependScroll | undefined>(
    undefined
  );
  const pendingViewportTargetRef = useRef<PendingViewportTarget | undefined>(
    undefined
  );

  useEffect(() => {
    displayedSessionIdRef.current = input.displayedSessionId;
  }, [input.displayedSessionId]);

  useEffect(() => {
    const pending = pendingPrependScrollRef.current;
    const element = transcriptRef.current;
    if (
      !pending ||
      !element ||
      input.displayedSessionId !== pending.sessionId ||
      input.isOpeningSelectedSession
    ) {
      return;
    }
    pendingPrependScrollRef.current = undefined;
    const animationFrameId = window.requestAnimationFrame(() => {
      element.scrollTop =
        element.scrollHeight -
        pending.previousScrollHeight +
        pending.previousScrollTop;
    });
    return () => window.cancelAnimationFrame(animationFrameId);
  }, [
    input.displayedSessionId,
    input.isOpeningSelectedSession,
    input.windowStartTurnId
  ]);

  useEffect(() => {
    const pendingTarget = pendingViewportTargetRef.current;
    const element = transcriptRef.current;
    if (
      !pendingTarget ||
      !element ||
      input.displayedSessionId !== pendingTarget.sessionId ||
      input.isOpeningSelectedSession
    ) {
      return;
    }

    pendingViewportTargetRef.current = undefined;
    const animationFrameId = window.requestAnimationFrame(() => {
      if (pendingTarget.type === "turn" && pendingTarget.turnId) {
        const targetRow = element.querySelector<HTMLElement>(
          `[data-turn-id="${pendingTarget.turnId}"]`
        );
        if (targetRow) {
          targetRow.scrollIntoView({
            block: "start"
          });
          return;
        }
      }
      element.scrollTop = element.scrollHeight;
    });

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [
    input.displayedSessionId,
    input.isOpeningSelectedSession,
    input.windowEndTurnId,
    input.renderedTranscriptRowCount
  ]);

  return {
    transcriptRef,
    displayedSessionIdRef,
    setDisplayedSessionIdRef: (sessionId: string | undefined) => {
      displayedSessionIdRef.current = sessionId;
    },
    queuePrependScrollRestore: (next) => {
      pendingPrependScrollRef.current = next;
    },
    queueViewportTarget: (next) => {
      pendingViewportTargetRef.current = next;
    },
    clearPendingViewportState: () => {
      pendingPrependScrollRef.current = undefined;
      pendingViewportTargetRef.current = undefined;
    }
  };
};
