import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { createWorkbenchRuntimeService } from "@another-workbench/desktop-server";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKBENCH_IPC_EVENTS_PUSH_CHANNEL,
  WORKBENCH_IPC_REQUEST_CHANNEL
} from "./ipc-channels.js";
import { createWorkbenchIpcRouter } from "./workbench-ipc-router.js";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFilePath);
const appRoot = resolve(currentDir, "..");
const bundledPreloadPath = join(currentDir, "preload.cjs");
const bundledRendererIndexPath = join(appRoot, "dist-web", "index.html");
const defaultDevServerUrl = "http://127.0.0.1:4173/";

const createMainWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#f4f6fb",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: bundledPreloadPath
    }
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  return window;
};

const resolveRendererTarget = (): { type: "url" | "file"; value: string } => {
  const devServerUrl = process.env.AWB_VITE_DEV_SERVER_URL?.trim();
  if (devServerUrl) {
    return { type: "url", value: devServerUrl };
  }

  return { type: "file", value: bundledRendererIndexPath };
};

const loadRendererTarget = async (window: BrowserWindow): Promise<void> => {
  const target = resolveRendererTarget();
  if (target.type === "url") {
    await window.loadURL(target.value);
  } else {
    await window.loadFile(target.value);
  }
};

const boot = async (): Promise<void> => {
  await app.whenReady();

  if (!existsSync(bundledPreloadPath)) {
    throw new Error(`Missing bundled preload asset: ${bundledPreloadPath}`);
  }

  const service = createWorkbenchRuntimeService({
    pickWorkspaceDirectory: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: "Add workspace",
        properties: ["openDirectory", "createDirectory"]
      });
      return {
        canceled: result.canceled,
        rootPath: result.filePaths[0]
      };
    }
  });
  let window = createMainWindow();
  const router = createWorkbenchIpcRouter({
    service,
    onPush: (push) => {
      if (!window.isDestroyed()) {
        window.webContents.send(WORKBENCH_IPC_EVENTS_PUSH_CHANNEL, push);
      }
    }
  });

  ipcMain.handle(WORKBENCH_IPC_REQUEST_CHANNEL, (_event, payload: unknown) =>
    router.handleRequest(payload)
  );

  await loadRendererTarget(window);

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      window = createMainWindow();
      await loadRendererTarget(window);
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.once("will-quit", () => {
    ipcMain.removeHandler(WORKBENCH_IPC_REQUEST_CHANNEL);
    void router.dispose();
  });
};

void boot().catch((error) => {
  console.error(error);
  app.exit(1);
});
