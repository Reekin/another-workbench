import type { WorkbenchEventSubscriptionFilter } from "@another-workbench/shared";
import type { RendererStore } from "../store/store.js";
import type { DesktopTransport } from "./desktop-transport.js";

export type ConnectDesktopTransportToStoreInput = {
  transport: DesktopTransport;
  store: RendererStore;
  // Filters are reserved for specialized consumers. The desktop shell keeps a
  // single full-domain mirror and applies conversation/session selection in
  // selectors rather than by rescoping the subscription.
  filter?: WorkbenchEventSubscriptionFilter;
  fromCursor?: string;
  subscriptionId?: string;
  hydrateSnapshot?: boolean;
};

const hasHydratedDomainState = (store: RendererStore): boolean => {
  const state = store.getState();
  return (
    Object.keys(state.entities.conversations).length > 0 ||
    Object.keys(state.entities.sessions).length > 0 ||
    Object.keys(state.entities.turns).length > 0
  );
};

export const connectDesktopTransportToStore = async (
  input: ConnectDesktopTransportToStoreInput
): Promise<{ subscriptionId: string; unsubscribe: () => Promise<void> }> => {
  let fromCursor = input.fromCursor ?? input.store.getState().eventStream.lastCursor;
  const shouldHydrateSnapshot =
    input.hydrateSnapshot ?? !hasHydratedDomainState(input.store);

  if (shouldHydrateSnapshot) {
    const snapshotResult = await input.transport.domain.snapshot();
    input.store.hydrateSnapshot(snapshotResult.snapshot);
    fromCursor = fromCursor ?? snapshotResult.cursor;
  }

  const subscription = await input.transport.events.subscribe({
    subscriptionId: input.subscriptionId,
    fromCursor,
    filter: input.filter,
    onEnvelope: (envelope) => {
      input.store.ingestEnvelope(envelope);
    }
  });

  return subscription;
};
