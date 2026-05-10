import { useEffect, useRef, type RefObject } from "react";

const STICKY_BOTTOM_THRESHOLD_PX = 96;

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
  scrollToBottom: (
    sessionId?: string,
    options?: { allowPendingForInactive?: boolean }
  ) => void;
  clearPendingViewportState: () => void;
};

export const useTranscriptViewportController = (input: {
  displayedSessionId: string | undefined;
  isOpeningSelectedSession: boolean;
  windowStartTurnId?: string;
  windowEndTurnId?: string;
  renderedTranscriptRowCount: number;
  transcriptContentVersion: string;
}): TranscriptViewportController => {
  const transcriptRef = useRef<HTMLElement | null>(null);
  const displayedSessionIdRef = useRef<string | undefined>(undefined);
  const isStickyToBottomRef = useRef(true);
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
    const element = transcriptRef.current;
    if (!element) {
      return;
    }

    const updateStickyState = (): void => {
      isStickyToBottomRef.current = isTranscriptNearBottom(element);
    };

    updateStickyState();
    element.addEventListener("scroll", updateStickyState, { passive: true });
    return () => {
      element.removeEventListener("scroll", updateStickyState);
    };
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
    isStickyToBottomRef.current = false;
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
    isStickyToBottomRef.current = pendingTarget.type === "bottom";
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
      scrollTranscriptToBottom(element);
    });

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [
    input.displayedSessionId,
    input.isOpeningSelectedSession,
    input.windowEndTurnId,
    input.renderedTranscriptRowCount
  ]);

  useEffect(() => {
    const element = transcriptRef.current;
    if (
      !element ||
      input.isOpeningSelectedSession ||
      pendingPrependScrollRef.current ||
      pendingViewportTargetRef.current ||
      !isStickyToBottomRef.current
    ) {
      return;
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      if (isStickyToBottomRef.current) {
        scrollTranscriptToBottom(element);
      }
    });

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [
    input.displayedSessionId,
    input.isOpeningSelectedSession,
    input.windowEndTurnId,
    input.renderedTranscriptRowCount,
    input.transcriptContentVersion
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
    scrollToBottom: (sessionId, options = {}) => {
      const request = resolveTranscriptBottomRequest({
        sessionId: sessionId ?? displayedSessionIdRef.current,
        displayedSessionId: displayedSessionIdRef.current,
        allowPendingForInactive: options.allowPendingForInactive
      });
      if (request.pending) {
        pendingViewportTargetRef.current = request.pending;
        return;
      }
      if (!request.immediate) {
        return;
      }
      pendingViewportTargetRef.current = undefined;
      isStickyToBottomRef.current = true;
      const element = transcriptRef.current;
      if (!element) {
        return;
      }
      const target = request.immediate;
      window.requestAnimationFrame(() => {
        if (displayedSessionIdRef.current === target.sessionId) {
          scrollTranscriptToBottom(element);
        }
      });
    },
    clearPendingViewportState: () => {
      pendingPrependScrollRef.current = undefined;
      pendingViewportTargetRef.current = undefined;
    }
  };
};

export const createTranscriptBottomTarget = (
  sessionId: string | undefined
): PendingViewportTarget | undefined =>
  sessionId
    ? {
        sessionId,
        type: "bottom"
      }
    : undefined;

export const resolveTranscriptBottomRequest = (input: {
  sessionId: string | undefined;
  displayedSessionId: string | undefined;
  allowPendingForInactive?: boolean;
}): {
  immediate?: PendingViewportTarget;
  pending?: PendingViewportTarget;
} => {
  const target = createTranscriptBottomTarget(input.sessionId);
  if (!target) {
    return {};
  }
  if (target.sessionId === input.displayedSessionId) {
    return {
      immediate: target
    };
  }
  return input.allowPendingForInactive
    ? {
        pending: target
      }
    : {};
};

export const isTranscriptNearBottom = (element: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean =>
  element.scrollHeight - element.scrollTop - element.clientHeight <=
  STICKY_BOTTOM_THRESHOLD_PX;

const scrollTranscriptToBottom = (element: HTMLElement): void => {
  element.scrollTop = element.scrollHeight;
};
