import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadJsonFile,
  PersistentStoreCorruptionError,
  saveJsonFile
} from "../src/persistence-store.js";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-persistence-store-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("persistence store", () => {
  it("atomically replaces the primary file and retains the previous generation", async () => {
    const baseDir = await createTempDir();
    const filePath = join(baseDir, "store.json");

    await saveJsonFile(filePath, { revision: 1 });
    await saveJsonFile(filePath, { revision: 2 });

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ revision: 2 });
    expect(JSON.parse(await readFile(`${filePath}.bak`, "utf8"))).toEqual({
      revision: 1
    });
  });

  it("restores a corrupted primary file from the last valid backup", async () => {
    const baseDir = await createTempDir();
    const filePath = join(baseDir, "store.json");
    await writeFile(filePath, "{truncated", "utf8");
    await writeFile(`${filePath}.bak`, JSON.stringify({ revision: 7 }), "utf8");

    const loaded = await loadJsonFile(filePath, { revision: 0 });

    expect(loaded).toEqual({
      value: { revision: 7 },
      recoveredFromBackup: true
    });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ revision: 7 });
    expect((await readdir(baseDir)).some((name) => name.startsWith("store.json.corrupt-")))
      .toBe(true);
  });

  it("fails closed when neither the primary nor backup contains valid JSON", async () => {
    const baseDir = await createTempDir();
    const filePath = join(baseDir, "store.json");
    await writeFile(filePath, "{truncated", "utf8");

    await expect(loadJsonFile(filePath, { revision: 0 })).rejects.toBeInstanceOf(
      PersistentStoreCorruptionError
    );
    expect(await readFile(filePath, "utf8")).toBe("{truncated");
  });
});
