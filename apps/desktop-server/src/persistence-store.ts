import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class PersistentStoreCorruptionError extends Error {
  public readonly filePath: string;

  public constructor(filePath: string, cause: unknown) {
    super(`Failed to read persistent store: ${filePath}`);
    this.name = "PersistentStoreCorruptionError";
    this.filePath = filePath;
    this.cause = cause;
  }
}

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: string }).code === "ENOENT";

export const loadJsonFile = async <T>(
  filePath: string,
  fallback: T
): Promise<{ value: T; corrupted: boolean }> => {
  try {
    const raw = await readFile(filePath, "utf8");
    return {
      value: JSON.parse(raw) as T,
      corrupted: false
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        value: fallback,
        corrupted: false
      };
    }
    return {
      value: fallback,
      corrupted: true
    };
  }
};

export const saveJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(dirname(filePath), {
    recursive: true
  });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};
