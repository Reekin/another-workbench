import {
  invalidatesSessionBrowser,
  type RuntimeEvent
} from "@another-workbench/shared";

export type RendererRefreshSignals = {
  sessionBrowser: number;
  chatTree: number;
  engineExtensions: number;
};

export const createInitialRendererRefreshSignals = (): RendererRefreshSignals => ({
  sessionBrowser: 0,
  chatTree: 0,
  engineExtensions: 0
});

const increment = (value: number): number => value + 1;

const invalidatesChatTree = (event: RuntimeEvent): boolean => {
  switch (event.type) {
    case "conversationGraph.updated":
    case "session.disposed":
      return true;
    case "session.created":
      return Boolean(event.relation);
    default:
      return false;
  }
};

const invalidatesEngineExtensions = (event: RuntimeEvent): boolean =>
  event.type === "engineExtension.updated";

export const advanceRendererRefreshSignals = (
  current: RendererRefreshSignals,
  event: RuntimeEvent
): RendererRefreshSignals => {
  const sessionBrowserChanged = invalidatesSessionBrowser(event);
  const chatTreeChanged = invalidatesChatTree(event);
  const engineExtensionsChanged = invalidatesEngineExtensions(event);

  if (
    !sessionBrowserChanged &&
    !chatTreeChanged &&
    !engineExtensionsChanged
  ) {
    return current;
  }

  return {
    sessionBrowser: sessionBrowserChanged
      ? increment(current.sessionBrowser)
      : current.sessionBrowser,
    chatTree: chatTreeChanged ? increment(current.chatTree) : current.chatTree,
    engineExtensions: engineExtensionsChanged
      ? increment(current.engineExtensions)
      : current.engineExtensions
  };
};
