export type ExternalNavigationDecision =
  | {
      action: "allow";
    }
  | {
      action: "deny";
      externalUrl?: string;
    };

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "file:"]);

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

export const isExternalOpenUrl = (value: string): boolean => {
  const url = parseUrl(value);
  return Boolean(url && EXTERNAL_PROTOCOLS.has(url.protocol));
};

const isSameRendererNavigation = (targetUrl: URL, currentUrl: URL): boolean => {
  if (currentUrl.protocol === "file:") {
    return targetUrl.protocol === "file:" && targetUrl.pathname === currentUrl.pathname;
  }
  if (currentUrl.protocol === "http:" || currentUrl.protocol === "https:") {
    return targetUrl.origin === currentUrl.origin;
  }
  return false;
};

export const resolveWindowOpenNavigation = (
  targetUrl: string
): ExternalNavigationDecision =>
  isExternalOpenUrl(targetUrl)
    ? {
        action: "deny",
        externalUrl: targetUrl
      }
    : {
        action: "deny"
      };

export const resolveWillNavigate = (
  targetUrl: string,
  currentUrl: string
): ExternalNavigationDecision => {
  const target = parseUrl(targetUrl);
  const current = parseUrl(currentUrl);
  if (!target) {
    return {
      action: "deny"
    };
  }
  if (current && isSameRendererNavigation(target, current)) {
    return {
      action: "allow"
    };
  }
  return isExternalOpenUrl(targetUrl)
    ? {
        action: "deny",
        externalUrl: targetUrl
      }
    : {
        action: "deny"
      };
};
