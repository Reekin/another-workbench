import {
  createIngestEnvelopeAction,
  createIngestEnvelopesAction,
  createHydrateSnapshotAction,
  createIngestEventAction
} from "./intake.js";
import { rendererStoreReducer } from "./reducer.js";
import { createInitialRendererStoreState } from "./state.js";
import type { RendererStoreAction, RendererStoreState } from "./types.js";
import { DomainReplica, type DomainReadModel } from "@another-workbench/core";
import type {
  DomainSnapshot,
  EventEnvelope,
  RuntimeEvent
} from "@another-workbench/shared";

type Listener = (state: RendererStoreState, action: RendererStoreAction) => void;

export type RendererStoreSubscriptionSnapshot = {
  revision: number;
  domainRevision: number;
  state: RendererStoreState;
  domain: DomainReadModel;
};

export type RendererStore = {
  getState: () => RendererStoreState;
  getRevision: () => number;
  getDomainReadModel: () => DomainReadModel;
  getSubscriptionSnapshot: () => RendererStoreSubscriptionSnapshot;
  dispatch: (action: RendererStoreAction) => RendererStoreState;
  subscribe: (listener: Listener) => () => void;
  hydrateSnapshot: (snapshot: DomainSnapshot, cursor?: string) => RendererStoreState;
  hydrateSessionWindow: (
    sessionId: string,
    snapshot: DomainSnapshot,
    mode?: "replace" | "prepend",
    cursor?: string
  ) => RendererStoreState;
  disposeSession: (sessionId: string) => RendererStoreState;
  ingestEvent: (event: RuntimeEvent) => RendererStoreState;
  ingestEnvelope: (envelope: EventEnvelope) => RendererStoreState;
  ingestEnvelopes: (envelopes: EventEnvelope[]) => RendererStoreState;
};

const snapshotFromRendererState = (state: RendererStoreState): DomainSnapshot => ({
  conversations: Object.values(state.entities.conversations),
  sessions: Object.values(state.entities.sessions),
  turns: Object.values(state.entities.turns),
  messageBlocks: Object.values(state.entities.messageBlocks),
  toolCalls: Object.values(state.entities.toolCalls),
  terminalStreams: Object.values(state.entities.terminalStreams),
  approvalRequests: Object.values(state.entities.approvalRequests),
  runtimeInteractions: Object.values(state.entities.runtimeInteractions),
  participants: Object.values(state.entities.participants),
  threadGoals: Object.values(state.entities.threadGoals),
  sessionRelations: Object.values(state.entities.sessionRelations)
});

const actionTouchesDomain = (action: RendererStoreAction): boolean => {
  switch (action.type) {
    case "store/hydrateSnapshot":
    case "store/hydrateSessionWindow":
    case "store/disposeSession":
    case "store/ingestEvent":
    case "store/ingestEnvelope":
    case "store/ingestEnvelopes":
      return true;
    case "store/setActiveConversation":
    case "store/setActiveSession":
      return false;
    default:
      return false;
  }
};

const createSubscriptionSnapshot = (
  state: RendererStoreState,
  revision: number,
  domainReplica: DomainReplica
): RendererStoreSubscriptionSnapshot => ({
  revision,
  domainRevision: domainReplica.getRevision(),
  state,
  domain: domainReplica.readModel
});

export const createRendererStore = (
  initialState?: RendererStoreState
): RendererStore => {
  let state = initialState ?? createInitialRendererStoreState();
  const domainReplica = new DomainReplica({
    snapshot: snapshotFromRendererState(state)
  });
  let revision = 0;
  let subscriptionSnapshot = createSubscriptionSnapshot(
    state,
    revision,
    domainReplica
  );
  const listeners = new Set<Listener>();

  const dispatch = (action: RendererStoreAction): RendererStoreState => {
    const previousState = state;
    state = rendererStoreReducer(state, action);
    if (state !== previousState) {
      if (actionTouchesDomain(action)) {
        domainReplica.replaceSnapshot(snapshotFromRendererState(state));
      }
      revision += 1;
      subscriptionSnapshot = createSubscriptionSnapshot(
        state,
        revision,
        domainReplica
      );
    }
    for (const listener of listeners) {
      listener(state, action);
    }
    return state;
  };

  return {
    getState: () => state,
    getRevision: () => revision,
    getDomainReadModel: () => domainReplica.readModel,
    getSubscriptionSnapshot: () => subscriptionSnapshot,
    dispatch,
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hydrateSnapshot: (snapshot: DomainSnapshot, cursor?: string) =>
      dispatch(createHydrateSnapshotAction(snapshot, cursor)),
    hydrateSessionWindow: (sessionId, snapshot, mode = "replace", cursor) =>
      dispatch({
        type: "store/hydrateSessionWindow",
        sessionId,
        snapshot,
        mode,
        cursor
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
