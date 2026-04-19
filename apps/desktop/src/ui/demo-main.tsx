import React from "react";
import ReactDOM from "react-dom/client";
import {
  createDemoWorkbenchRuntimeService,
  createLocalDesktopPreloadApi
} from "@another-workbench/desktop-server/browser";
import { createRendererStore } from "../store/store.js";
import { createDesktopTransport } from "../transport/desktop-transport.js";
import { ChatShellApp } from "./chat-shell/ChatShellApp.js";

const service = createDemoWorkbenchRuntimeService();
await service.executeCommand({
  commandId: "boot-create-codex",
  command: {
    type: "createSession",
    agentId: "codex",
    conversationId: "conv-demo-codex",
    workspaceId: "workspace-demo"
  }
});
await service.executeCommand({
  commandId: "boot-create-acp",
  command: {
    type: "createSession",
    agentId: "acp",
    conversationId: "conv-demo-acp",
    workspaceId: "workspace-demo"
  }
});

const preloadApi = createLocalDesktopPreloadApi(service as Parameters<
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
