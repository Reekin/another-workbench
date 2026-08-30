import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

const isReplaceFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  ["EACCES", "EEXIST", "EPERM"].includes((error as { code?: string }).code ?? "");

const backupPathFor = (filePath: string): string => `${filePath}.bak`;

const tempPathFor = (filePath: string, purpose: string): string =>
  `${filePath}.${purpose}-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.tmp`;

const readJson = async <T>(
  filePath: string
): Promise<
  | { status: "found"; value: T }
  | { status: "missing" }
  | { status: "corrupted"; error: unknown }
> => {
  try {
    const raw = await readFile(filePath, "utf8");
    return {
      status: "found",
      value: JSON.parse(raw) as T
    };
  } catch (error) {
    return isMissingFileError(error)
      ? { status: "missing" }
      : { status: "corrupted", error };
  }
};

const replaceFile = async (sourcePath: string, destinationPath: string): Promise<void> => {
  try {
    await rename(sourcePath, destinationPath);
  } catch (error) {
    if (!isReplaceFileError(error)) {
      throw error;
    }
    await rm(destinationPath, { force: true });
    await rename(sourcePath, destinationPath);
  }
};

const restorePrimaryFromBackup = async (
  filePath: string,
  backupPath: string,
  primaryWasCorrupted: boolean
): Promise<void> => {
  const restorePath = tempPathFor(filePath, "restore");
  try {
    await copyFile(backupPath, restorePath);
    if (primaryWasCorrupted) {
      await rename(
        filePath,
        `${filePath}.corrupt-${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`
      );
    }
    await replaceFile(restorePath, filePath);
  } finally {
    await rm(restorePath, { force: true });
  }
};

export const loadJsonFile = async <T>(
  filePath: string,
  fallback: T
): Promise<{ value: T; recoveredFromBackup: boolean }> => {
  const primary = await readJson<T>(filePath);
  if (primary.status === "found") {
    return {
      value: primary.value,
      recoveredFromBackup: false
    };
  }

  const backupPath = backupPathFor(filePath);
  const backup = await readJson<T>(backupPath);
  if (backup.status === "found") {
    await restorePrimaryFromBackup(
      filePath,
      backupPath,
      primary.status === "corrupted"
    );
    return {
      value: backup.value,
      recoveredFromBackup: true
    };
  }

  if (primary.status === "missing" && backup.status === "missing") {
    return {
      value: fallback,
      recoveredFromBackup: false
    };
  }

  throw new PersistentStoreCorruptionError(
    filePath,
    primary.status === "corrupted" ? primary.error : backup
  );
};

export const saveJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(dirname(filePath), {
    recursive: true
  });
  const tempPath = tempPathFor(filePath, "write");
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      await replaceFile(filePath, backupPathFor(filePath));
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    await replaceFile(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
};
