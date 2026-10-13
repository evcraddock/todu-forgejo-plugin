import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createIntegrationBindingId, createTaskId } from "@todu/core";

import { createInMemoryForgejoIssueClient } from "@/forgejo-client";
import { createForgejoSyncProvider } from "@/forgejo-provider";
import {
  createFileForgejoIssueTombstoneStore,
  createInMemoryForgejoIssueTombstoneStore,
  type ForgejoIssueTombstone,
  type ForgejoIssueTombstoneStore,
} from "@/forgejo-tombstones";

const tombstone: ForgejoIssueTombstone = {
  bindingId: createIntegrationBindingId("binding-1"),
  taskId: createTaskId("task-7"),
  externalId: "https://code.example.com/acme/roadmap#7",
  issueNumber: 7,
  deletedAt: "2026-03-12T00:00:00.000Z",
  reason: "Confirmed remote issue deletion",
  source: "operator-confirmation",
};

describe.each(["memory", "file"] as const)("%s issue tombstones", (kind) => {
  let directory: string;
  let storagePath: string;
  let store: ForgejoIssueTombstoneStore;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-tombstones-"));
    storagePath = path.join(directory, "issue-tombstones.json");
    store =
      kind === "file"
        ? createFileForgejoIssueTombstoneStore(storagePath)
        : createInMemoryForgejoIssueTombstoneStore();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true });
  });

  it("starts empty without requiring a tombstone file", () => {
    expect(store.getByTaskId(tombstone.bindingId, tombstone.taskId)).toBeNull();
    expect(store.getByIssueNumber(tombstone.bindingId, 7)).toBeNull();
    expect(store.getByExternalId(tombstone.bindingId, tombstone.externalId)).toBeNull();
    expect(store.list(tombstone.bindingId)).toEqual([]);
    expect(store.listAll()).toEqual([]);
    expect(fs.existsSync(storagePath)).toBe(false);
  });

  it("round-trips every field and lookup, including a file-store restart", () => {
    store.save(tombstone);
    expect(store.getByTaskId(tombstone.bindingId, tombstone.taskId)).toStrictEqual(tombstone);
    expect(store.getByIssueNumber(tombstone.bindingId, 7)).toStrictEqual(tombstone);
    expect(store.getByExternalId(tombstone.bindingId, tombstone.externalId)).toStrictEqual(
      tombstone
    );
    expect(store.list(tombstone.bindingId)).toStrictEqual([tombstone]);
    expect(store.listAll()).toStrictEqual([tombstone]);
    if (kind === "file") {
      expect(createFileForgejoIssueTombstoneStore(storagePath).listAll()).toStrictEqual([
        tombstone,
      ]);
      expect(fs.statSync(storagePath).mode & 0o777).toBe(0o600);
    }
  });

  it("treats identical saves as idempotent without writing again", () => {
    store.save(tombstone);
    const rename = vi.spyOn(fs, "renameSync");
    store.save({ ...tombstone });
    expect(store.listAll()).toStrictEqual([tombstone]);
    expect(rename).not.toHaveBeenCalled();
  });

  it.each([
    { taskId: createTaskId("another-task") },
    { externalId: "https://other.example.com/acme/roadmap#7" },
    { issueNumber: 8, externalId: "https://code.example.com/acme/roadmap#8" },
    { deletedAt: "2026-03-13T00:00:00.000Z" },
    { reason: "Different reason" },
    { source: "Different source" },
  ])("rejects conflicting saves without replacing deletion evidence: %j", (changes) => {
    store.save(tombstone);
    expect(() => store.save({ ...tombstone, ...changes })).toThrow(
      "Conflicting Forgejo issue tombstone"
    );
    expect(store.listAll()).toStrictEqual([tombstone]);
  });

  it("isolates identical task, issue, and external IDs across bindings", () => {
    const other = { ...tombstone, bindingId: createIntegrationBindingId("binding-2") };
    store.save(tombstone);
    store.save(other);
    expect(store.listAll()).toHaveLength(2);
    expect(store.list(other.bindingId)).toStrictEqual([other]);
    expect(store.getByTaskId(other.bindingId, other.taskId)).toStrictEqual(other);
    expect(store.getByIssueNumber(other.bindingId, 7)).toStrictEqual(other);
    expect(store.getByExternalId(other.bindingId, other.externalId)).toStrictEqual(other);
    store.remove(tombstone.bindingId, tombstone.taskId);
    expect(store.listAll()).toStrictEqual([other]);
  });

  it("removes explicitly, persists removal, and allows a subsequent save", () => {
    store.save(tombstone);
    const second = {
      ...tombstone,
      taskId: createTaskId("task-8"),
      issueNumber: 8,
      externalId: "https://code.example.com/acme/roadmap#8",
    };
    store.save(second);
    store.remove(tombstone.bindingId, tombstone.taskId);
    store.remove(tombstone.bindingId, tombstone.taskId);
    expect(store.getByTaskId(tombstone.bindingId, tombstone.taskId)).toBeNull();
    expect(store.getByIssueNumber(tombstone.bindingId, 7)).toBeNull();
    expect(store.getByExternalId(tombstone.bindingId, tombstone.externalId)).toBeNull();
    expect(store.listAll()).toStrictEqual([second]);
    if (kind === "file")
      expect(createFileForgejoIssueTombstoneStore(storagePath).listAll()).toStrictEqual([second]);
    const replacement = { ...tombstone, reason: "Explicitly replaced evidence" };
    store.save(replacement);
    expect(store.list(tombstone.bindingId)).toStrictEqual([second, replacement]);
  });

  it("detaches writes and all read surfaces", () => {
    const input = { ...tombstone };
    store.save(input);
    input.reason = "Mutated input";
    for (const value of [
      store.getByTaskId(tombstone.bindingId, tombstone.taskId)!,
      store.getByIssueNumber(tombstone.bindingId, 7)!,
      store.getByExternalId(tombstone.bindingId, tombstone.externalId)!,
      store.list(tombstone.bindingId)[0],
      store.listAll()[0],
    ])
      value.reason = "Mutated read";
    expect(store.listAll()).toStrictEqual([tombstone]);
  });

  it.each([
    { bindingId: "" },
    { taskId: "" },
    { externalId: "not-an-identity" },
    { externalId: "https://code.example.com/acme/roadmap#7junk" },
    { issueNumber: 0 },
    { issueNumber: 1.5 },
    { issueNumber: 8 },
    { deletedAt: "not-a-date" },
    { reason: " " },
    { source: "" },
  ])("rejects malformed records without modifying valid state: %j", (changes) => {
    store.save(tombstone);
    expect(() => store.save({ ...tombstone, ...changes } as ForgejoIssueTombstone)).toThrow(
      "Invalid Forgejo issue tombstone"
    );
    expect(store.listAll()).toStrictEqual([tombstone]);
  });

  it("leaves durable evidence intact after a failed atomic replacement", () => {
    if (kind !== "file") return;
    store.save(tombstone);
    const raw = fs.readFileSync(storagePath, "utf8");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("injected replacement failure");
    });
    expect(() => store.remove(tombstone.bindingId, tombstone.taskId)).toThrow(
      "replacement failure"
    );
    expect(fs.readFileSync(storagePath, "utf8")).toBe(raw);
    expect(store.listAll()).toStrictEqual([tombstone]);
    expect(fs.readdirSync(directory)).toEqual(["issue-tombstones.json"]);
  });
});

