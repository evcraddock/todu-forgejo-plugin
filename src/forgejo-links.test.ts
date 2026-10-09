import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createIntegrationBindingId,
  createTaskId,
  type SyncTaskFieldGroupValues,
} from "@todu/core";

import {
  createFileForgejoItemLinkStore,
  createInMemoryForgejoItemLinkStore,
  updateForgejoItemFieldSnapshots,
  type ForgejoItemLink,
  type ForgejoItemLinkStore,
} from "@/forgejo-links";

const link: ForgejoItemLink = {
  bindingId: createIntegrationBindingId("binding-snapshots"),
  taskId: createTaskId("task-7"),
  issueNumber: 7,
  externalId: "https://code.example.com/acme/roadmap#7",
  lastMirroredAt: "2026-03-12T00:00:00.000Z",
};
const snapshots: SyncTaskFieldGroupValues = {
  content: { title: "Title", description: "Body" },
  workflow: { status: "active" },
  classification: { priority: "medium", labels: ["bug", "feature"] },
  assignment: { assignees: [{ externalAccountId: "12" }, { externalLogin: "alice" }] },
};

// The same behavior contract runs against both implementations.
describe.each(["memory", "file"] as const)("%s item-link field snapshots", (kind) => {
  let directory: string;
  let storagePath: string;
  let store: ForgejoItemLinkStore;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-snapshots-"));
    storagePath = path.join(directory, "item-links.json");
    store =
      kind === "file"
        ? createFileForgejoItemLinkStore(storagePath)
        : createInMemoryForgejoItemLinkStore();
  });
  afterEach(() => fs.rmSync(directory, { recursive: true }));

  it("round-trips all groups through every lookup and restart", () => {
    const saved = { ...link, fieldSnapshots: structuredClone(snapshots) };
    store.save(saved);
    expect(store.getByTaskId(link.bindingId, link.taskId)).toStrictEqual(saved);
    expect(store.getByIssueNumber(link.bindingId, 7)).toStrictEqual(saved);
    expect(store.list(link.bindingId)).toStrictEqual([saved]);
    expect(store.listAll()).toStrictEqual([saved]);
    if (kind === "file")
      expect(createFileForgejoItemLinkStore(storagePath).listAll()).toStrictEqual([saved]);
  });

  it("replaces one complete group without modifying any other group or mirror clock", () => {
    store.save({ ...link, fieldSnapshots: snapshots });
    updateForgejoItemFieldSnapshots(store, link.bindingId, link.taskId, {
      content: { title: "New title", description: "" },
    });
    const expected = { ...snapshots, content: { title: "New title", description: "" } };
    expect(store.getByTaskId(link.bindingId, link.taskId)).toStrictEqual({
      ...link,
      fieldSnapshots: expected,
    });
    updateForgejoItemFieldSnapshots(store, link.bindingId, link.taskId, {
      classification: { priority: "low", labels: [] },
      assignment: { assignees: [] },
    });
    expect(store.getByTaskId(link.bindingId, link.taskId)?.fieldSnapshots).toStrictEqual({
      ...expected,
      classification: { priority: "low", labels: [] },
      assignment: { assignees: [] },
    });
  });

  it("keeps legacy missing groups unknown and permits later explicit initialization", () => {
    if (kind === "file") fs.writeFileSync(storagePath, JSON.stringify([link]));
    else store.save(link);
    expect(store.getByTaskId(link.bindingId, link.taskId)).toStrictEqual(link);
    updateForgejoItemFieldSnapshots(store, link.bindingId, link.taskId, {});
    expect(store.getByTaskId(link.bindingId, link.taskId)).toStrictEqual(link);
    updateForgejoItemFieldSnapshots(store, link.bindingId, link.taskId, {
      workflow: { status: "done" },
    });
    expect(store.getByTaskId(link.bindingId, link.taskId)?.fieldSnapshots).toStrictEqual({
      workflow: { status: "done" },
    });
  });

  it("normalizes label/assignee ordering and duplicates before persistence", () => {
    store.save({
      ...link,
      fieldSnapshots: {
        ...snapshots,
        classification: { priority: "medium", labels: ["feature", "bug", "bug"] },
        assignment: {
          assignees: [
            { externalLogin: "alice" },
            { externalAccountId: "12", externalLogin: "renamed" },
            { externalAccountId: "12" },
          ],
        },
      },
    });
    expect(store.getByTaskId(link.bindingId, link.taskId)?.fieldSnapshots).toStrictEqual(snapshots);
    if (kind === "file")
      expect(JSON.parse(fs.readFileSync(storagePath, "utf8"))[0].fieldSnapshots).toStrictEqual(
        snapshots
      );
  });

  it("preserves baselines through metadata-only saves and real-task-ID relinking", () => {
    store.save({ ...link, fieldSnapshots: snapshots });
    const relinked = {
      ...link,
      taskId: createTaskId("real-task-7"),
      lastMirroredAt: "2026-03-12T00:01:00.000Z",
    };
    store.save(relinked);
    expect(store.getByTaskId(link.bindingId, link.taskId)).toBeNull();
    expect(store.getByIssueNumber(link.bindingId, 7)).toStrictEqual({
      ...relinked,
      fieldSnapshots: snapshots,
    });
    store.save({ ...relinked, lastMirroredAt: "2026-03-12T00:02:00.000Z" });
    expect(store.getByTaskId(link.bindingId, relinked.taskId)?.fieldSnapshots).toStrictEqual(
      snapshots
    );
    expect(store.listAll()).toHaveLength(1);
  });

  it("does not copy a baseline to a different remote identity when replacing a link", () => {
    store.save({ ...link, fieldSnapshots: snapshots });
    const different = {
      ...link,
      issueNumber: 8,
      externalId: "https://code.example.com/acme/roadmap#8",
    };
    store.save(different);
    expect(store.getByIssueNumber(link.bindingId, 7)).toBeNull();
    expect(store.getByTaskId(link.bindingId, link.taskId)).toStrictEqual(different);
    expect(store.listAll()).toStrictEqual([different]);
  });

  it("keeps bindings isolated even when task/issue/external identifiers are identical", () => {
    const otherBinding = createIntegrationBindingId("other-binding");
    store.save({ ...link, fieldSnapshots: snapshots });
    store.save({
      ...link,
      bindingId: otherBinding,
      fieldSnapshots: { content: { title: "Other binding", description: "" } },
    });
    updateForgejoItemFieldSnapshots(store, link.bindingId, link.taskId, {
      workflow: { status: "done" },
    });
    expect(store.listAll()).toHaveLength(2);
    expect(store.getByTaskId(otherBinding, link.taskId)?.fieldSnapshots).toStrictEqual({
      content: { title: "Other binding", description: "" },
    });
    store.remove(link.bindingId, link.taskId);
    expect(store.listAll()).toHaveLength(1);
    expect(store.getByIssueNumber(otherBinding, 7)).not.toBeNull();
  });

  it("detaches writes and every read surface from the persisted nested baselines", () => {
    const input = { ...link, fieldSnapshots: structuredClone(snapshots) };
    store.save(input);
    input.fieldSnapshots.content.title = "Mutated input";
    for (const read of [
      store.getByTaskId(link.bindingId, link.taskId)!,
      store.getByIssueNumber(link.bindingId, 7)!,
      store.list(link.bindingId)[0],
      store.listAll()[0],
    ]) {
      read.fieldSnapshots!.classification!.labels.push("Mutated read");
      read.fieldSnapshots!.assignment!.assignees[0].externalAccountId = "Changed ID";
      read.taskId = createTaskId("mutated-task");
    }
    expect(store.getByTaskId(link.bindingId, link.taskId)).toStrictEqual({
      ...link,
      fieldSnapshots: snapshots,
    });
  });

  it("rejects malformed replacements without changing valid stored data", () => {
    store.save({ ...link, fieldSnapshots: snapshots });
    const raw = kind === "file" ? fs.readFileSync(storagePath, "utf8") : null;
    expect(() =>
      store.save({
        ...link,
        fieldSnapshots: { workflow: { status: "invalid" } },
      } as unknown as ForgejoItemLink)
    ).toThrow("Invalid Forgejo field snapshot");
    expect(store.getByTaskId(link.bindingId, link.taskId)?.fieldSnapshots).toStrictEqual(snapshots);
    if (raw !== null) expect(fs.readFileSync(storagePath, "utf8")).toBe(raw);
    expect(() =>
      updateForgejoItemFieldSnapshots(store, link.bindingId, link.taskId, {
        assignment: { assignees: [{ displayName: "Unknown identity" }] },
      } as never)
    ).toThrow("Invalid Forgejo field snapshot");
  });

  it("keeps lookup/list replacement behavior consistent after updating one of multiple items", () => {
    const second = {
      ...link,
      taskId: createTaskId("task-8"),
      issueNumber: 8,
      externalId: "https://code.example.com/acme/roadmap#8",
      fieldSnapshots: snapshots,
    };
    store.save({ ...link, fieldSnapshots: snapshots });
    store.save(second);
    updateForgejoItemFieldSnapshots(store, link.bindingId, link.taskId, {
      workflow: { status: "done" },
    });
    const updated = store.getByTaskId(link.bindingId, link.taskId)!;
    expect(store.list(link.bindingId)).toStrictEqual([second, updated]);
    expect(store.listAll()).toStrictEqual([second, updated]);
    const relinked = { ...second, taskId: createTaskId("real-task-8") };
    store.save(relinked);
    expect(store.getByTaskId(link.bindingId, second.taskId)).toBeNull();
    expect(store.listAll()).toStrictEqual([updated, relinked]);
  });

  it("cannot initialize baselines for an unlinked task", () => {
    expect(() =>
      updateForgejoItemFieldSnapshots(store, link.bindingId, link.taskId, {
        content: snapshots.content,
      })
    ).toThrow("not linked");
    expect(store.listAll()).toEqual([]);
  });
});

