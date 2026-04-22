import React from "react";
import ReactDOM from "react-dom/client";
import { createRendererStore } from "../store/store.js";
import { createDesktopTransport } from "../transport/desktop-transport.js";
import { resolveWorkbenchClientApi } from "../transport/workbench-client-bootstrap.js";
import { ChatShellApp } from "./chat-shell/ChatShellApp.js";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element.");
}

let transport: ReturnType<typeof createDesktopTransport> | undefined;
let selectionLabel = "local";
try {
  const selection = resolveWorkbenchClientApi({
    env: import.meta.env,
    window
  });
  selectionLabel = selection.mode === "remote" ? `remote: ${selection.label}` : "local";
  transport = createDesktopTransport(selection.api);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  root.innerHTML = [
    "<main style='font-family: ui-sans-serif, system-ui; padding: 24px; line-height: 1.5'>",
    "<h1 style='margin: 0 0 12px'>Another Workbench</h1>",
    "<p style='margin: 0 0 12px'>This renderer needs either the Electron preload API for local mode or a remote workbench bootstrap URL for remote mode.</p>",
    `<pre style='background: #f6f6f6; padding: 12px; border-radius: 8px; overflow: auto'>${message}</pre>`,
    "<p style='margin: 12px 0 0'>Remote mode can be enabled with <code>VITE_WORKBENCH_MODE=remote</code> and <code>VITE_WORKBENCH_REMOTE_URL=http://host:port</code>, or with <code>?workbenchMode=remote&amp;workbenchRemoteUrl=http://host:port</code>.</p>",
    "<p style='margin: 12px 0 0'>Try the demo entry instead: <a href='/demo.html'>/demo.html</a></p>",
    "</main>"
  ].join("");
}

if (transport) {
  const store = createRendererStore();
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ChatShellApp
        store={store}
        transport={transport}
        title={`Another Workbench (${selectionLabel})`}
      />
    </React.StrictMode>
  );
}
