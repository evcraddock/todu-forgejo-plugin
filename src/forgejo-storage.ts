import fs from "node:fs";
import path from "node:path";

export const FORGEJO_STORAGE_STATE_FILES = [
  "item-links.json",
  "comment-links.json",
  "runtime-state.json",
] as const;

export interface ForgejoLegacyStorageMigrationOptions {
  storageDir: string | null;
  legacyStorageDir: string | null;
}

export interface ForgejoLegacyStorageMigrationResult {
  migratedFiles: string[];
  skippedFiles: string[];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function moveFileWithoutOverwrite(sourcePath: string, destinationPath: string): void {
  if (fs.existsSync(destinationPath)) {
    throw new Error(
      `Cannot migrate Forgejo storage file ${sourcePath}: destination already exists at ${destinationPath}`
    );
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  try {
    fs.renameSync(sourcePath, destinationPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EXDEV") {
      throw error;
    }

    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(sourcePath);
  }
}

export function migrateForgejoLegacyStorage(
  options: ForgejoLegacyStorageMigrationOptions
): ForgejoLegacyStorageMigrationResult {
  const { storageDir, legacyStorageDir } = options;
  if (
    !storageDir ||
    !legacyStorageDir ||
    path.resolve(storageDir) === path.resolve(legacyStorageDir)
  ) {
    return { migratedFiles: [], skippedFiles: [...FORGEJO_STORAGE_STATE_FILES] };
  }

  if (!fs.existsSync(legacyStorageDir)) {
    return { migratedFiles: [], skippedFiles: [...FORGEJO_STORAGE_STATE_FILES] };
  }

  const legacyStats = fs.statSync(legacyStorageDir);
  if (!legacyStats.isDirectory()) {
    throw new Error(
      `Cannot migrate Forgejo storage from ${legacyStorageDir}: expected a directory`
    );
  }

  const migratedFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const filename of FORGEJO_STORAGE_STATE_FILES) {
    const sourcePath = path.join(legacyStorageDir, filename);
    const destinationPath = path.join(storageDir, filename);

    if (!fs.existsSync(sourcePath)) {
      skippedFiles.push(filename);
      continue;
    }

    const sourceStats = fs.statSync(sourcePath);
    if (!sourceStats.isFile()) {
      throw new Error(`Cannot migrate Forgejo storage file ${sourcePath}: expected a file`);
    }

    moveFileWithoutOverwrite(sourcePath, destinationPath);
    migratedFiles.push(filename);
  }

  if (migratedFiles.length > 0) {
    try {
      fs.rmdirSync(legacyStorageDir);
    } catch (error) {
      if (!isNodeError(error) || (error.code !== "ENOTEMPTY" && error.code !== "ENOENT")) {
        throw error;
      }
    }
  }

  return { migratedFiles, skippedFiles };
}
