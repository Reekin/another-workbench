import {
  createIngestEnvelopeAction,
  createIngestEnvelopesAction,
  createHydrateSnapshotAction,
  createIngestEventAction
} from "./intake.js";
import { rendererStoreReducer } from "./reducer.js";
import { createInitialRendererStoreState } from "./state.js";
import type { RendererStoreAction, RendererStoreState } from "./types.js";
import type {
  DomainSnapshot,
  EventEnvelope,
  RuntimeEvent
} from "@another-workbench/shared";

type Listener = (state: RendererStoreState, action: RendererStoreAction) => void;

export type RendererStore = {
  getState: () => RendererStoreState;
  dispatch: (action: RendererStoreAction) => RendererStoreState;
  subscribe: (listener: Listener) => () => void;
  hydrateSnapshot: (snapshot: DomainSnapshot) => RendererStoreState;
  hydrateSessionWindow: (
    sessionId: string,
    snapshot: DomainSnapshot,
    mode?: "replace" | "prepend"
  ) => RendererStoreState;
  disposeSession: (sessionId: string) => RendererStoreState;
  ingestEvent: (event: RuntimeEvent) => RendererStoreState;
  ingestEnvelope: (envelope: EventEnvelope) => RendererStoreState;
  ingestEnvelopes: (envelopes: EventEnvelope[]) => RendererStoreState;
};

export const createRendererStore = (
  initialState?: RendererStoreState
): RendererStore => {
  let state = initialState ?? createInitialRendererStoreState();
  const listeners = new Set<Listener>();

  const dispatch = (action: RendererStoreAction): RendererStoreState => {
    state = rendererStoreReducer(state, action);
    for (const listener of listeners) {
      listener(state, action);
    }
    return state;
  };

  return {
    getState: () => state,
    dispatch,
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hydrateSnapshot: (snapshot: DomainSnapshot) =>
      dispatch(createHydrateSnapshotAction(snapshot)),
    hydrateSessionWindow: (sessionId, snapshot, mode = "replace") =>
      dispatch({
        type: "store/hydrateSessionWindow",
        sessionId,
        snapshot,
        mode
      }),
    disposeSession: (sessionId) =>
      dispatch({
        type: "store/disposeSession",
        sessionId
      }),
    ingestEvent: (event: RuntimeEvent) =>
      dispatch(createIngestEventAction(event)),
    ingestEnvelope: (envelope: EventEnvelope) =>
      dispatch(createIngestEnvelopeAction(envelope)),
    ingestEnvelopes: (envelopes: EventEnvelope[]) =>
      dispatch(createIngestEnvelopesAction(envelopes))
  };
};
