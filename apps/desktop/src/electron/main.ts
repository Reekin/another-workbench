import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  Notification,
  shell,
  Tray
} from "electron";
import {
  createWorkbenchRuntimeService,
  parseSchedulerRunHeadlessArgs,
  runSchedulerHeadlessCli
} from "@another-workbench/desktop-server";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKBENCH_IPC_EVENTS_PUSH_CHANNEL,
  WORKBENCH_IPC_MATERIALIZE_ATTACHMENT_CHANNEL,
  WORKBENCH_IPC_REQUEST_CHANNEL
} from "./ipc-channels.js";
import { createWorkbenchIpcRouter } from "./workbench-ipc-router.js";
import { materializeAttachmentDataUri } from "./attachment-materializer.js";
import {
  resolveWillNavigate,
  resolveWindowOpenNavigation
} from "./external-navigation.js";
import {
  createElectronDiagnosticsLogger,
  createElectronRunJournal,
  isBlankRendererHealth,
  shouldReloadForChildProcessGone,
  shouldReloadForLoadFailure,
  shouldReloadForRenderProcessGone,
  type ElectronDiagnosticsLogger,
  type RendererHealthSnapshot
} from "./electron-diagnostics.js";
import {
  createAgentCompletionNotifier,
  findMainSessionInPath
} from "./agent-completion-notification.js";

app.setName("Another Workbench");

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFilePath);
const appRoot = resolve(currentDir, "..");
const bundledPreloadPath = join(currentDir, "preload.cjs");
const bundledRendererIndexPath = join(appRoot, "dist-web", "index.html");
const defaultDevServerUrl = "http://127.0.0.1:4173/";
const iconFileNames =
  process.platform === "win32"
    ? ["icon.ico", "icon.png"]
    : process.platform === "darwin"
      ? ["icon.icns", "icon.png"]
      : ["icon.png"];

type WindowRecoveryState = {
  isQuitting: boolean;
  reloadInFlight: boolean;
  reloadedCauses: Set<string>;
};

const diagnostics = createElectronDiagnosticsLogger();
const runJournal = createElectronRunJournal({ logger: diagnostics });
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

