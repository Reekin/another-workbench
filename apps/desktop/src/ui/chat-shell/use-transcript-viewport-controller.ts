import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject
} from "react";

const STICKY_BOTTOM_THRESHOLD_PX = 96;
const USER_SCROLL_INPUT_GRACE_MS = 500;
const TOUCH_SCROLL_DIRECTION_THRESHOLD_PX = 4;

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
  const userScrollInputExpiresAtRef = useRef(0);
  const followTailInterruptExpiresAtRef = useRef(0);
  const touchLastYRef = useRef<number | undefined>(undefined);
  const isPointerScrollbarDragRef = useRef(false);

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
      const nextScrollTop = resolvePrependScrollTop({
        scrollHeight: element.scrollHeight,
        previousScrollHeight: intent.previousScrollHeight,
        previousScrollTop: intent.previousScrollTop
      });
      if (nextScrollTop === undefined) {
        return;
      }
      viewportIntentRef.current = {
        sessionId: displayedSessionId,
        type: "manual"
      };
      runProgrammaticScroll(() => {
        element.scrollTop = nextScrollTop;
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
    userScrollInputExpiresAtRef.current = 0;
    followTailInterruptExpiresAtRef.current = 0;
    touchLastYRef.current = undefined;
    isPointerScrollbarDragRef.current = false;

    const updateViewportIntentFromScroll = (): void => {
      const now = performance.now();
      const hasRecentUserScrollInput = userScrollInputExpiresAtRef.current >= now;
      if (
        !shouldUpdateViewportIntentFromScroll({
          isApplyingProgrammaticScroll: isApplyingProgrammaticScrollRef.current,
          hasRecentUserScrollInput,
          hasPendingPrependRestore: viewportIntentRef.current?.type === "prepend"
        })
      ) {
        return;
      }
      const nextIntent = resolveTranscriptScrollIntent({
        displayedSessionId: displayedSessionIdRef.current,
        isNearBottom: isTranscriptNearBottom(element)
      });
      if (
        shouldPreserveManualIntentDuringScroll({
          hasRecentFollowTailInterrupt:
            followTailInterruptExpiresAtRef.current >= now,
          nextIntentType: nextIntent.type === "bottom" ? "bottom" : "manual"
        })
      ) {
        return;
      }
      viewportIntentRef.current = nextIntent;
    };
    const markUserScrollInput = (options: { interruptFollowTail?: boolean } = {}): void => {
      const now = performance.now();
      userScrollInputExpiresAtRef.current = now + USER_SCROLL_INPUT_GRACE_MS;
      if (!options.interruptFollowTail) {
        followTailInterruptExpiresAtRef.current = 0;
        return;
      }
      followTailInterruptExpiresAtRef.current = now + USER_SCROLL_INPUT_GRACE_MS;
      viewportIntentRef.current = {
        sessionId: displayedSessionIdRef.current,
        type: "manual"
      };
    };
    const markWheelScrollInput = (event: WheelEvent): void => {
      if (event.deltaY === 0) {
        return;
      }
      markUserScrollInput({
        interruptFollowTail: shouldInterruptFollowTailForWheelScroll(event.deltaY)
      });
    };
    const markTouchScrollStart = (event: TouchEvent): void => {
      touchLastYRef.current = event.touches[0]?.clientY;
    };
    const markTouchScrollInput = (event: TouchEvent): void => {
      const nextY = event.touches[0]?.clientY;
      const previousY = touchLastYRef.current;
      touchLastYRef.current = nextY;
      if (nextY === undefined || previousY === undefined) {
        return;
      }
      const deltaY = nextY - previousY;
      if (Math.abs(deltaY) < TOUCH_SCROLL_DIRECTION_THRESHOLD_PX) {
        return;
      }
      markUserScrollInput({
        interruptFollowTail: shouldInterruptFollowTailForTouchScroll(deltaY)
      });
    };
    const clearTouchScrollInput = (): void => {
      touchLastYRef.current = undefined;
    };
    const markKeyboardScrollInput = (event: KeyboardEvent): void => {
      if (
        isInteractiveKeyboardTarget(event.target) ||
        !isTranscriptScrollInputKey(event.key)
      ) {
        return;
      }
      markUserScrollInput({
        interruptFollowTail: shouldInterruptFollowTailForKeyboardScroll({
          key: event.key,
          shiftKey: event.shiftKey
        })
      });
    };
    const markPointerScrollbarDragStart = (event: PointerEvent): void => {
      if (!isPointerNearVerticalScrollbar(element, event)) {
        return;
      }
      isPointerScrollbarDragRef.current = true;
      markUserScrollInput({
        interruptFollowTail: true
      });
    };
    const markPointerDragScrollInput = (event: PointerEvent): void => {
      if (isPointerScrollbarDragRef.current && event.buttons !== 0) {
        markUserScrollInput();
      }
    };
    const clearPointerScrollbarDrag = (): void => {
      isPointerScrollbarDragRef.current = false;
    };

    if (!viewportIntentRef.current) {
      updateViewportIntentFromScroll();
    }
    element.addEventListener("wheel", markWheelScrollInput, {
      passive: true
    });
    element.addEventListener("touchstart", markTouchScrollStart, {
      passive: true
    });
    element.addEventListener("touchmove", markTouchScrollInput, {
      passive: true
    });
    element.addEventListener("touchend", clearTouchScrollInput, {
      passive: true
    });
    element.addEventListener("touchcancel", clearTouchScrollInput, {
      passive: true
    });
    element.addEventListener("pointerdown", markPointerScrollbarDragStart, {
      passive: true
    });
    element.addEventListener("pointermove", markPointerDragScrollInput, {
      passive: true
    });
    element.addEventListener("pointerup", clearPointerScrollbarDrag, {
      passive: true
    });
    element.addEventListener("pointercancel", clearPointerScrollbarDrag, {
      passive: true
    });
    element.addEventListener("keydown", markKeyboardScrollInput);
    element.addEventListener("scroll", updateViewportIntentFromScroll, {
      passive: true
    });
    return () => {
      element.removeEventListener("wheel", markWheelScrollInput);
      element.removeEventListener("touchstart", markTouchScrollStart);
      element.removeEventListener("touchmove", markTouchScrollInput);
      element.removeEventListener("touchend", clearTouchScrollInput);
      element.removeEventListener("touchcancel", clearTouchScrollInput);
      element.removeEventListener("pointerdown", markPointerScrollbarDragStart);
      element.removeEventListener("pointermove", markPointerDragScrollInput);
      element.removeEventListener("pointerup", clearPointerScrollbarDrag);
      element.removeEventListener("pointercancel", clearPointerScrollbarDrag);
      element.removeEventListener("keydown", markKeyboardScrollInput);
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
      userScrollInputExpiresAtRef.current = 0;
      followTailInterruptExpiresAtRef.current = 0;
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

export const resolvePrependScrollTop = (input: {
  scrollHeight: number;
  previousScrollHeight: number;
  previousScrollTop: number;
}): number | undefined => {
  if (input.scrollHeight <= input.previousScrollHeight) {
    return undefined;
  }
  return input.scrollHeight - input.previousScrollHeight + input.previousScrollTop;
};

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

export const shouldUpdateViewportIntentFromScroll = (input: {
  isApplyingProgrammaticScroll: boolean;
  hasRecentUserScrollInput: boolean;
  hasPendingPrependRestore?: boolean;
}): boolean =>
  !input.hasPendingPrependRestore &&
  (!input.isApplyingProgrammaticScroll || input.hasRecentUserScrollInput);

export const shouldPreserveManualIntentDuringScroll = (input: {
  hasRecentFollowTailInterrupt: boolean;
  nextIntentType: "bottom" | "manual";
}): boolean =>
  input.hasRecentFollowTailInterrupt &&
  input.nextIntentType === "bottom";

export const isTranscriptScrollInputKey = (key: string): boolean =>
  key === "ArrowUp" ||
  key === "ArrowDown" ||
  key === "PageUp" ||
  key === "PageDown" ||
  key === "Home" ||
  key === "End" ||
  key === " ";

export const shouldInterruptFollowTailForWheelScroll = (deltaY: number): boolean =>
  deltaY < 0;

export const shouldInterruptFollowTailForTouchScroll = (
  touchClientYDelta: number
): boolean => touchClientYDelta > 0;

export const shouldInterruptFollowTailForKeyboardScroll = (input: {
  key: string;
  shiftKey?: boolean;
}): boolean =>
  input.key === "ArrowUp" ||
  input.key === "PageUp" ||
  input.key === "Home" ||
  (input.key === " " && input.shiftKey === true);

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

const isInteractiveKeyboardTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    tagName === "button" ||
    tagName === "a" ||
    target.isContentEditable ||
    target.closest(
      "button,a,input,textarea,select,[contenteditable='true'],[role='button'],[role='link'],[role='menuitem'],[role='tab']"
    ) !== null
  );
};

const isPointerNearVerticalScrollbar = (
  element: HTMLElement,
  event: PointerEvent
): boolean => {
  if (event.pointerType !== "mouse") {
    return false;
  }
  const scrollbarWidth = element.offsetWidth - element.clientWidth;
  if (scrollbarWidth <= 0) {
    return false;
  }
  const bounds = element.getBoundingClientRect();
  return event.clientX >= bounds.right - scrollbarWidth;
};
