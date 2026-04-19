const windowsUncExtendedPrefix = /^\\\\\?\\UNC\\/i;
const windowsExtendedPrefix = /^\\\\\?\\/i;

const trimTrailingPathSeparators = (value: string): string => {
  if (/^[a-z]:\/$/i.test(value)) {
    return value;
  }
  if (/^\/\/[^/]+\/[^/]+$/i.test(value)) {
    return value;
  }
  return value.replace(/\/+$/, "");
};

export const stripWindowsExtendedPathPrefix = (value: string): string => {
  if (windowsUncExtendedPrefix.test(value)) {
    return value.replace(windowsUncExtendedPrefix, "\\\\");
  }
  if (windowsExtendedPrefix.test(value)) {
    return value.replace(windowsExtendedPrefix, "");
  }
  return value;
};

export const toDisplayPath = (value: string): string =>
  stripWindowsExtendedPathPrefix(value.trim());

export const normalizePathForIdentity = (value: string): string => {
  const normalized = trimTrailingPathSeparators(
    toDisplayPath(value).replace(/\\/g, "/")
  );
  return normalized.toLowerCase();
};

export const arePathsEquivalent = (left: string, right: string): boolean =>
  normalizePathForIdentity(left) === normalizePathForIdentity(right);

export const isPathInsideWorkspace = (
  candidatePath: string,
  workspaceRoot: string
): boolean => {
  const normalizedCandidate = normalizePathForIdentity(candidatePath);
  const normalizedWorkspace = normalizePathForIdentity(workspaceRoot);
  if (normalizedCandidate === normalizedWorkspace) {
    return true;
  }
  const workspacePrefix = normalizedWorkspace.endsWith("/")
    ? normalizedWorkspace
    : `${normalizedWorkspace}/`;
  return normalizedCandidate.startsWith(workspacePrefix);
};
