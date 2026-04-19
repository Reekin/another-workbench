import React from "react";
import ReactDOM from "react-dom/client";
import type { WorkbenchClientApi } from "@another-workbench/shared";
import { createRendererStore } from "../store/store.js";
import { createDesktopTransport } from "../transport/desktop-transport.js";
import { ChatShellApp } from "./chat-shell/ChatShellApp.js";

const requireWorkbenchPreloadApi = (): WorkbenchClientApi => {
  const api = window.workbench;
  if (!api) {
    throw new Error(
      "Electron preload API is missing. Launch the desktop host, or open /demo.html for the in-browser demo."
    );
  }
  return api;
};

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element.");
}

let transport: ReturnType<typeof createDesktopTransport> | undefined;
try {
  transport = createDesktopTransport(requireWorkbenchPreloadApi());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  root.innerHTML = [
    "<main style='font-family: ui-sans-serif, system-ui; padding: 24px; line-height: 1.5'>",
    "<h1 style='margin: 0 0 12px'>Another Workbench</h1>",
    "<p style='margin: 0 0 12px'>This renderer expects to run inside the Electron desktop host.</p>",
    `<pre style='background: #f6f6f6; padding: 12px; border-radius: 8px; overflow: auto'>${message}</pre>`,
    "<p style='margin: 12px 0 0'>Try the demo entry instead: <a href='/demo.html'>/demo.html</a></p>",
    "</main>"
  ].join("");
}

if (transport) {
  const store = createRendererStore();
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ChatShellApp store={store} transport={transport} title="Another Workbench" />
    </React.StrictMode>
  );
}

