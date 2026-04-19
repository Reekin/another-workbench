const writeCharacter = (line: string, position: number, char: string): string => {
  if (position >= line.length) {
    return `${line}${" ".repeat(position - line.length)}${char}`;
  }
  return `${line.slice(0, position)}${char}${line.slice(position + 1)}`;
};

export const normalizeTerminalOutput = (output: string): string => {
  if (!output) {
    return "";
  }

  const lines: string[] = [""];
  let lineIndex = 0;
  let columnIndex = 0;

  for (const char of output) {
    if (char === "\r") {
      columnIndex = 0;
      continue;
    }
    if (char === "\n") {
      lineIndex += 1;
      lines[lineIndex] = lines[lineIndex] ?? "";
      columnIndex = 0;
      continue;
    }

    lines[lineIndex] = writeCharacter(lines[lineIndex] ?? "", columnIndex, char);
    columnIndex += 1;
  }

  return lines.join("\n");
};
