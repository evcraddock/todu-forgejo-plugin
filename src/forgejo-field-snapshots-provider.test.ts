import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createIntegrationBindingId,
  createProjectId,
  createTaskId,
  type ExportedTaskInput,
  type SyncTaskFieldGroupValues,
} from "@todu/core";

import { createInMemoryForgejoIssueClient } from "@/forgejo-client";
import { createImportedTaskId } from "@/forgejo-ids";
import {
  createFileForgejoItemLinkStore,
  createInMemoryForgejoItemLinkStore,
  updateForgejoItemFieldSnapshots,
} from "@/forgejo-links";
import { createForgejoSyncProvider, syncProvider } from "@/forgejo-provider";

const binding = {
  id: createIntegrationBindingId("binding-snapshot-provider"),
  projectId: createProjectId("project-snapshot-provider"),
  provider: "forgejo",
  targetKind: "repository",
  targetRef: "acme/roadmap",
  strategy: "bidirectional" as const,
  enabled: true,
  createdAt: "2026-03-12T00:00:00.000Z",
  updatedAt: "2026-03-12T00:00:00.000Z",
};
const project = {
  id: binding.projectId,
  name: "Snapshot preservation",
  status: "active" as const,
  priority: "medium" as const,
  authorizedAssigneeActorIds: [],
  createdAt: binding.createdAt,
  updatedAt: binding.updatedAt,
};
const target = {
  baseUrl: "https://code.example.com",
  apiBaseUrl: "https://code.example.com/api/v1",
  owner: "acme",
  repo: "roadmap",
};
const issue = {
  number: 7,
  externalId: `${target.baseUrl}/acme/roadmap#7`,
  title: "Remote title",
  body: "Remote body",
  state: "open" as const,
  labels: ["status:active", "priority:medium"],
  assignees: [],
  createdAt: binding.createdAt,
  updatedAt: "2026-03-12T00:01:00.000Z",
};
const baseline: SyncTaskFieldGroupValues = {
  content: { title: "Known content", description: "Known body" },
  workflow: { status: "inprogress" },
  classification: { priority: "high", labels: ["known-label"] },
  assignment: { assignees: [{ externalAccountId: "12" }] },
};