describe("provider tombstone storage", () => {
  let directory: string;
  const config = { settings: { baseUrl: "https://code.example.com", token: "test-token" } };
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-tombstone-provider-"));
  });
  afterEach(() => fs.rmSync(directory, { recursive: true }));

  it("loads legacy storage without creating or altering state files", async () => {
    for (const filename of ["item-links.json", "comment-links.json", "runtime-state.json"]) {
      fs.writeFileSync(path.join(directory, filename), "[]\n");
    }
    const provider = createForgejoSyncProvider({ issueClient: createInMemoryForgejoIssueClient() });
    await provider.initialize({ settings: { ...config.settings, storageDir: directory } });
    expect(provider.getState().issueTombstones).toEqual([]);
    expect(fs.readdirSync(directory).sort()).toEqual([
      "comment-links.json",
      "item-links.json",
      "runtime-state.json",
    ]);
    for (const filename of fs.readdirSync(directory))
      expect(fs.readFileSync(path.join(directory, filename), "utf8")).toBe("[]\n");
  });

  it("uses configured file storage and reloads tombstones after shutdown and restart", async () => {
    const storagePath = path.join(directory, "issue-tombstones.json");
    const provider = createForgejoSyncProvider({ issueClient: createInMemoryForgejoIssueClient() });
    const fileConfig = { settings: { ...config.settings, storageDir: directory } };
    await provider.initialize(fileConfig);
    createFileForgejoIssueTombstoneStore(storagePath).save(tombstone);
    expect(provider.getState().issueTombstones).toStrictEqual([tombstone]);
    provider.getState().issueTombstones[0].reason = "Mutated diagnostic state";
    await provider.shutdown();
    expect(provider.getState().issueTombstones).toEqual([]);
    await provider.initialize(fileConfig);
    expect(provider.getState().issueTombstones).toStrictEqual([tombstone]);
    const restarted = createForgejoSyncProvider({
      issueClient: createInMemoryForgejoIssueClient(),
    });
    await restarted.initialize(fileConfig);
    expect(restarted.getState().issueTombstones).toStrictEqual([tombstone]);
  });

  it("defaults to memory without storageDir and honors an injected store", async () => {
    const provider = createForgejoSyncProvider({ issueClient: createInMemoryForgejoIssueClient() });
    await provider.initialize(config);
    expect(provider.getState().issueTombstones).toEqual([]);
    const injected = createInMemoryForgejoIssueTombstoneStore();
    injected.save(tombstone);
    const custom = createForgejoSyncProvider({
      issueClient: createInMemoryForgejoIssueClient(),
      tombstoneStore: injected,
    });
    await custom.initialize({ settings: { ...config.settings, storageDir: directory } });
    expect(custom.getState().issueTombstones).toStrictEqual([tombstone]);
    await custom.shutdown();
    expect(custom.getState().issueTombstones).toStrictEqual([tombstone]);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("migrates existing tombstones with the other plugin state", async () => {
    const legacyStorageDir = path.join(directory, "legacy");
    const storageDir = path.join(directory, "state");
    createFileForgejoIssueTombstoneStore(path.join(legacyStorageDir, "issue-tombstones.json")).save(
      tombstone
    );
    const provider = createForgejoSyncProvider({ issueClient: createInMemoryForgejoIssueClient() });
    await provider.initialize({ settings: { ...config.settings, storageDir, legacyStorageDir } });
    expect(provider.getState().issueTombstones).toStrictEqual([tombstone]);
    expect(fs.existsSync(legacyStorageDir)).toBe(false);
  });
});

