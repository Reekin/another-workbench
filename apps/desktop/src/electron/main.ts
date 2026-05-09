import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { createWorkbenchRuntimeService } from "@another-workbench/desktop-server";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKBENCH_IPC_EVENTS_PUSH_CHANNEL,
  WORKBENCH_IPC_REQUEST_CHANNEL
} from "./ipc-channels.js";
import { createWorkbenchIpcRouter } from "./workbench-ipc-router.js";
import {
  resolveWillNavigate,
  resolveWindowOpenNavigation
} from "./external-navigation.js";
import {
  createElectronDiagnosticsLogger,
  isBlankRendererHealth,
  shouldReloadForChildProcessGone,
  shouldReloadForLoadFailure,
  shouldReloadForRenderProcessGone,
  type ElectronDiagnosticsLogger,
  type RendererHealthSnapshot
} from "./electron-diagnostics.js";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFilePath);
const appRoot = resolve(currentDir, "..");
const bundledPreloadPath = join(currentDir, "preload.cjs");
const bundledRendererIndexPath = join(appRoot, "dist-web", "index.html");
const defaultDevServerUrl = "http://127.0.0.1:4173/";

type WindowRecoveryState = {
  isQuitting: boolean;
  reloadInFlight: boolean;
  reloadedCauses: Set<string>;
};

const diagnostics = createElectronDiagnosticsLogger();
const recoveryState: WindowRecoveryState = {
  isQuitting: false,
  reloadInFlight: false,
  reloadedCauses: new Set()
};

const describeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return {
    message: typeof error === "string" ? error : String(error)
  };
};

const reloadWindowOnce = (
  window: BrowserWindow,
  cause: string,
  details: Record<string, unknown>
): void => {
  if (recoveryState.isQuitting || window.isDestroyed()) {
    return;
  }
  if (recoveryState.reloadInFlight) {
    diagnostics.log({
      severity: "warning",
      source: "electron-recovery",
      message: `Skipped renderer reload for ${cause}; recovery already in progress.`,
      details
    });
    return;
  }
  if (recoveryState.reloadedCauses.has(cause)) {
    diagnostics.log({
      severity: "warning",
      source: "electron-recovery",
      message: `Skipped repeated renderer reload for ${cause}.`,
      details
    });
    return;
  }

  recoveryState.reloadedCauses.add(cause);
  recoveryState.reloadInFlight = true;
  diagnostics.log({
    severity: "warning",
    source: "electron-recovery",
    message: `Reloading renderer after ${cause}.`,
    details
  });
  setTimeout(() => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.reloadIgnoringCache();
    }
  }, 50);
};

const resetReloadGuardsAfterHealthyRenderer = (): void => {
  if (recoveryState.reloadedCauses.size === 0 && !recoveryState.reloadInFlight) {
    return;
  }
  diagnostics.log({
    source: "electron-recovery",
    message: "Renderer recovered; reset reload guards.",
    details: {
      recoveredCauses: [...recoveryState.reloadedCauses]
    }
  });
  recoveryState.reloadedCauses.clear();
  recoveryState.reloadInFlight = false;
};

const readRendererHealthScript = `
(() => {
  const root = document.getElementById("root");
  return {
    rootExists: Boolean(root),
    rootChildCount: root ? root.childElementCount : -1,
    rootTextLength: root ? root.innerText.trim().length : -1,
    bodyTextLength: document.body ? document.body.innerText.trim().length : -1,
    readyState: document.readyState,
    href: location.href
  };
})()
`;

const checkRendererHealth = (
  window: BrowserWindow,
  cause: string,
  logger: ElectronDiagnosticsLogger
): void => {
  setTimeout(() => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    void window.webContents
      .executeJavaScript(readRendererHealthScript, true)
      .then((snapshot: RendererHealthSnapshot) => {
        logger.log({
          source: "renderer-health",
          message: "Renderer health snapshot.",
          details: {
            cause,
            ...snapshot
          }
        });
        if (isBlankRendererHealth(snapshot)) {
          reloadWindowOnce(window, `blank-renderer:${cause}`, snapshot);
        } else {
          resetReloadGuardsAfterHealthyRenderer();
        }
      })
      .catch((error: unknown) => {
        logger.log({
          severity: "error",
          source: "renderer-health",
          message: "Failed to inspect renderer health.",
          details: {
            cause,
            ...describeError(error)
          }
        });
      });
  }, 1500);
};

