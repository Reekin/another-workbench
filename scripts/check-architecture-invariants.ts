import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(__filename, "..", "..");

const toRepoPath = (absolutePath: string): string =>
  relative(repoRoot, absolutePath).replaceAll("\\", "/");

const readRepoFile = (relativePath: string): string =>
  readFileSync(resolve(repoRoot, relativePath), "utf8");

const listFiles = (relativeDir: string): string[] => {
  const absoluteDir = resolve(repoRoot, relativeDir);
  const entries = readdirSync(absoluteDir);
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = resolve(absoluteDir, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...listFiles(toRepoPath(absolutePath)));
      continue;
    }
    files.push(toRepoPath(absolutePath));
  }
  return files;
};

const fail = (message: string): never => {
  throw new Error(message);
};

const assertSetEquals = (
  label: string,
  left: readonly string[],
  right: readonly string[]
): void => {
  const leftOnly = left.filter((item) => !right.includes(item));
  const rightOnly = right.filter((item) => !left.includes(item));
  if (leftOnly.length > 0 || rightOnly.length > 0) {
    fail(
      `${label} mismatch. Left-only: ${leftOnly.join(", ") || "none"}. Right-only: ${
        rightOnly.join(", ") || "none"
      }.`
    );
  }
};

const uniqueSorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