// These are preservation tests, not field reconciliation or winner selection.
describe.each(["memory", "file"] as const)("%s provider snapshot preservation", (kind) => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-snapshot-provider-"));
  });
  afterEach(() => fs.rmSync(directory, { recursive: true }));

  async function fixture(withBaseline = true) {
    const storagePath = path.join(directory, "item-links.json");
    const linkStore =
      kind === "file"
        ? createFileForgejoItemLinkStore(storagePath)
        : createInMemoryForgejoItemLinkStore();
    if (withBaseline)
      linkStore.save({
        bindingId: binding.id,
        taskId: createImportedTaskId(issue.externalId),
        issueNumber: 7,
        externalId: issue.externalId,
        lastMirroredAt: binding.createdAt,
        fieldSnapshots: baseline,
      });
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [issue]);
    const config = {
      settings: {
        baseUrl: target.baseUrl,
        token: "test-token",
        ...(kind === "file" ? { storageDir: directory } : {}),
      },
    };
    const provider = createForgejoSyncProvider({ issueClient, linkStore });
    await provider.initialize(config);
    return { provider, issueClient, linkStore, storagePath, config };
  }

  it("never initializes or advances field baselines from an ordinary v4 pull/acknowledgment", async () => {
    const { provider } = await fixture(false);
    const batch = await provider.pull(binding, project);
    expect(provider.getState().itemLinks).toEqual([]);
    await provider.acknowledgePull(binding, batch.checkpoint, project);
    expect(provider.getState().itemLinks[0].fieldSnapshots).toBeUndefined();
    expect(syncProvider.manifest.apiVersion).toBe(4);
  });

  it("retains independently replaced baselines when stale staged metadata is acknowledged", async () => {
    const initial = await fixture();
    let { provider, linkStore } = initial;
    const { issueClient, storagePath, config } = initial;
    const batch = await provider.pull(binding, project);
    expect(linkStore.getByIssueNumber(binding.id, 7)?.lastMirroredAt).toBe(binding.createdAt);
    expect(linkStore.getByIssueNumber(binding.id, 7)?.fieldSnapshots).toStrictEqual(baseline);
    const classification = { priority: "low" as const, labels: ["new-baseline"] };
    updateForgejoItemFieldSnapshots(linkStore, binding.id, createImportedTaskId(issue.externalId), {
      classification,
    });
    if (kind === "file") {
      await provider.shutdown();
      linkStore = createFileForgejoItemLinkStore(storagePath);
      provider = createForgejoSyncProvider({ issueClient, linkStore });
      await provider.initialize(config);
      expect(await provider.pull(binding, project)).toEqual(batch);
    }
    await provider.acknowledgePull(binding, batch.checkpoint, project);
    const saved = linkStore.getByIssueNumber(binding.id, 7)!;
    expect(saved.lastMirroredAt).toBe(issue.updatedAt);
    expect(saved.fieldSnapshots).toStrictEqual({ ...baseline, classification });
    expect(provider.getState().runtimeStates[0].pendingPull).toBeNull();
    await provider.acknowledgePull(binding, batch.checkpoint, project);
    expect(linkStore.getByIssueNumber(binding.id, 7)?.fieldSnapshots).toStrictEqual(
      saved.fieldSnapshots
    );
  });

  it("preserves all groups when push replaces a provisional link with a real task ID", async () => {
    const { provider, issueClient, linkStore } = await fixture();
    const update = vi.spyOn(issueClient, "updateIssue");
    const task: ExportedTaskInput = {
      localTaskId: createTaskId("real-task-7"),
      externalId: issue.externalId,
      title: issue.title,
      description: issue.body,
      status: "active",
      priority: "medium",
      labels: [],
      assignees: [],
      comments: [],
      updatedAt: issue.updatedAt,
    };
    await provider.push(binding, [task], project);
    expect(linkStore.getByTaskId(binding.id, createImportedTaskId(issue.externalId))).toBeNull();
    expect(linkStore.getByTaskId(binding.id, task.localTaskId)?.fieldSnapshots).toStrictEqual(
      baseline
    );
    expect(linkStore.list(binding.id)).toHaveLength(1);
    expect(update).not.toHaveBeenCalled();
  });
});

it("rejects corrupted baseline data in a pending batch before any acknowledgment writes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-pending-snapshot-invalid-"));
  try {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [issue]);
    const linkStore = createFileForgejoItemLinkStore(path.join(directory, "item-links.json"));
    linkStore.save({
      bindingId: binding.id,
      taskId: createImportedTaskId(issue.externalId),
      issueNumber: 7,
      externalId: issue.externalId,
      lastMirroredAt: binding.createdAt,
      fieldSnapshots: baseline,
    });
    const provider = createForgejoSyncProvider({ issueClient, linkStore });
    await provider.initialize({
      settings: { baseUrl: target.baseUrl, token: "test-token", storageDir: directory },
    });
    await provider.pull(binding, project);
    const runtimePath = path.join(directory, "runtime-state.json");
    const states = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
    states[0].pendingPull.itemUpserts[0].fieldSnapshots.assignment = {
      assignees: [{ displayName: "Unknown identity" }],
    };
    const raw = JSON.stringify(states);
    fs.writeFileSync(runtimePath, raw);
    expect(() => provider.getState()).toThrow("Invalid Forgejo field snapshot");
    expect(fs.readFileSync(runtimePath, "utf8")).toBe(raw);
    expect(linkStore.getByIssueNumber(binding.id, 7)?.fieldSnapshots).toStrictEqual(baseline);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
