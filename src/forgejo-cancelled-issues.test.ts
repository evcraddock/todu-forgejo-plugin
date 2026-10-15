import {
  createIntegrationBindingId,
  createNoteId,
  createProjectId,
  createTaskId,
  type ExportedTaskInput,
  type IntegrationBinding,
} from "@todu/core";

import { bootstrapTasksToForgejoIssues } from "@/forgejo-bootstrap";
import { createInMemoryForgejoIssueClient } from "@/forgejo-client";
import { createInMemoryForgejoCommentLinkStore } from "@/forgejo-comment-links";
import { ForgejoHttpError } from "@/forgejo-http-error";
import { createImportedTaskId } from "@/forgejo-ids";
import { createInMemoryForgejoItemLinkStore } from "@/forgejo-links";
import { createForgejoSyncProvider } from "@/forgejo-legacy-provider";
import { createInMemoryForgejoBindingRuntimeStore } from "@/forgejo-runtime";

const binding: IntegrationBinding = {
  id: createIntegrationBindingId("binding-cancelled"),
  projectId: createProjectId("project-cancelled"),
  provider: "forgejo",
  targetKind: "repository",
  targetRef: "acme/roadmap",
  strategy: "bidirectional",
  enabled: true,
  createdAt: "2026-03-12T00:00:00.000Z",
  updatedAt: "2026-03-12T00:00:00.000Z",
};
const project = {
  id: binding.projectId,
  name: "roadmap",
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
const externalId = `${target.baseUrl}/acme/roadmap#9`;

function task(overrides: Partial<ExportedTaskInput> = {}): ExportedTaskInput {
  return {
    localTaskId: createTaskId("task-cancelled"),
    externalId,
    sourceUrl: `${target.baseUrl}/acme/roadmap/issues/9`,
    title: "Cancelled task",
    description: "Preserve this description",
    status: "canceled",
    priority: "medium",
    labels: [],
    assignees: [],
    comments: [
      {
        localNoteId: createNoteId("note-cancelled"),
        body: "Preserve this note",
        createdAt: "2026-03-12T01:00:00.000Z",
      },
    ],
    updatedAt: "2026-03-12T01:00:00.000Z",
    ...overrides,
  };
}

function fixture(reference = "stored update") {
  const issueClient = createInMemoryForgejoIssueClient();
  const linkStore = createInMemoryForgejoItemLinkStore();
  const commentLinkStore = createInMemoryForgejoCommentLinkStore();
  const original = task(
    reference === "source URL"
      ? { externalId: undefined }
      : reference === "imported ID"
        ? {
            externalId: undefined,
            sourceUrl: undefined,
            localTaskId: createImportedTaskId(externalId),
          }
        : {}
  );
  if (reference.startsWith("stored")) {
    linkStore.save({
      bindingId: binding.id,
      taskId: original.localTaskId,
      issueNumber: 9,
      externalId,
      ...(reference === "stored hydration"
        ? {}
        : {
            lastMirroredAt:
              reference === "stored unchanged" ? original.updatedAt : binding.createdAt,
          }),
      fieldSnapshots: { content: { title: original.title, description: original.description! } },
    });
    for (const id of ["note-cancelled", "note-stale-link"]) {
      commentLinkStore.save({
        bindingId: binding.id,
        taskId: original.localTaskId,
        noteId: createNoteId(id),
        issueNumber: 9,
        forgejoCommentId: id === "note-cancelled" ? 11 : 12,
        lastMirroredAt: binding.createdAt,
        lastMirroredBody: "Preserve comment baseline",
      });
    }
  }
  const other = task({
    localTaskId: createTaskId("task-active"),
    externalId: undefined,
    sourceUrl: undefined,
    title: "Unrelated active task",
    status: "active",
    comments: [],
  });
  return { issueClient, linkStore, commentLinkStore, original, other };
}

const references = [
  "stored hydration",
  "stored update",
  "stored unchanged",
  "external ID",
  "source URL",
  "imported ID",
];

describe("cancelled tasks with unavailable Forgejo issues", () => {
  it.each(references)(
    "ignores %s without recreating, relinking, or touching comments",
    async (reference) => {
      const { issueClient, linkStore, commentLinkStore, original, other } = fixture(reference);
      const originalLinks = linkStore.listAll();
      const originalComments = commentLinkStore.listAll();
      const originalTask = structuredClone(original);
      const listComments = vi.spyOn(issueClient, "listComments");
      const createComment = vi.spyOn(issueClient, "createComment");
      const updateComment = vi.spyOn(issueClient, "updateComment");
      const provider = createForgejoSyncProvider({ issueClient, linkStore, commentLinkStore });
      await provider.initialize({ settings: { baseUrl: target.baseUrl, token: "test-token" } });

      const result = await provider.push(binding, [original, other], project);

      expect(result.taskLinks).toHaveLength(1);
      expect(result.taskLinks![0].localTaskId).toBe(other.localTaskId);
      expect(issueClient.snapshotIssues(target).map((issue) => issue.title)).toEqual([other.title]);
      expect(linkStore.getByTaskId(binding.id, original.localTaskId)).toEqual(
        originalLinks[0] ?? null
      );
      expect(commentLinkStore.listAll()).toEqual(originalComments);
      expect(listComments).not.toHaveBeenCalled();
      expect(createComment).not.toHaveBeenCalled();
      expect(updateComment).not.toHaveBeenCalled();
      expect(original).toEqual(originalTask);
      expect(provider.getState().runtimeStates[0].lastError).toBeNull();
    }
  );

  it.each(["stored update", "stored hydration", "external ID"])(
    "ignores an update-404 race for %s and preserves pre-call state",
    async (reference) => {
      const { issueClient, linkStore, commentLinkStore, original, other } = fixture(reference);
      issueClient.seedIssues(target, [
        {
          number: 9,
          externalId,
          title: original.title,
          state: "open",
          labels: ["status:active", "priority:medium"],
          assignees: [],
          createdAt: binding.createdAt,
        },
      ]);
      const update = issueClient.updateIssue.bind(issueClient);
      vi.spyOn(issueClient, "updateIssue").mockImplementation(async (target, number, input) => {
        if (number === 9) throw new ForgejoHttpError(404, "PATCH", "/issues/9", "not found");
        return update(target, number, input);
      });
      const originalLinks = linkStore.listAll();
      const originalComments = commentLinkStore.listAll();
      const provider = createForgejoSyncProvider({ issueClient, linkStore, commentLinkStore });
      await provider.initialize({ settings: { baseUrl: target.baseUrl, token: "test-token" } });
      const result = await provider.push(binding, [original, other], project);
      expect(result.taskLinks?.some((link) => link.localTaskId === original.localTaskId)).toBe(
        false
      );
      expect(linkStore.getByTaskId(binding.id, original.localTaskId)).toEqual(
        originalLinks[0] ?? null
      );
      expect(commentLinkStore.listAll()).toEqual(originalComments);
      expect(issueClient.snapshotComments(target, 9)).toEqual([]);
      expect(provider.getState().runtimeStates[0].lastError).toBeNull();
    }
  );

  it("still closes an available issue for a cancelled task", async () => {
    const { issueClient, linkStore, commentLinkStore, original } = fixture();
    issueClient.seedIssues(target, [
      {
        number: 9,
        externalId,
        title: original.title,
        state: "open",
        labels: [],
        assignees: [],
        createdAt: binding.createdAt,
      },
    ]);
    await bootstrapTasksToForgejoIssues({
      binding,
      ...target,
      tasks: [task({ comments: [] })],
      issueClient,
      linkStore,
      commentLinkStore,
    });
    expect(issueClient.snapshotIssues(target)[0]).toMatchObject({
      state: "closed",
      labels: expect.arrayContaining(["status:canceled"]),
    });
  });

  it.each(["active", "inprogress", "waiting", "done"] as const)(
    "still blocks unavailable issues for %s tasks",
    async (status) => {
      const { issueClient, linkStore, original } = fixture();
      await expect(
        bootstrapTasksToForgejoIssues({
          binding,
          ...target,
          tasks: [{ ...original, status }],
          issueClient,
          linkStore,
        })
      ).rejects.toThrow("explicit identity repair");
    }
  );

  it.each([401, 403, 429, 500])("does not ignore HTTP %s for cancelled tasks", async (status) => {
    const { issueClient, linkStore, original } = fixture("stored hydration");
    vi.spyOn(issueClient, "getIssue").mockRejectedValue(
      new ForgejoHttpError(status, "GET", "/issues/9", "issue not found")
    );
    await expect(
      bootstrapTasksToForgejoIssues({
        binding,
        ...target,
        tasks: [original],
        issueClient,
        linkStore,
      })
    ).rejects.toMatchObject({ status });
  });

  it.each([401, 403, 429, 500])(
    "does not mistake an update HTTP %s for a missing issue",
    async (status) => {
      const { issueClient, linkStore, original } = fixture();
      issueClient.seedIssues(target, [
        {
          number: 9,
          externalId,
          title: original.title,
          state: "open",
          labels: [],
          assignees: [],
          createdAt: binding.createdAt,
        },
      ]);
      vi.spyOn(issueClient, "updateIssue").mockRejectedValue(
        new ForgejoHttpError(status, "PATCH", "/issues/9", "issue not found")
      );
      await expect(
        bootstrapTasksToForgejoIssues({
          binding,
          ...target,
          tasks: [original],
          issueClient,
          linkStore,
        })
      ).rejects.toMatchObject({ status });
    }
  );

  it("does not reuse a cancelled skip when the task becomes active again", async () => {
    const { issueClient, linkStore, commentLinkStore, original } = fixture();
    const provider = createForgejoSyncProvider({ issueClient, linkStore, commentLinkStore });
    await provider.initialize({ settings: { baseUrl: target.baseUrl, token: "test-token" } });
    await provider.push(binding, [original], project);
    await expect(
      provider.push(binding, [{ ...original, status: "active" }], project)
    ).rejects.toThrow("explicit identity repair");
    expect(provider.getState().bindingStatuses.get(binding.id)?.state).toBe("blocked");
  });

  it("does not relink a cancelled task to a metadata-identical replacement", async () => {
    const { issueClient, linkStore, original } = fixture("external ID");
    issueClient.seedIssues(target, [
      {
        number: 62,
        externalId: `${target.baseUrl}/acme/roadmap#62`,
        title: original.title,
        body: original.description,
        state: "closed",
        labels: ["status:canceled", "priority:medium"],
        assignees: [],
        createdAt: binding.createdAt,
      },
    ]);
    const result = await bootstrapTasksToForgejoIssues({
      binding,
      ...target,
      tasks: [original],
      issueClient,
      linkStore,
    });
    expect(result.createdIssues).toEqual([]);
    expect(result.taskUpdates).toEqual([]);
    expect(result.unavailableCancelledTaskIds).toEqual([original.localTaskId]);
    expect(linkStore.listAll()).toEqual([]);
    expect(issueClient.snapshotIssues(target)).toHaveLength(1);
  });

  it("still rejects identity mismatches for cancelled tasks", async () => {
    const { issueClient, linkStore, original } = fixture();
    await expect(
      bootstrapTasksToForgejoIssues({
        binding,
        ...target,
        tasks: [{ ...original, externalId: `${target.baseUrl}/acme/roadmap#62` }],
        issueClient,
        linkStore,
      })
    ).rejects.toThrow("saved issue link disagree");
  });

  it("does not suppress pull comment failures using a previous cancelled push", async () => {
    const { issueClient, linkStore, commentLinkStore, original } = fixture();
    const runtimeStore = createInMemoryForgejoBindingRuntimeStore();
    const provider = createForgejoSyncProvider({
      issueClient,
      linkStore,
      commentLinkStore,
      runtimeStore,
    });
    await provider.initialize({ settings: { baseUrl: target.baseUrl, token: "test-token" } });
    await provider.push(binding, [original], project);
    vi.spyOn(issueClient, "listComments").mockRejectedValue(
      new ForgejoHttpError(404, "GET", "/issues/9/comments", "not found")
    );
    await expect(provider.pull(binding, project)).rejects.toThrow(
      "existing task/comment links retained"
    );
    expect(runtimeStore.get(binding.id)?.lastFailurePhase).toBe("pull:comments");
  });
});
