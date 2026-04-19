import { URL } from "node:url";

export type RemoteAuthConfig = {
  token: string;
  headerName?: string;
  queryParam?: string;
};

export type RemoteAuthRequestLike = {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
};

const normalizeHeaderValue = (
  value: string | string[] | undefined
): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

const stripBearerPrefix = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : value;
};

export const isRemoteRequestAuthorized = (
  request: RemoteAuthRequestLike,
  config?: RemoteAuthConfig
): boolean => {
  if (!config) {
    return true;
  }

  const headerName = (config.headerName ?? "authorization").toLowerCase();
  const queryParam = config.queryParam ?? "token";
  const headerToken = stripBearerPrefix(
    normalizeHeaderValue(request.headers[headerName])
  );
  if (headerToken === config.token) {
    return true;
  }

  if (!request.url) {
    return false;
  }

  try {
    const url = new URL(request.url, "http://remote-auth.local");
    return url.searchParams.get(queryParam) === config.token;
  } catch {
    return false;
  }
};

export const getRemoteAuthErrorBody = () => ({
  ok: false,
  error: {
    code: "REMOTE_UNAUTHORIZED",
    message: "Missing or invalid remote auth token"
  }
});