describe("existing tombstone files", () => {
  let directory: string;
  let storagePath: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-tombstones-invalid-"));
    storagePath = path.join(directory, "issue-tombstones.json");
  });
  afterEach(() => fs.rmSync(directory, { recursive: true }));

  it.each([
    "",
    "not-json",
    "{}",
    "[null]",
    "[{}]",
    JSON.stringify([{ ...tombstone, issueNumber: 8 }]),
    JSON.stringify([tombstone, { ...tombstone, taskId: "other-task" }]),
  ])("fails explicitly on malformed/conflicting storage instead of clearing it: %s", (raw) => {
    fs.writeFileSync(storagePath, raw);
    const store = createFileForgejoIssueTombstoneStore(storagePath);
    expect(() => store.listAll()).toThrow(/Forgejo issue tombstone/);
    expect(() => store.save(tombstone)).toThrow(/Forgejo issue tombstone/);
    expect(() => store.remove(tombstone.bindingId, tombstone.taskId)).toThrow(
      /Forgejo issue tombstone/
    );
    expect(fs.readFileSync(storagePath, "utf8")).toBe(raw);
  });

  it("deduplicates identical records in an existing file", () => {
    fs.writeFileSync(storagePath, JSON.stringify([tombstone, tombstone]));
    expect(createFileForgejoIssueTombstoneStore(storagePath).listAll()).toStrictEqual([tombstone]);
  });
});
