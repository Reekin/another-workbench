import { useSyncExternalStore } from "react";
import type { RendererStore } from "../../store/store.js";
import type { RendererStoreState } from "../../store/types.js";

export const useRendererStoreState = (
  store: RendererStore
): RendererStoreState =>
  useSyncExternalStore(
    (onStoreChange) => store.subscribeMeta(onStoreChange),
    () => store.getSubscriptionSnapshot(),
    () => store.getSubscriptionSnapshot()
  ).state;

export const useRendererSessionRevision = (
  store: RendererStore,
  sessionId: string | undefined
): number =>
  useSyncExternalStore(
    (onStoreChange) =>
      sessionId ? store.subscribeSession(sessionId, onStoreChange) : () => undefined,
    () =>
      sessionId
        ? store.getDomainReadModel().getSessionRevision(sessionId)
        : store.getDomainReadModel().getRevision(),
    () =>
      sessionId
        ? store.getDomainReadModel().getSessionRevision(sessionId)
        : store.getDomainReadModel().getRevision()
  );

export const useRendererConversationRevision = (
  store: RendererStore,
  conversationId: string | undefined
): number =>
  useSyncExternalStore(
    (onStoreChange) =>
      conversationId
        ? store.subscribeConversation(conversationId, onStoreChange)
        : () => undefined,
    () =>
      conversationId
        ? store.getDomainReadModel().getConversationRevision(conversationId)
        : store.getDomainReadModel().getRevision(),
    () =>
      conversationId
        ? store.getDomainReadModel().getConversationRevision(conversationId)
        : store.getDomainReadModel().getRevision()
  );
