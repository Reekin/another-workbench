import { useSyncExternalStore } from "react";
import type { RendererStore } from "../../store/store.js";
import type { RendererStoreState } from "../../store/types.js";

export const useRendererStoreState = (
  store: RendererStore
): RendererStoreState =>
  useSyncExternalStore(
    (onStoreChange) => store.subscribe(() => onStoreChange()),
    () => store.getSubscriptionSnapshot(),
    () => store.getSubscriptionSnapshot()
  ).state;
