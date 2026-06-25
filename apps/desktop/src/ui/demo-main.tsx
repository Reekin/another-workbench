import React from "react";
import ReactDOM from "react-dom/client";
import {
  createDemoWorkbenchShellService,
  createLocalDesktopPreloadApi
} from "@another-workbench/desktop-server/browser";
import { createRendererStore } from "../store/store.js";
import { createDesktopTransport } from "../transport/desktop-transport.js";
import { ChatShellApp } from "./chat-shell/ChatShellApp.js";

const demoFixture = new URLSearchParams(window.location.search).get("fixture");
const service = createDemoWorkbenchShellService({
  initialSnapshotMode: demoFixture === "load-older" ? "sessionsOnly" : "full"
});

const createDemoSession = async (
  engineId: string,
  conversationId: string,
  commandId: string
): Promise<string> => {
  await service.executeCommand({
    commandId,
    command: {
      type: "createSession",
      engineId,
      conversationId,
      workspaceId: "workspace-demo"
    }
  });

  const session = service
    .getSnapshot()
    .sessions.find(
      (item) => item.engineId === engineId && item.conversationId === conversationId
    );
  if (!session) {
    throw new Error(`Demo session was not created for ${engineId}.`);
  }
  return session.sessionId;
};

const seedLoadOlderFixture = async (sessionId: string): Promise<void> => {
  for (let index = 1; index <= 9; index += 1) {
    const label = String(index).padStart(2, "0");
    if (index > 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 5));
    }
    await service.executeCommand({
      commandId: `boot-load-older-${label}`,
      command: {
        type: "sendUserMessage",
        sessionId,
        messageId: `fixture-load-older-message-${label}`,
        content: `load older fixture turn ${label}`,
        attachments: []
      }
    });
  }
};

await createDemoSession("codex", "conv-demo-codex", "boot-create-codex");
const acpSessionId = await createDemoSession(
  "acp",
  "conv-demo-acp",
  "boot-create-acp"
);
if (demoFixture === "load-older") {
  await seedLoadOlderFixture(acpSessionId);
}

const preloadApi = createLocalDesktopPreloadApi(service as unknown as Parameters<
  typeof createLocalDesktopPreloadApi
>[0], {
  createSubscriptionId: () => "demo-subscription"
});
const transport = createDesktopTransport(preloadApi);
const store = createRendererStore();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ChatShellApp store={store} transport={transport} />
  </React.StrictMode>
);