const installWindowDiagnostics = (
  window: BrowserWindow,
  logger: ElectronDiagnosticsLogger
): void => {
  const { webContents } = window;

  webContents.on("did-finish-load", () => {
    logger.log({
      source: "renderer-load",
      message: "Renderer finished loading.",
      details: {
        url: webContents.getURL()
      }
    });
    checkRendererHealth(window, "did-finish-load", logger);
  });

  webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      const details = {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame
      };
      logger.log({
        severity: "error",
        source: "renderer-load",
        message: "Renderer load failed.",
        details
      });
      if (shouldReloadForLoadFailure({ errorCode, isMainFrame })) {
        reloadWindowOnce(window, "did-fail-load", details);
      }
    }
  );

  webContents.on(
    "did-fail-provisional-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      const details = {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame
      };
      logger.log({
        severity: "error",
        source: "renderer-load",
        message: "Renderer provisional load failed.",
        details
      });
      if (shouldReloadForLoadFailure({ errorCode, isMainFrame })) {
        reloadWindowOnce(window, "did-fail-provisional-load", details);
      }
    }
  );

  webContents.on("render-process-gone", (_event, details) => {
    const record = { ...details };
    logger.log({
      severity: "error",
      source: "renderer-process",
      message: "Renderer process gone.",
      details: record
    });
    if (shouldReloadForRenderProcessGone(details)) {
      reloadWindowOnce(window, "render-process-gone", record);
    }
  });

  webContents.on("unresponsive", () => {
    logger.log({
      severity: "warning",
      source: "renderer-process",
      message: "Renderer became unresponsive.",
      details: {
        url: webContents.getURL()
      }
    });
  });

  webContents.on("responsive", () => {
    logger.log({
      source: "renderer-process",
      message: "Renderer became responsive again.",
      details: {
        url: webContents.getURL()
      }
    });
  });

  webContents.on("console-message", (event) => {
    const { level, lineNumber, message, sourceId } = event;
    if (level !== "warning" && level !== "error") {
      return;
    }
    logger.log({
      severity: level === "error" ? "error" : "warning",
      source: "renderer-console",
      message,
      details: {
        level,
        line: lineNumber,
        sourceId
      }
    });
  });

  webContents.on("preload-error", (_event, preloadPath, error) => {
    logger.log({
      severity: "error",
      source: "renderer-preload",
      message: "Preload script failed.",
      details: {
        preloadPath,
        ...describeError(error)
      }
    });
  });
};

const installAppDiagnostics = (logger: ElectronDiagnosticsLogger): void => {
  process.on("uncaughtExceptionMonitor", (error) => {
    logger.log({
      severity: "error",
      source: "main-process",
      message: "Main process uncaught exception.",
      details: describeError(error)
    });
  });

  process.on("unhandledRejection", (reason) => {
    logger.log({
      severity: "error",
      source: "main-process",
      message: "Main process unhandled rejection.",
      details: describeError(reason)
    });
  });

  app.on("child-process-gone", (_event, details) => {
    const record = { ...details };
    logger.log({
      severity: "error",
      source: "electron-child-process",
      message: "Electron child process gone.",
      details: record
    });
    if (!shouldReloadForChildProcessGone(details)) {
      return;
    }
    for (const window of BrowserWindow.getAllWindows()) {
      reloadWindowOnce(window, "child-process-gone", record);
    }
  });

  app.on("before-quit", () => {
    recoveryState.isQuitting = true;
  });
};

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
  installExternalNavigationHandlers(window);
  installWindowDiagnostics(window, diagnostics);

  return window;
};

const openExternalUrl = (url: string | undefined): void => {
  if (!url) {
    return;
  }
  void shell.openExternal(url);
};

const installExternalNavigationHandlers = (window: BrowserWindow): void => {
  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = resolveWindowOpenNavigation(url);
    if (decision.action === "deny") {
      openExternalUrl(decision.externalUrl);
    }
    return {
      action: decision.action
    };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const decision = resolveWillNavigate(url, window.webContents.getURL());
    if (decision.action === "allow") {
      return;
    }
    event.preventDefault();
    openExternalUrl(decision.externalUrl);
  });
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
    await window.webContents.session.clearCache();
    await window.loadFile(target.value, {
      search: `v=${Date.now()}`
    });
  }
};

const boot = async (): Promise<void> => {
  installAppDiagnostics(diagnostics);
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
    },
    openFilePath: (path) => shell.openPath(path),
    revealFilePath: (path) => {
      shell.showItemInFolder(path);
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
  diagnostics.log({
    severity: "error",
    source: "main-process",
    message: "Failed to boot Electron app.",
    details: describeError(error)
  });
  console.error(error);
  app.exit(1);
});
