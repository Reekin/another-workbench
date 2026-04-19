export type ProcessVisibilityOverride = "expanded" | "collapsed";

export const resolveProcessExpanded = (
  defaultExpanded: boolean,
  override?: ProcessVisibilityOverride
): boolean => {
  if (!override) {
    return defaultExpanded;
  }
  return override === "expanded";
};

export const toggleProcessVisibility = (
  current: Record<string, ProcessVisibilityOverride>,
  turnId: string,
  defaultExpanded: boolean
): Record<string, ProcessVisibilityOverride> => {
  const effectiveExpanded = resolveProcessExpanded(defaultExpanded, current[turnId]);
  const nextExpanded = !effectiveExpanded;
  const nextOverride =
    nextExpanded === defaultExpanded
      ? undefined
      : ((nextExpanded ? "expanded" : "collapsed") as ProcessVisibilityOverride);

  if (!nextOverride) {
    if (!(turnId in current)) {
      return current;
    }
    const next = { ...current };
    delete next[turnId];
    return next;
  }

  if (current[turnId] === nextOverride) {
    return current;
  }

  return {
    ...current,
    [turnId]: nextOverride
  };
};
