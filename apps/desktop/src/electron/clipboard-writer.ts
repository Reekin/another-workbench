import type { ElectronDiagnosticsLogger } from "./electron-diagnostics.js";

type ClipboardTextPort = {
  readText: () => string;
  writeText: (text: string) => void;
};

const normalizeClipboardText = (text: string): string =>
  text.replaceAll("\r\n", "\n");

export const writeVerifiedClipboardText = (
  clipboard: ClipboardTextPort,
  diagnostics: ElectronDiagnosticsLogger,
  text: string
): void => {
  let actualLength: number | undefined;
  try {
    clipboard.writeText(text);
    const actual = clipboard.readText();
    actualLength = actual.length;
    if (normalizeClipboardText(actual) !== normalizeClipboardText(text)) {
      throw new Error("Clipboard contents did not match the requested text.");
    }
  } catch (error) {
    diagnostics.logSync({
      severity: "error",
      source: "clipboard",
      message: "Failed to write clipboard text.",
      details: {
        requestedLength: text.length,
        actualLength,
        error: error instanceof Error ? error.message : String(error)
      }
    });
    throw error;
  }
};
