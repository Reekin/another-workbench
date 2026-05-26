import type { TakeoverSessionStateRpc } from "@another-workbench/shared";

export type TakeoverStateRequestState = {
  sessionId: string | undefined;
  inFlight: boolean;
  dirty: boolean;
  generation: number;
};

export const createTakeoverStateRequestState = (): TakeoverStateRequestState => ({
  sessionId: undefined,
  inFlight: false,
  dirty: false,
  generation: 0
});

export const resolveCurrentTakeoverState = (
  takeoverState: TakeoverSessionStateRpc | undefined,
  activeSessionId: string | undefined
): TakeoverSessionStateRpc | undefined =>
  takeoverState && takeoverState.sessionId === activeSessionId
    ? takeoverState
    : undefined;

export const resetTakeoverStateRequests = (
  requestState: TakeoverStateRequestState
): void => {
  requestState.sessionId = undefined;
  requestState.inFlight = false;
  requestState.dirty = false;
  requestState.generation += 1;
};

export const invalidateTakeoverStateRequestsForSession = (
  requestState: TakeoverStateRequestState,
  sessionId: string
): void => {
  requestState.sessionId = sessionId;
  requestState.inFlight = false;
  requestState.dirty = false;
  requestState.generation += 1;
};

export const beginTakeoverStateRequest = (
  requestState: TakeoverStateRequestState,
  sessionId: string
): number | undefined => {
  if (requestState.sessionId !== sessionId) {
    invalidateTakeoverStateRequestsForSession(requestState, sessionId);
  }
  if (requestState.inFlight) {
    requestState.dirty = true;
    return undefined;
  }
  requestState.inFlight = true;
  requestState.dirty = false;
  return requestState.generation;
};

export const canCommitTakeoverStateRequest = (
  requestState: TakeoverStateRequestState,
  sessionId: string,
  generation: number
): boolean =>
  requestState.sessionId === sessionId &&
  requestState.generation === generation;

export const finishTakeoverStateRequest = (
  requestState: TakeoverStateRequestState,
  sessionId: string,
  generation: number
): boolean => {
  if (!canCommitTakeoverStateRequest(requestState, sessionId, generation)) {
    return false;
  }
  requestState.inFlight = false;
  return requestState.dirty;
};