it("leaves the last valid snapshot file intact when replacement fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-snapshot-write-"));
  try {
    const storagePath = path.join(directory, "item-links.json");
    const store = createFileForgejoItemLinkStore(storagePath);
    store.save({ ...link, fieldSnapshots: snapshots });
    const raw = fs.readFileSync(storagePath, "utf8");
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("injected snapshot replacement failure");
    });
    expect(() =>
      updateForgejoItemFieldSnapshots(store, link.bindingId, link.taskId, {
        workflow: { status: "done" },
      })
    ).toThrow("replacement failure");
    rename.mockRestore();
    expect(fs.readFileSync(storagePath, "utf8")).toBe(raw);
    expect(store.getByTaskId(link.bindingId, link.taskId)?.fieldSnapshots).toStrictEqual(snapshots);
    expect(fs.readdirSync(directory)).toEqual(["item-links.json"]);
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true });
  }
});

it("rejects malformed snapshots in an existing file rather than resetting them", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-snapshot-invalid-"));
  try {
    const storagePath = path.join(directory, "item-links.json");
    const raw = JSON.stringify([
      {
        ...link,
        fieldSnapshots: { assignment: { assignees: [{ displayName: "Not an identity" }] } },
      },
    ]);
    fs.writeFileSync(storagePath, raw);
    expect(() => createFileForgejoItemLinkStore(storagePath).listAll()).toThrow(
      "Invalid Forgejo field snapshot"
    );
    expect(fs.readFileSync(storagePath, "utf8")).toBe(raw);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
