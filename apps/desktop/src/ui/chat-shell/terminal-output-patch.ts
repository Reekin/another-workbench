export type TerminalOutputPatch = {
  shouldReset: boolean;
  writeText: string;
  nextAppliedLength: number;
};

export const computeTerminalOutputPatch = (
  appliedLength: number,
  nextOutputText: string
): TerminalOutputPatch => {
  if (appliedLength <= 0) {
    return {
      shouldReset: false,
      writeText: nextOutputText,
      nextAppliedLength: nextOutputText.length
    };
  }

  if (nextOutputText.length < appliedLength) {
    return {
      shouldReset: true,
      writeText: nextOutputText,
      nextAppliedLength: nextOutputText.length
    };
  }

  return {
    shouldReset: false,
    writeText: nextOutputText.slice(appliedLength),
    nextAppliedLength: nextOutputText.length
  };
};