const extractStringLiterals = (source: string): string[] => {
  const matches = source.matchAll(/(["'`])([^"'`]+)\1/g);
  return [...matches].map((match) => match[2]).filter(Boolean);
};

const assertRpcRegistryMatchesSchemas = (): void => {
  const ipcSource = readRepoFile("packages/shared/src/ipc.ts");
  const registryMatch = ipcSource.match(
    /export const workbenchRpcMethods = \[([\s\S]*?)\] as const;/
  );
  if (!registryMatch) {
    fail("Unable to find workbenchRpcMethods registry in packages/shared/src/ipc.ts.");
  }
  const registeredMethods = uniqueSorted(extractStringLiterals(registryMatch[1] ?? ""));
  const schemaMethods = uniqueSorted(
    [...ipcSource.matchAll(/method:\s*z\.literal\("([^"]+)"\)/g)].map(
      (match) => match[1] ?? ""
    )
  );
  assertSetEquals("Workbench RPC method registry", registeredMethods, schemaMethods);
};

const assertSessionBrowserSchemaIsTyped = (): void => {
  const ipcSource = readRepoFile("packages/shared/src/ipc.ts");
  if (!/const\s+zSessionBrowserNodeSchema:\s+z\.ZodType<\s*SessionBrowserNodeRpc\b/.test(ipcSource)) {
    fail("zSessionBrowserNodeSchema must be typed as z.ZodType<SessionBrowserNodeRpc>.");
  }
  if (/const\s+zSessionBrowserNodeSchema:\s+z\.ZodType\s*=/.test(ipcSource)) {
    fail("zSessionBrowserNodeSchema must not use bare z.ZodType.");
  }
};

const codexExtensionRpcMethods = [
  "codex.hookActivity.get",
  "codex.turnChanges.get",
  "codex.turnChanges.undo"
] as const;

const assertCodexExtensionRpcAllowlist = (): void => {
  const inspectedFiles = [
    "packages/shared/src/ipc.ts",
    "apps/desktop/src/transport/desktop-transport.ts",
    "apps/desktop-server/src/workbench-rpc-handler.ts"
  ];
  const allowlist = new Set<string>(codexExtensionRpcMethods);
  for (const file of inspectedFiles) {
    const source = readRepoFile(file);
    const codexLiterals = uniqueSorted(
      extractStringLiterals(source).filter((literal) => literal.startsWith("codex."))
    );
    const unexpected = codexLiterals.filter((literal) => !allowlist.has(literal));
    if (unexpected.length > 0) {
      fail(`${file} contains unguarded Codex RPC method(s): ${unexpected.join(", ")}.`);
    }
    const missing = codexExtensionRpcMethods.filter((method) => !codexLiterals.includes(method));
    if (missing.length > 0) {
      fail(`${file} is missing allowed Codex RPC method(s): ${missing.join(", ")}.`);
    }
  }
};

const assertProviderIdentityBoundaries = (): void => {
  const sourceFiles = listFiles("apps/desktop-server/src").filter((file) =>
    file.endsWith(".ts")
  );
  const getThreadIdAllowedFiles = new Set([
    "apps/desktop-server/src/codex-app-server-runtime-port.ts",
    "apps/desktop-server/src/prod-service.ts"
  ]);
  const getThreadIdViolations: string[] = [];
  for (const file of sourceFiles) {
    const source = readRepoFile(file);
    if (
      /\bgetThreadIdForSession\s*\(/.test(source) &&
      !getThreadIdAllowedFiles.has(file)
    ) {
      getThreadIdViolations.push(file);
    }
  }
  if (getThreadIdViolations.length > 0) {
    fail(
      `getThreadIdForSession is only allowed behind runtime binding: ${getThreadIdViolations.join(
        ", "
      )}.`
    );
  }

  const providerFiles = sourceFiles.filter((file) => /provider\.ts$/.test(file));
  const providerFallbackViolations: string[] = [];
  for (const file of providerFiles) {
    const source = readRepoFile(file);
    if (/metadata\.providerSessionId|indexEntry\.providerSessionId/.test(source)) {
      providerFallbackViolations.push(file);
    }
  }
  if (providerFallbackViolations.length > 0) {
    fail(
      `Capability providers must use SessionIdentityRegistry/providerHandle, not metadata/index fallbacks: ${providerFallbackViolations.join(
        ", "
      )}.`
    );
  }
};

const assertRuntimeEventSwitchCoverage = (): void => {
  const eventsSource = readRepoFile("packages/shared/src/events.ts");
  const registryMatch = eventsSource.match(/export const eventTypes = \[([\s\S]*?)\] as const;/);
  if (!registryMatch) {
    fail("Unable to find eventTypes registry in packages/shared/src/events.ts.");
  }
  const eventTypes = uniqueSorted(extractStringLiterals(registryMatch[1] ?? ""));
  const inspectedFiles = [
    "packages/core/src/domain-projector.ts",
    "apps/desktop/src/store/reducer.ts"
  ];
  for (const file of inspectedFiles) {
    const source = readRepoFile(file);
    const cases = uniqueSorted(
      [...source.matchAll(/case\s+"([^"]+)":/g)]
        .map((match) => match[1] ?? "")
        .filter((value) => eventTypes.includes(value))
    );
    const missing = eventTypes.filter((eventType) => !cases.includes(eventType));
    if (missing.length > 0) {
      fail(`${file} is missing runtime event switch cases: ${missing.join(", ")}.`);
    }
  }
};

const assertReplayGapContract = (): void => {
  const coreEventBus = readRepoFile("packages/core/src/event-bus.ts");
  if (
    !coreEventBus.includes("RuntimeEventReplayResult") ||
    !coreEventBus.includes("replayResult(") ||
    !coreEventBus.includes('"cursor_not_found"')
  ) {
    fail("RuntimeEventBus must keep an explicit replay gap result contract.");
  }

  const sharedIpc = readRepoFile("packages/shared/src/ipc.ts");
  if (
    !sharedIpc.includes('z.enum(["ok", "gap"])') ||
    !sharedIpc.includes('z.enum(["cursor_not_found"])')
  ) {
    fail("events.replay RPC response must expose status and cursor_not_found reason.");
  }

  const storeBridge = readRepoFile("apps/desktop/src/transport/store-bridge.ts");
  if (
    !storeBridge.includes('replayResult.status === "gap"') ||
    !storeBridge.includes("transport.domain.snapshot()")
  ) {
    fail("Desktop store bridge must hydrate snapshot after replay gap.");
  }
};

const assertInteractivePerformanceBoundaries = (): void => {
  const sessionBrowserController = readRepoFile(
    "apps/desktop/src/ui/chat-shell/use-workspace-browser-controller.ts"
  );
  if (sessionBrowserController.includes("sessionBrowser.listTree")) {
    fail("The normal desktop session browser must use bounded page queries, not listTree.");
  }
  if (sessionBrowserController.includes("sessionBrowser.repair")) {
    fail("The interactive session browser must not trigger provider repair.");
  }

  const legacySessionRepairFiles = [
    "packages/shared/src/ipc.ts",
    "apps/desktop/src/transport/desktop-transport.ts",
    "apps/desktop-server/src/workbench-rpc-handler.ts"
  ].filter((file) => readRepoFile(file).includes("sessionBrowser.reconcile"));
  if (legacySessionRepairFiles.length > 0) {
    fail(
      `Legacy sessionBrowser.reconcile RPC must not return: ${legacySessionRepairFiles.join(
        ", "
      )}.`
    );
  }

  const sessionIndexStore = readRepoFile("apps/desktop-server/src/session-index.ts");
  const repairBody = sessionIndexStore.match(
    /public async applyWorkspaceRepair\([\s\S]*?\n  public async archiveSession\(/
  )?.[0];
  if (!repairBody) {
    fail("SessionIndexStore must expose an explicit applyWorkspaceRepair batch boundary.");
  }
  if (
    !repairBody.includes("await yieldRepairBatch()") ||
    !repairBody.includes("this.revision !== baseRevision")
  ) {
    fail("applyWorkspaceRepair must yield between batches and fence concurrent mutations.");
  }
  for (const forbiddenCall of [
    "upsertSessionInMemory(",
    "upsertRelationInMemory(",
    "archiveSessions("
  ]) {
    if (repairBody.includes(forbiddenCall)) {
      fail(`applyWorkspaceRepair must not call ${forbiddenCall} per item.`);
    }
  }

  const rendererStore = readRepoFile("apps/desktop/src/store/store.ts");
  if (
    rendererStore.includes("snapshotFromRendererState") ||
    rendererStore.includes("withDomainSnapshot")
  ) {
    fail("The renderer live store must not rebuild the complete domain snapshot.");
  }

  const runtimePort = readRepoFile(
    "apps/desktop-server/src/codex-app-server-runtime-port.ts"
  );
  const commandOutputCase = runtimePort.match(
    /case\s+"item\/commandExecution\/outputDelta":\s*\{([\s\S]*?)case\s+"serverRequest\/resolved"/
  )?.[1];
  if (!commandOutputCase || !commandOutputCase.includes('emitEvent("terminal.output"')) {
    fail("Codex command output must publish terminal.output.");
  }
  if (commandOutputCase.includes('emitEvent("tool.delta"')) {
    fail("Codex command output must not duplicate raw bytes through tool.delta.");
  }

  const rendererDiagnostics = readRepoFile(
    "apps/desktop/src/ui/chat-shell/use-renderer-diagnostics.ts"
  );
  if (
    rendererDiagnostics.includes('kind: "diagnostic-buffer"') ||
    rendererDiagnostics.includes("samples: recentSamples")
  ) {
    fail("Renderer diagnostics must not attach the complete rolling sample buffer.");
  }
};

const assertRemoteProductBoundaries = (): void => {
  const forbiddenDesktopFiles = [
    "apps/desktop/src/transport/remote-workbench-client.ts",
    "apps/desktop/src/transport/workbench-client-bootstrap.ts"
  ].filter((file) => existsSync(resolve(repoRoot, file)));
  if (forbiddenDesktopFiles.length > 0) {
    fail(
      `Desktop must remain local-only; remove remote client files: ${forbiddenDesktopFiles.join(
        ", "
      )}.`
    );
  }

  const desktopSource = listFiles("apps/desktop/src")
    .filter((file) => /\.(?:ts|tsx|cts)$/u.test(file))
    .map(readRepoFile)
    .join("\n");
  for (const forbidden of [
    "VITE_WORKBENCH_REMOTE",
    "workbenchRemoteBootstrap",
    "createRemoteWorkbenchClientApi",
    'workbenchMode=remote'
  ]) {
    if (desktopSource.includes(forbidden)) {
      fail(`Desktop source must not contain remote client entrypoint ${forbidden}.`);
    }
  }

  const remoteContract = readRepoFile("packages/shared/src/remote-control.ts");
  for (const forbidden of ["desktop-full", "mobile-companion", "clientSurface"]) {
    if (remoteContract.includes(forbidden)) {
      fail(`Mobile remote contract must not contain legacy surface ${forbidden}.`);
    }
  }

  const remoteServer = readRepoFile("apps/desktop-server/src/remote-server.ts");
  if (remoteServer.includes('url.pathname === "/pairing/code"')) {
    fail("Pairing codes must be issued locally, never through the remote server.");
  }
  if (!remoteServer.includes("createMobileRemoteRpcHandler")) {
    fail("Remote server must dispatch through the mobile-only RPC gateway.");
  }

  const relayServer = readRepoFile("apps/relay-server/src/server.ts");
  if (relayServer.includes('url.pathname === "/pairing/code"')) {
    fail("Relay must not expose remote pairing-code issuance.");
  }
};

assertRpcRegistryMatchesSchemas();
assertSessionBrowserSchemaIsTyped();
assertCodexExtensionRpcAllowlist();
assertRemoteProductBoundaries();
assertProviderIdentityBoundaries();
assertRuntimeEventSwitchCoverage();
assertReplayGapContract();
assertInteractivePerformanceBoundaries();

console.log("Architecture invariants passed.");
console.log(`Codex extension RPC allowlist: ${codexExtensionRpcMethods.join(", ")}`);
