import type { EventBacklogPressure } from "../../transport/desktop-transport.js";

export type AutoRefreshBacklogDecisionInput = {
  pressure: EventBacklogPressure;
  displayedSessionId?: string;
  visibilityState?: DocumentVisibilityState;
  nowMs: number;
  lastRefreshStartedAtMs?: number;
  refreshInFlight?: boolean;
  cooldownMs: number;
  streamThreshold: number;
};

export type AutoRefreshBacklogDecision = {
  sessionId: string;
};

export type AutoRefreshBacklogAttemptInput = Omit<
  AutoRefreshBacklogDecisionInput,
  "pressure"
> & {
  incomingPressure?: EventBacklogPressure;
  pendingPressure?: EventBacklogPressure;
};

export type AutoRefreshBacklogAttemptResult = {
  decision?: AutoRefreshBacklogDecision;
  pendingPressure?: EventBacklogPressure;
};

const isDisplayedSessionPressureEligible = (input: {
  pressure: EventBacklogPressure;
  displayedSessionId?: string;
  streamThreshold: number;
}): boolean => {
  if (!input.displayedSessionId) {
    return false;
  }
  const sessionPressure = input.pressure.sessions[input.displayedSessionId];
  return Boolean(
    sessionPressure &&
      sessionPressure.streamPendingCount >= input.streamThreshold
  );
};

export const resolveAutoRefreshBacklogDecision = (
  input: AutoRefreshBacklogDecisionInput
): AutoRefreshBacklogDecision | undefined => {
  if (
    !input.displayedSessionId ||
    input.visibilityState === "hidden" ||
    input.refreshInFlight
  ) {
    return undefined;
  }
  const elapsedSinceRefresh =
    input.lastRefreshStartedAtMs === undefined
      ? Number.POSITIVE_INFINITY
      : input.nowMs - input.lastRefreshStartedAtMs;
  if (elapsedSinceRefresh < input.cooldownMs) {
    return undefined;
  }
  const sessionPressure = input.pressure.sessions[input.displayedSessionId];
  if (
    !sessionPressure ||
    sessionPressure.streamPendingCount < input.streamThreshold
  ) {
    return undefined;
  }
  return {
    sessionId: input.displayedSessionId
  };
};

export const resolveAutoRefreshBacklogAttempt = (
  input: AutoRefreshBacklogAttemptInput
): AutoRefreshBacklogAttemptResult => {
  const incomingPressureIsEligible =
    input.incomingPressure !== undefined &&
    isDisplayedSessionPressureEligible({
      pressure: input.incomingPressure,
      displayedSessionId: input.displayedSessionId,
      streamThreshold: input.streamThreshold
    });
  const pendingPressureIsEligible =
    input.pendingPressure !== undefined &&
    isDisplayedSessionPressureEligible({
      pressure: input.pendingPressure,
      displayedSessionId: input.displayedSessionId,
      streamThreshold: input.streamThreshold
    });
  const pressure = incomingPressureIsEligible
    ? input.incomingPressure
    : pendingPressureIsEligible
      ? input.pendingPressure
      : undefined;
  if (!pressure) {
    return {};
  }
  const decision = resolveAutoRefreshBacklogDecision({
    ...input,
    pressure
  });
  if (!decision) {
    return { pendingPressure: pressure };
  }
  return { decision };
};
