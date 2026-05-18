import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject
} from "react";

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

type ManualViewportIntent = {
  sessionId?: string;
  type: "manual";
};

type PrependViewportIntent = PendingPrependScroll & {
  type: "prepend";
};

type ViewportIntent =
  | ManualViewportIntent
  | PendingViewportTarget
  | PrependViewportIntent;

export type TranscriptViewportController = {
  transcriptRef: RefObject<HTMLElement | null>;
  transcriptContentRef: RefObject<HTMLDivElement | null>;
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
  const transcriptContentRef = useRef<HTMLDivElement | null>(null);
  const displayedSessionIdRef = useRef<string | undefined>(undefined);
  const isOpeningSelectedSessionRef = useRef(false);
  const viewportIntentRef = useRef<ViewportIntent | undefined>(undefined);
  const pendingApplyFrameRef = useRef<number | undefined>(undefined);
  const isApplyingProgrammaticScrollRef = useRef(false);
  const programmaticScrollFrameRef = useRef<number | undefined>(undefined);

  displayedSessionIdRef.current = input.displayedSessionId;
  isOpeningSelectedSessionRef.current = input.isOpeningSelectedSession;

  const clearProgrammaticScrollAfterFrame = useCallback(() => {
    if (programmaticScrollFrameRef.current !== undefined) {
      window.cancelAnimationFrame(programmaticScrollFrameRef.current);
    }
    programmaticScrollFrameRef.current = window.requestAnimationFrame(() => {
      isApplyingProgrammaticScrollRef.current = false;
      programmaticScrollFrameRef.current = undefined;
    });
  }, []);

  const runProgrammaticScroll = useCallback(
    (scroll: () => void) => {
      isApplyingProgrammaticScrollRef.current = true;
      scroll();
      clearProgrammaticScrollAfterFrame();
    },
    [clearProgrammaticScrollAfterFrame]
  );

  const applyViewportIntent = useCallback(() => {
    pendingApplyFrameRef.current = undefined;
    const element = transcriptRef.current;
    const displayedSessionId = displayedSessionIdRef.current;
    const intent = viewportIntentRef.current;
    if (
      !element ||
      !displayedSessionId ||
      !intent ||
      isOpeningSelectedSessionRef.current
    ) {
      return;
    }
    if (intent.sessionId && intent.sessionId !== displayedSessionId) {
      return;
    }

    if (intent.type === "manual") {
      return;
    }

    if (intent.type === "prepend") {
      viewportIntentRef.current = {
        sessionId: displayedSessionId,
        type: "manual"
      };
      runProgrammaticScroll(() => {
        element.scrollTop =
          element.scrollHeight -
          intent.previousScrollHeight +
          intent.previousScrollTop;
      });
      return;
    }

    if (intent.type === "turn" && intent.turnId) {
      const targetRow = queryTurnRow(element, intent.turnId);
      if (targetRow) {
        runProgrammaticScroll(() => {
          targetRow.scrollIntoView({
            block: "start"
          });
        });
        return;
      }
    }

    runProgrammaticScroll(() => {
      scrollTranscriptToBottom(element);
    });
  }, [runProgrammaticScroll]);

  const scheduleViewportApply = useCallback(() => {
    if (pendingApplyFrameRef.current !== undefined) {
      return;
    }
    pendingApplyFrameRef.current = window.requestAnimationFrame(() => {
      applyViewportIntent();
    });
  }, [applyViewportIntent]);

  useEffect(
    () => () => {
      if (pendingApplyFrameRef.current !== undefined) {
        window.cancelAnimationFrame(pendingApplyFrameRef.current);
      }
      if (programmaticScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(programmaticScrollFrameRef.current);
      }
    },
    []
  );

  useEffect(() => {
    const element = transcriptRef.current;
    if (!element) {
      return;
    }

    const updateViewportIntentFromScroll = (): void => {
      if (isApplyingProgrammaticScrollRef.current) {
        return;
      }
      viewportIntentRef.current = resolveTranscriptScrollIntent({
        displayedSessionId: displayedSessionIdRef.current,
        isNearBottom: isTranscriptNearBottom(element)
      });
    };

    if (!viewportIntentRef.current) {
      updateViewportIntentFromScroll();
    }
    element.addEventListener("scroll", updateViewportIntentFromScroll, {
      passive: true
    });
    return () => {
      element.removeEventListener("scroll", updateViewportIntentFromScroll);
    };
  }, [input.displayedSessionId]);

  useEffect(() => {
    const contentElement = transcriptContentRef.current;
    if (!contentElement || typeof ResizeObserver === "undefined") {
      return;
    }
    const resizeObserver = new ResizeObserver(() => {
      scheduleViewportApply();
    });
    resizeObserver.observe(contentElement);
    return () => resizeObserver.disconnect();
  }, [input.displayedSessionId, scheduleViewportApply]);

  useLayoutEffect(() => {
    scheduleViewportApply();
  }, [
    input.displayedSessionId,
    input.isOpeningSelectedSession,
    input.windowStartTurnId,
    input.windowEndTurnId,
    input.renderedTranscriptRowCount,
    input.transcriptContentVersion,
    scheduleViewportApply
  ]);

  return {
    transcriptRef,
    transcriptContentRef,
    displayedSessionIdRef,
    setDisplayedSessionIdRef: (sessionId: string | undefined) => {
      displayedSessionIdRef.current = sessionId;
    },
    queuePrependScrollRestore: (next) => {
      viewportIntentRef.current = {
        ...next,
        type: "prepend"
      };
      scheduleViewportApply();
    },
    queueViewportTarget: (next) => {
      viewportIntentRef.current = next;
      scheduleViewportApply();
    },
    scrollToBottom: (sessionId, options = {}) => {
      const request = resolveTranscriptBottomRequest({
        sessionId: sessionId ?? displayedSessionIdRef.current,
        displayedSessionId: displayedSessionIdRef.current,
        allowPendingForInactive: options.allowPendingForInactive
      });
      if (request.pending) {
        viewportIntentRef.current = request.pending;
        scheduleViewportApply();
        return;
      }
      if (!request.immediate) {
        return;
      }
      viewportIntentRef.current = request.immediate;
      scheduleViewportApply();
    },
    clearPendingViewportState: () => {
      viewportIntentRef.current = undefined;
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

export const resolveTranscriptScrollIntent = (input: {
  displayedSessionId: string | undefined;
  isNearBottom: boolean;
}): ManualViewportIntent | PendingViewportTarget => {
  if (input.isNearBottom && input.displayedSessionId) {
    return {
      sessionId: input.displayedSessionId,
      type: "bottom"
    };
  }
  return {
    sessionId: input.displayedSessionId,
    type: "manual"
  };
};

const queryTurnRow = (
  element: HTMLElement,
  turnId: string
): HTMLElement | null => {
  const escapedTurnId =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(turnId)
      : turnId.replace(/"/g, '\\"');
  return element.querySelector<HTMLElement>(
    `[data-turn-id="${escapedTurnId}"]`
  );
};

const scrollTranscriptToBottom = (element: HTMLElement): void => {
  element.scrollTop = element.scrollHeight;
};
