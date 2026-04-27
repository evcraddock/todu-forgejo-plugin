import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrateForgejoLegacyStorage } from "@/forgejo-storage";

describe("forgejo storage", () => {
  const tempDirs: string[] = [];

  const createTempDir = (): string => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "todu-forgejo-storage-"));
    tempDirs.push(tempDir);
    return tempDir;
  };

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("moves known legacy storage files into the configured storage directory", () => {
    const rootDir = createTempDir();
    const legacyStorageDir = path.join(rootDir, "legacy");
    const storageDir = path.join(rootDir, "state");
    fs.mkdirSync(legacyStorageDir, { recursive: true });
    fs.writeFileSync(path.join(legacyStorageDir, "item-links.json"), "[]\n", "utf8");
    fs.writeFileSync(path.join(legacyStorageDir, "comment-links.json"), "[]\n", "utf8");
    fs.writeFileSync(path.join(legacyStorageDir, "runtime-state.json"), "[]\n", "utf8");

    const result = migrateForgejoLegacyStorage({ storageDir, legacyStorageDir });

    expect(result.migratedFiles).toEqual([
      "item-links.json",
      "comment-links.json",
      "runtime-state.json",
    ]);
    expect(result.skippedFiles).toEqual([]);
    expect(fs.readFileSync(path.join(storageDir, "item-links.json"), "utf8")).toBe("[]\n");
    expect(fs.existsSync(path.join(legacyStorageDir, "item-links.json"))).toBe(false);
    expect(fs.existsSync(legacyStorageDir)).toBe(false);
  });

  it("leaves unknown legacy files in place", () => {
    const rootDir = createTempDir();
    const legacyStorageDir = path.join(rootDir, "legacy");
    const storageDir = path.join(rootDir, "state");
    fs.mkdirSync(legacyStorageDir, { recursive: true });
    fs.writeFileSync(path.join(legacyStorageDir, "item-links.json"), "[]\n", "utf8");
    fs.writeFileSync(path.join(legacyStorageDir, "custom.json"), "{}\n", "utf8");

    const result = migrateForgejoLegacyStorage({ storageDir, legacyStorageDir });

    expect(result.migratedFiles).toEqual(["item-links.json"]);
    expect(result.skippedFiles).toEqual(["comment-links.json", "runtime-state.json"]);
    expect(fs.existsSync(path.join(storageDir, "item-links.json"))).toBe(true);
    expect(fs.existsSync(path.join(legacyStorageDir, "custom.json"))).toBe(true);
  });

  it("does not overwrite existing destination files", () => {
    const rootDir = createTempDir();
    const legacyStorageDir = path.join(rootDir, "legacy");
    const storageDir = path.join(rootDir, "state");
    fs.mkdirSync(legacyStorageDir, { recursive: true });
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(path.join(legacyStorageDir, "item-links.json"), "legacy\n", "utf8");
    fs.writeFileSync(path.join(storageDir, "item-links.json"), "current\n", "utf8");

    expect(() => migrateForgejoLegacyStorage({ storageDir, legacyStorageDir })).toThrow(
      /destination already exists/
    );
    expect(fs.readFileSync(path.join(storageDir, "item-links.json"), "utf8")).toBe("current\n");
    expect(fs.readFileSync(path.join(legacyStorageDir, "item-links.json"), "utf8")).toBe(
      "legacy\n"
    );
  });

  it("skips migration when the legacy directory is missing", () => {
    const rootDir = createTempDir();
    const result = migrateForgejoLegacyStorage({
      storageDir: path.join(rootDir, "state"),
      legacyStorageDir: path.join(rootDir, "missing"),
    });

    expect(result.migratedFiles).toEqual([]);
    expect(result.skippedFiles).toEqual([
      "item-links.json",
      "comment-links.json",
      "runtime-state.json",
    ]);
  });
});
