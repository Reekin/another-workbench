export const writeClipboardText = async (text: string): Promise<void> => {
  const desktopWriter = window.workbenchDesktop?.writeClipboardText;
  if (desktopWriter) {
    await desktopWriter(text);
    return;
  }

  if (!navigator.clipboard) {
    throw new Error("Clipboard API is unavailable.");
  }
  await navigator.clipboard.writeText(text);
};
