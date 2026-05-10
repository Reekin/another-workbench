export const MAX_STREAM_EVENT_CHUNK_LENGTH = 16_384;
export const MAX_ACCUMULATED_STREAM_TEXT_LENGTH = 200_000;

const truncationMarker = (omittedCharacterCount: number): string =>
  `\n[another-workbench truncated ${omittedCharacterCount} characters of stream output]\n`;

export const limitSingleStreamChunk = (
  value: string,
  maxLength = MAX_STREAM_EVENT_CHUNK_LENGTH
): string => {
  if (value.length <= maxLength) {
    return value;
  }
  const marker = truncationMarker(value.length - maxLength);
  const available = Math.max(0, maxLength - marker.length);
  return `${value.slice(0, available)}${marker}`;
};

export const appendLimitedStreamText = (
  existing: string | undefined,
  addition: string | undefined,
  maxLength = MAX_ACCUMULATED_STREAM_TEXT_LENGTH
): string => {
  const combined = `${existing ?? ""}${addition ?? ""}`;
  if (combined.length <= maxLength) {
    return combined;
  }
  const marker = truncationMarker(combined.length - maxLength);
  const available = Math.max(0, maxLength - marker.length);
  return `${marker}${combined.slice(combined.length - available)}`;
};