const collectElectronMetricsSnapshot = async (
  window?: BrowserWindow
): Promise<Record<string, unknown>> => {
  const appMetrics = app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    cpu: {
      percentCPUUsage: metric.cpu.percentCPUUsage,
      idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond
    },
    memory: {
      workingSetSize: metric.memory.workingSetSize,
      peakWorkingSetSize: metric.memory.peakWorkingSetSize,
      privateBytes: metric.memory.privateBytes
    }
  }));
  const memoryReader = window?.webContents as
    | {
        getProcessMemoryInfo?: () => Promise<Record<string, unknown>>;
      }
    | undefined;
  const renderer = window?.isDestroyed()
    ? undefined
    : {
        osProcessId: window?.webContents.isDestroyed()
          ? undefined
          : window?.webContents.getOSProcessId(),
        url: window?.webContents.isDestroyed() ? undefined : window?.webContents.getURL(),
        memory:
          memoryReader?.getProcessMemoryInfo && !window?.webContents.isDestroyed()
            ? await memoryReader.getProcessMemoryInfo().catch((error: unknown) => ({
                unavailable: true,
                ...describeError(error)
              }))
            : undefined
      };

  return {
    appMetrics,
    renderer
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

const resolveAppIconPath = (): string | undefined => {
  const iconRoots = [join(appRoot, "dist-web", "icons"), join(appRoot, "public", "icons")];
  for (const root of iconRoots) {
    for (const fileName of iconFileNames) {
      const iconPath = join(root, fileName);
      if (existsSync(iconPath)) {
        return iconPath;
      }
    }
  }
  return undefined;
};

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
  const windowId = window.id;

  window.on("close", (event) => {
    runJournal.record("Main window close requested.", {
      windowId,
      defaultPrevented: event.defaultPrevented,
      visible: window.isVisible(),
      minimized: window.isMinimized(),
      url: webContents.getURL()
    });
  });

  window.on("closed", () => {
    runJournal.record("Main window closed.", {
      windowId
    });
  });

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
    void collectElectronMetricsSnapshot(window).then((snapshot) => {
      logger.log({
        severity: "error",
        source: "renderer-process",
        message: "Renderer process gone.",
        details: {
          ...record,
          snapshot
        }
      });
    });
    if (shouldReloadForRenderProcessGone(details)) {
      reloadWindowOnce(window, "render-process-gone", record);
    }
  });

  webContents.on("unresponsive", () => {
    void collectElectronMetricsSnapshot(window).then((snapshot) => {
      logger.log({
        severity: "warning",
        source: "renderer-process",
        message: "Renderer became unresponsive.",
        details: {
          url: webContents.getURL(),
          snapshot
        }
      });
    });
  });

  webContents.on("responsive", () => {
    void collectElectronMetricsSnapshot(window).then((snapshot) => {
      logger.log({
        source: "renderer-process",
        message: "Renderer became responsive again.",
        details: {
          url: webContents.getURL(),
          snapshot
        }
      });
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
    void collectElectronMetricsSnapshot().then((snapshot) => {
      logger.log({
        severity: "error",
        source: "electron-child-process",
        message: "Electron child process gone.",
        details: {
          ...record,
          snapshot
        }
      });
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
    runJournal.record("Application before-quit event received.", {
      windowCount: BrowserWindow.getAllWindows().length
    });
  });

  app.on("will-quit", () => {
    runJournal.record("Application will-quit event received.");
  });

  app.on("quit", (_event, exitCode) => {
    runJournal.finish("app-quit", { exitCode });
  });
};

const createMainWindow = (): BrowserWindow => {
  const iconPath = resolveAppIconPath();
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#f4f6fb",
    show: false,
    ...(iconPath ? { icon: iconPath } : {}),
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
  runJournal.start();
  installAppDiagnostics(diagnostics);
  try {
    crashReporter.start({
      productName: "Another Workbench",
      companyName: "Another Workbench",
      submitURL: "",
      uploadToServer: false,
      compress: false
    });
    runJournal.record("Electron crash reporter started.", {
      crashDumpsPath: app.getPath("crashDumps")
    });
  } catch (error) {
    diagnostics.logSync({
      severity: "error",
      source: "main-process-lifecycle",
      message: "Failed to start Electron crash reporter.",
      details: describeError(error)
    });
  }
  const schedulerRunArgs = parseSchedulerRunHeadlessArgs(process.argv);
  if (schedulerRunArgs) {
    const exitCode = await runSchedulerHeadlessCli({
      args: schedulerRunArgs,
      createService: createWorkbenchRuntimeService
    });
    app.exit(exitCode);
    return;
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    const [existingWindow] = BrowserWindow.getAllWindows();
    if (!existingWindow || existingWindow.isDestroyed()) {
      return;
    }
    if (existingWindow.isMinimized()) {
      existingWindow.restore();
    }
    existingWindow.show();
    existingWindow.focus();
  });
  await app.whenReady();
  app.setAppUserModelId("com.another-workbench.desktop");
  const appIconPath = resolveAppIconPath();
  if (process.platform === "darwin" && appIconPath) {
    app.dock?.setIcon(appIconPath);
  }

  if (!existsSync(bundledPreloadPath)) {
    throw new Error(`Missing bundled preload asset: ${bundledPreloadPath}`);
  }

  const service = createWorkbenchRuntimeService({
    persistenceBaseDir:
      process.env.AWB_PERSISTENCE_BASE_DIR?.trim() || undefined,
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
  let completionTray: Tray | undefined;
  let completionTrayDestroyTimer: ReturnType<typeof setTimeout> | undefined;
  const focusMainWindow = (): void => {
    if (window.isDestroyed()) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  };
  const showAgentCompletionNotification = (sessionTitle: string): void => {
    const title = "Another Workbench";
    const body = `「${sessionTitle}」会话已完成`;
    if (process.platform === "win32" && appIconPath) {
      if (!completionTray || completionTray.isDestroyed()) {
        completionTray = new Tray(appIconPath);
        completionTray.setToolTip("Another Workbench");
        completionTray.on("balloon-click", focusMainWindow);
      }
      completionTray.displayBalloon({
        title,
        content: body,
        icon: appIconPath,
        iconType: "custom",
        largeIcon: true,
        noSound: false,
        respectQuietTime: false
      });
      if (completionTrayDestroyTimer) {
        clearTimeout(completionTrayDestroyTimer);
      }
      completionTrayDestroyTimer = setTimeout(() => {
        completionTray?.destroy();
        completionTray = undefined;
        completionTrayDestroyTimer = undefined;
      }, 12_000);
      return;
    }
    if (!Notification.isSupported()) {
      return;
    }
    const notification = new Notification({
      title,
      body,
      ...(appIconPath ? { icon: appIconPath } : {})
    });
    notification.on("click", focusMainWindow);
    notification.show();
  };
  const completionNotifier = createAgentCompletionNotifier({
    notify: (completed) => {
      void service
        .getSessionBrowserPath(completed.sessionId)
        .then((path) => {
          const session = findMainSessionInPath(path);
          if (session) {
            showAgentCompletionNotification(session.title);
          }
        })
        .catch((error: unknown) => {
          diagnostics.log({
            severity: "warning",
            source: "agent-completion-notification",
            message: "Skipped completion notification because session scope could not be resolved.",
            details: {
              sessionId: completed.sessionId,
              ...describeError(error)
            }
          });
        });
    }
  });
  const router = createWorkbenchIpcRouter({
    service,
    onPush: (push) => {
      completionNotifier.handlePush(push);
      if (!window.isDestroyed()) {
        window.webContents.send(WORKBENCH_IPC_EVENTS_PUSH_CHANNEL, push);
      }
    },
    onPushBatch: (batch) => {
      completionNotifier.handleBatch(batch);
      if (!window.isDestroyed()) {
        window.webContents.send(WORKBENCH_IPC_EVENTS_PUSH_CHANNEL, batch);
      }
    }
  });

  ipcMain.handle(WORKBENCH_IPC_REQUEST_CHANNEL, (_event, payload: unknown) =>
    router.handleRequest(payload)
  );
  ipcMain.handle(WORKBENCH_IPC_MATERIALIZE_ATTACHMENT_CHANNEL, (_event, payload: unknown) =>
    materializeAttachmentDataUri(
      payload as Record<string, unknown>,
      join(app.getPath("userData"), "attachments", "pasted-images")
    )
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
    if (completionTrayDestroyTimer) {
      clearTimeout(completionTrayDestroyTimer);
    }
    completionTray?.destroy();
    ipcMain.removeHandler(WORKBENCH_IPC_REQUEST_CHANNEL);
    ipcMain.removeHandler(WORKBENCH_IPC_MATERIALIZE_ATTACHMENT_CHANNEL);
    void router.dispose();
  });
};

process.once("exit", (exitCode) => {
  runJournal.finish("process-exit", { exitCode });
});

void boot().catch((error) => {
  diagnostics.logSync({
    severity: "error",
    source: "main-process",
    message: "Failed to boot Electron app.",
    details: describeError(error)
  });
  console.error(error);
  app.exit(1);
});
