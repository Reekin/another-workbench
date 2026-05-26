import { describe, expect, it } from "vitest";
import type { TakeoverSessionStateRpc } from "@another-workbench/shared";
import {
  beginTakeoverStateRequest,
  canCommitTakeoverStateRequest,
  createTakeoverStateRequestState,
  finishTakeoverStateRequest,
  invalidateTakeoverStateRequestsForSession,
  resolveCurrentTakeoverState
} from "../src/ui/chat-shell/takeover-state-controller.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
};

describe("takeover state request controller", () => {
  it("prevents an older getState response from overwriting a newer manual state", async () => {
    const requestState = createTakeoverStateRequestState();
    const pendingGetState = createDeferred<TakeoverSessionStateRpc>();
    let committedState: TakeoverSessionStateRpc | undefined;

    const readGeneration = beginTakeoverStateRequest(requestState, "session-1");
    expect(readGeneration).toBeDefined();
    if (readGeneration === undefined) {
      return;
    }

    const readCommit = pendingGetState.promise
      .then((stateResult) => {
        if (
          canCommitTakeoverStateRequest(
            requestState,
            "session-1",
            readGeneration
          )
        ) {
          committedState = resolveCurrentTakeoverState(stateResult, "session-1");
        }
      })
      .finally(() => {
        finishTakeoverStateRequest(requestState, "session-1", readGeneration);
      });

    const manualState = {
      sessionId: "session-1",
      role: "managed",
      active: true,
      presetId: "review-next",
      context: "new context"
    } satisfies TakeoverSessionStateRpc;

    await Promise.resolve(manualState).then((stateResult) => {
      invalidateTakeoverStateRequestsForSession(requestState, "session-1");
      committedState = resolveCurrentTakeoverState(stateResult, "session-1");
    });

    expect(committedState).toEqual(manualState);

    pendingGetState.resolve({
      sessionId: "session-1",
      role: "managed",
      active: false,
      presetId: "review-old",
      context: "old context"
    });
    await readCommit;

    expect(committedState).toEqual(manualState);
  });
});
