import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { WorkspaceFileSearchResultRpc } from "@another-workbench/shared";
import { createFileReferenceFromPath } from "@another-workbench/shared";
import type { WorkspaceRecord } from "./workspace-registry.js";

const ignoredDirectoryNames = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache"
]);

const defaultScanBudget = 5_000;
const defaultResultLimit = 40;

const toPortablePath = (value: string): string => value.replace(/\\/gu, "/");

const resolveMatchScore = (relativePath: string, fileName: string, query: string): number => {
  const relativeLower = relativePath.toLowerCase();
  const fileLower = fileName.toLowerCase();

  if (fileLower === query) {
    return 100;
  }
  if (fileLower.startsWith(query)) {
    return 80;
  }
  if (fileLower.includes(query)) {
    return 60;
  }
  if (relativeLower.includes(query)) {
    return 35;
  }
  return 0;
};

export type WorkspaceFileSearchServiceOptions = {
  maxEntriesScanned?: number;
};

export class WorkspaceFileSearchService {
  private readonly maxEntriesScanned: number;

  public constructor(options: WorkspaceFileSearchServiceOptions = {}) {
    this.maxEntriesScanned = options.maxEntriesScanned ?? defaultScanBudget;
  }

  public async searchWorkspace(input: {
    workspace: WorkspaceRecord;
    query: string;
    limit?: number;
  }): Promise<WorkspaceFileSearchResultRpc[]> {
    const trimmedQuery = input.query.trim().toLowerCase();
    if (!trimmedQuery) {
      return [];
    }

    const limit = input.limit ?? defaultResultLimit;
    const results: WorkspaceFileSearchResultRpc[] = [];
    const directories: string[] = [input.workspace.absolutePath];
    let scannedEntries = 0;

    while (directories.length > 0 && scannedEntries < this.maxEntriesScanned) {
      const currentDirectory = directories.shift();
      if (!currentDirectory) {
        continue;
      }

      let entries;
      try {
        entries = await readdir(currentDirectory, {
          withFileTypes: true,
          encoding: "utf8"
        });
      } catch {
        continue;
      }

      for (const entry of entries) {
        scannedEntries += 1;
        if (scannedEntries > this.maxEntriesScanned) {
          break;
        }

        const absolutePath = join(currentDirectory, entry.name);
        if (entry.isDirectory()) {
          if (!ignoredDirectoryNames.has(entry.name)) {
            directories.push(absolutePath);
          }
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }

        const relativePath = toPortablePath(
          relative(input.workspace.absolutePath, absolutePath)
        );
        const matchScore = resolveMatchScore(relativePath, entry.name, trimmedQuery);
        if (matchScore <= 0) {
          continue;
        }

        results.push({
          ...createFileReferenceFromPath(absolutePath, "inline_path", entry.name),
          workspaceId: input.workspace.workspaceId,
          workspaceRoot: input.workspace.absolutePath,
          relativePath,
          matchScore
        });
      }
    }

    return results
      .sort((left, right) => {
        if (right.matchScore !== left.matchScore) {
          return right.matchScore - left.matchScore;
        }
        return left.relativePath.localeCompare(right.relativePath);
      })
      .slice(0, limit);
  }
}
