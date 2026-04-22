import type { WorkbenchClientApi } from "@another-workbench/shared";
import { createRemoteWorkbenchClientApi } from "./remote-workbench-client.js";

type StringRecord = Record<string, string>;

export type WorkbenchBootstrapMode = "local" | "remote";

export type RemoteWorkbenchBootstrap = {
  baseUrl: string;
  rpcPath?: string;
  eventsPath?: string;
  headers?: StringRecord;
  websocketProtocols?: string | string[];
};

export type WorkbenchBootstrapWindow = {
  location?: {
    search?: string;
  };
  workbench?: WorkbenchClientApi;
  workbenchRemoteBootstrap?: RemoteWorkbenchBootstrap;
};

export type WorkbenchBootstrapEnv = Record<string, string | boolean | undefined>;

export type WorkbenchBootstrapSelection = {
  mode: WorkbenchBootstrapMode;
  api: WorkbenchClientApi;
  label: string;
};

export type WorkbenchBootstrapDependencies = {
  createRemoteClientApi?: (bootstrap: RemoteWorkbenchBootstrap) => WorkbenchClientApi;
};

const normalizeString = (value: string | undefined | null): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeMode = (
  value: string | undefined | null
): WorkbenchBootstrapMode | undefined => {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === "local" || normalized === "remote") {
    return normalized;
  }
  return undefined;
};

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

const resolveRelativeUrl = (baseUrl: string, path: string): string =>
  new URL(path, normalizeBaseUrl(baseUrl)).toString();

const toWebSocketUrl = (value: string): string => {
  const url = new URL(value);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  return url.toString();
};

const parseHeaders = (value: string | undefined): StringRecord | undefined => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }
  const parsed = JSON.parse(normalized) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Remote headers must be a JSON object.");
  }
  const headers: StringRecord = {};
  for (const [key, headerValue] of Object.entries(parsed)) {
    if (typeof headerValue !== "string") {
      throw new Error(`Remote header ${key} must be a string.`);
    }
    headers[key] = headerValue;
  }
  return headers;
};

const parseProtocols = (
  value: string | undefined
): string | string[] | undefined => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.includes(",")
    ? normalized
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    : normalized;
};

const resolveRemoteBootstrap = (input: {
  env?: WorkbenchBootstrapEnv;
  window?: WorkbenchBootstrapWindow;
}): RemoteWorkbenchBootstrap | undefined => {
  const searchParams = new URLSearchParams(input.window?.location?.search ?? "");
  const windowBootstrap = input.window?.workbenchRemoteBootstrap;

  const baseUrl =
    normalizeString(searchParams.get("workbenchRemoteUrl")) ??
    normalizeString(windowBootstrap?.baseUrl) ??
    normalizeString(
      typeof input.env?.VITE_WORKBENCH_REMOTE_URL === "string"
        ? input.env.VITE_WORKBENCH_REMOTE_URL
        : undefined
    );

  if (!baseUrl) {
    return undefined;
  }

  const headersFromEnv =
    typeof input.env?.VITE_WORKBENCH_REMOTE_HEADERS === "string"
      ? parseHeaders(input.env.VITE_WORKBENCH_REMOTE_HEADERS)
      : undefined;
  const headersFromQuery = parseHeaders(
    normalizeString(searchParams.get("workbenchRemoteHeaders")) ?? undefined
  );

  return {
    baseUrl,
    rpcPath:
      normalizeString(searchParams.get("workbenchRemoteRpcPath")) ??
      normalizeString(windowBootstrap?.rpcPath) ??
      normalizeString(
        typeof input.env?.VITE_WORKBENCH_REMOTE_RPC_PATH === "string"
          ? input.env.VITE_WORKBENCH_REMOTE_RPC_PATH
          : undefined
      ) ??
      "rpc",
    eventsPath:
      normalizeString(searchParams.get("workbenchRemoteEventsPath")) ??
      normalizeString(windowBootstrap?.eventsPath) ??
      normalizeString(
        typeof input.env?.VITE_WORKBENCH_REMOTE_EVENTS_PATH === "string"
          ? input.env.VITE_WORKBENCH_REMOTE_EVENTS_PATH
          : undefined
      ) ??
      "events",
    headers: headersFromQuery ?? windowBootstrap?.headers ?? headersFromEnv,
    websocketProtocols:
      parseProtocols(normalizeString(searchParams.get("workbenchRemoteProtocols")) ?? undefined) ??
      windowBootstrap?.websocketProtocols ??
      parseProtocols(
        typeof input.env?.VITE_WORKBENCH_REMOTE_PROTOCOLS === "string"
          ? input.env.VITE_WORKBENCH_REMOTE_PROTOCOLS
          : undefined
      )
  };
};

const createRemoteClientApiFromBootstrap = (
  bootstrap: RemoteWorkbenchBootstrap
): WorkbenchClientApi =>
  createRemoteWorkbenchClientApi({
    httpUrl: resolveRelativeUrl(bootstrap.baseUrl, bootstrap.rpcPath ?? "rpc"),
    websocketUrl: toWebSocketUrl(
      resolveRelativeUrl(bootstrap.baseUrl, bootstrap.eventsPath ?? "events")
    ),
    headers: bootstrap.headers,
    websocketProtocols: bootstrap.websocketProtocols
  });

export const resolveWorkbenchClientApi = (
  input: {
    env?: WorkbenchBootstrapEnv;
    window?: WorkbenchBootstrapWindow;
  } = {},
  dependencies: WorkbenchBootstrapDependencies = {}
): WorkbenchBootstrapSelection => {
  const requestedMode =
    normalizeMode(input.window?.location ? new URLSearchParams(input.window.location.search ?? "").get("workbenchMode") : undefined) ??
    normalizeMode(
      typeof input.env?.VITE_WORKBENCH_MODE === "string"
        ? input.env.VITE_WORKBENCH_MODE
        : undefined
    );

  const localApi = input.window?.workbench;
  const remoteBootstrap = resolveRemoteBootstrap(input);
  const createRemoteClientApi =
    dependencies.createRemoteClientApi ?? createRemoteClientApiFromBootstrap;

  if (requestedMode === "local") {
    if (!localApi) {
      throw new Error(
        "Local workbench mode was requested, but the Electron preload API is missing."
      );
    }
    return {
      mode: "local",
      api: localApi,
      label: "local"
    };
  }

  if (requestedMode === "remote") {
    if (!remoteBootstrap) {
      throw new Error(
        "Remote workbench mode was requested, but no remote bootstrap URL was configured."
      );
    }
    return {
      mode: "remote",
      api: createRemoteClientApi(remoteBootstrap),
      label: remoteBootstrap.baseUrl
    };
  }

  if (localApi) {
    return {
      mode: "local",
      api: localApi,
      label: "local"
    };
  }

  if (remoteBootstrap) {
    return {
      mode: "remote",
      api: createRemoteClientApi(remoteBootstrap),
      label: remoteBootstrap.baseUrl
    };
  }

  throw new Error(
    "No workbench client API is available. Launch the Electron desktop host for local mode, or configure remote mode with VITE_WORKBENCH_MODE=remote plus VITE_WORKBENCH_REMOTE_URL."
  );
};
