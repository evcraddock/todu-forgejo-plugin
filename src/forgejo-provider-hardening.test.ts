import {
  createIntegrationBindingId,
  createNoteId,
  createProjectId,
  createTaskId,
  type ExportedTaskInput,
  type IntegrationBinding,
} from "@todu/core";

import { createInMemoryForgejoCommentLinkStore } from "@/forgejo-comment-links";
import { FORGEJO_PROVIDER_NAME, FORGEJO_REPOSITORY_TARGET_KIND } from "@/forgejo-binding";
import { createInMemoryForgejoIssueClient } from "@/forgejo-client";
import { createForgejoSyncLogger } from "@/forgejo-logger";
import { createLinkFromTask, createInMemoryForgejoItemLinkStore } from "@/forgejo-links";
import { createForgejoSyncProvider } from "@/forgejo-provider";
import { createInMemoryForgejoBindingRuntimeStore } from "@/forgejo-runtime";

function createBinding(overrides: Partial<IntegrationBinding> = {}): IntegrationBinding {
  return {
    id: createIntegrationBindingId("binding-1"),
    provider: FORGEJO_PROVIDER_NAME,
    projectId: createProjectId("project-1"),
    targetKind: FORGEJO_REPOSITORY_TARGET_KIND,
    targetRef: "acme/roadmap",
    strategy: "bidirectional",
    enabled: true,
    createdAt: "2026-03-12T00:00:00.000Z",
    updatedAt: "2026-03-12T00:00:00.000Z",
    ...overrides,
  };
}

const project = {
  id: createProjectId("project-1"),
  name: "roadmap",
  status: "active" as const,
  priority: "medium" as const,
  authorizedAssigneeActorIds: [],
  createdAt: "2026-03-12T00:00:00.000Z",
  updatedAt: "2026-03-12T00:00:00.000Z",
};

const target = {
  baseUrl: "https://code.example.com",
  apiBaseUrl: "https://code.example.com/api/v1",
  owner: "acme",
  repo: "roadmap",
};

function createPushTask(overrides: Partial<ExportedTaskInput> = {}): ExportedTaskInput {
  return {
    localTaskId: createTaskId("task-1"),
    title: "Test task",
    description: "",
    status: "active",
    priority: "medium",
    labels: [],
    assignees: [],
    comments: [],
    updatedAt: "2026-03-12T00:00:00.000Z",
    ...overrides,
  };
}

async function initProvider(
  options: Parameters<typeof createForgejoSyncProvider>[0] = {}
): Promise<ReturnType<typeof createForgejoSyncProvider>> {
  const provider = createForgejoSyncProvider(options);
  await provider.initialize({
    settings: { baseUrl: target.baseUrl, token: "secret-token" },
  });
  return provider;
}

describe("strategy-specific behavior", () => {
  it("strategy=none skips both pull and push", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Issue",
        state: "open",
        labels: [],
        assigneeActorIds: [],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    const provider = await initProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
    });

    const pullResult = await provider.pull(createBinding({ strategy: "none" }), project);
    expect(pullResult.tasks).toEqual([]);
    expect(pullResult.comments).toBeUndefined();

    const pushResult = await provider.push(
      createBinding({ strategy: "none" }),
      [createPushTask()],
      project
    );
    expect(pushResult.taskLinks).toEqual([]);
    expect(issueClient.snapshotIssues(target)).toHaveLength(1);
  });

  it("strategy=pull imports issues but does not push tasks", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Pull only issue",
        state: "open",
        labels: ["status:active"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    const provider = await initProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
    });

    const pullResult = await provider.pull(createBinding({ strategy: "pull" }), project);
    expect(pullResult.tasks).toHaveLength(1);
    expect(pullResult.tasks[0].title).toBe("Pull only issue");

    const pushResult = await provider.push(
      createBinding({ strategy: "pull" }),
      [createPushTask({ title: "Should not be pushed" })],
      project
    );
    expect(pushResult.taskLinks).toEqual([]);
    expect(issueClient.snapshotIssues(target)).toHaveLength(1);
  });

  it("strategy=push exports tasks but does not pull issues", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Existing issue",
        state: "open",
        labels: [],
        assigneeActorIds: [],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    const provider = await initProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
    });

    const pullResult = await provider.pull(createBinding({ strategy: "push" }), project);
    expect(pullResult.tasks).toEqual([]);

    const pushResult = await provider.push(
      createBinding({ strategy: "push" }),
      [createPushTask({ title: "Pushed task" })],
      project
    );
    expect(pushResult.taskLinks).toHaveLength(1);
    expect(issueClient.snapshotIssues(target)).toHaveLength(2);
  });

  it("strategy=bidirectional pulls and pushes", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Existing issue",
        state: "open",
        labels: ["status:active"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    const provider = await initProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
    });

    const pullResult = await provider.pull(createBinding({ strategy: "bidirectional" }), project);
    expect(pullResult.tasks).toHaveLength(1);

    const pushResult = await provider.push(
      createBinding({ strategy: "bidirectional" }),
      [createPushTask({ title: "New task" })],
      project
    );
    expect(pushResult.taskLinks).toHaveLength(1);
    expect(issueClient.snapshotIssues(target)).toHaveLength(2);
  });
});

describe("provider error classification coverage", () => {
  it("skips missing issue comment fetches, removes stale links, and logs a warning", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [
      {
        number: 7,
        externalId: "https://code.example.com/acme/roadmap#7",
        title: "Issue seven",
        state: "open",
        labels: ["status:active"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ]);
    issueClient.listComments = async (_target, issueNumber) => {
      throw new Error(
        `Forgejo API GET /repos/acme/roadmap/issues/${issueNumber}/comments failed: 404 issue does not exist`
      );
    };

    const linkStore = createInMemoryForgejoItemLinkStore();
    const logger = createForgejoSyncLogger();
    const provider = await initProvider({
      issueClient,
      linkStore,
      commentLinkStore: createInMemoryForgejoCommentLinkStore(),
      logger,
    });

    const result = await provider.pull(createBinding(), project);

    expect(result.tasks).toHaveLength(1);
    expect(result.comments).toEqual([]);
    expect(linkStore.getByIssueNumber(createBinding().id, 7)).toBeNull();
    expect(logger.getEntries()).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "skipping comments for missing remote issue; stale links removed",
        context: expect.objectContaining({
          bindingId: createBinding().id,
          direction: "pull",
          entityType: "issue",
          itemId: "7",
        }),
      })
    );
  });

  it("removes stale push comment links for missing local notes and logs a warning", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [
      {
        number: 7,
        externalId: "https://code.example.com/acme/roadmap#7",
        title: "Issue seven",
        state: "open",
        labels: ["status:active"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ]);

    const linkStore = createInMemoryForgejoItemLinkStore();
    linkStore.save({
      bindingId: createBinding().id,
      taskId: createTaskId("task-1"),
      issueNumber: 7,
      externalId: "https://code.example.com/acme/roadmap#7",
      lastMirroredAt: "2026-03-12T01:00:00.000Z",
    });

    const commentLinkStore = createInMemoryForgejoCommentLinkStore();
    commentLinkStore.save({
      bindingId: createBinding().id,
      taskId: createTaskId("task-1"),
      noteId: createNoteId("note-stale"),
      issueNumber: 7,
      forgejoCommentId: 21,
      lastMirroredAt: "2026-03-12T01:00:00.000Z",
      lastMirroredBody: "Old local body",
    });

    const logger = createForgejoSyncLogger();
    const provider = await initProvider({
      issueClient,
      linkStore,
      commentLinkStore,
      logger,
    });

    const pushResult = await provider.push(
      createBinding(),
      [
        createPushTask({
          localTaskId: createTaskId("task-1"),
          externalId: "https://code.example.com/acme/roadmap#7",
          comments: [],
        }),
      ],
      project
    );

    expect(pushResult.commentLinks).toEqual([]);
    expect(commentLinkStore.getByNoteId(createBinding().id, createNoteId("note-stale"))).toBeNull();
    expect(logger.getEntries()).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "removing stale comment link for missing local note",
        context: expect.objectContaining({
          bindingId: createBinding().id,
          direction: "push",
          entityType: "comment",
          itemId: "7:21",
        }),
      })
    );
  });

  it("reconciles legacy imported comment links to real local note ids before returning push links", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [
      {
        number: 7,
        externalId: "https://code.example.com/acme/roadmap#7",
        title: "Issue seven",
        state: "open",
        labels: ["status:active"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ]);

    const linkStore = createInMemoryForgejoItemLinkStore();
    linkStore.save({
      bindingId: createBinding().id,
      taskId: createTaskId("task-1"),
      issueNumber: 7,
      externalId: "https://code.example.com/acme/roadmap#7",
      lastMirroredAt: "2026-03-12T01:00:00.000Z",
    });

    const commentLinkStore = createInMemoryForgejoCommentLinkStore();
    commentLinkStore.save({
      bindingId: createBinding().id,
      taskId: createTaskId("task-legacy"),
      noteId: createNoteId("external:21"),
      issueNumber: 7,
      forgejoCommentId: 21,
      lastMirroredAt: "2026-03-12T01:00:00.000Z",
      lastMirroredBody: "Imported body",
    });

    const provider = await initProvider({
      issueClient,
      linkStore,
      commentLinkStore,
    });

    const pushResult = await provider.push(
      createBinding(),
      [
        {
          localTaskId: createTaskId("task-1"),
          externalId: "https://code.example.com/acme/roadmap#7",
          title: "Task one",
          description: "",
          status: "active",
          priority: "medium",
          labels: [],
          assignees: [],
          updatedAt: "2026-03-12T03:00:00.000Z",
          comments: [
            {
              localNoteId: createNoteId("note-real"),
              body: "_Synced from Forgejo comment by @alice on 2026-03-12T00:00:00.000Z_\n\nImported body",
              createdAt: "2026-03-12T00:00:00.000Z",
            },
          ],
        },
      ],
      project
    );

    expect(pushResult.commentLinks).toEqual([
      expect.objectContaining({
        localNoteId: createNoteId("note-real"),
        externalCommentId: "21",
        externalTaskId: createTaskId("task-1"),
      }),
    ]);
    expect(
      commentLinkStore.getByNoteId(createBinding().id, createNoteId("note-real"))
    ).toMatchObject({
      taskId: createTaskId("task-1"),
      forgejoCommentId: 21,
      lastMirroredBody: "Imported body",
    });
    expect(
      commentLinkStore.getByNoteId(createBinding().id, createNoteId("external:21"))
    ).toBeNull();
  });

  it("keeps transient comment pull timeouts retryable", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [
      {
        number: 7,
        externalId: "https://code.example.com/acme/roadmap#7",
        title: "Issue seven",
        state: "open",
        labels: ["status:active"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ]);
    issueClient.listComments = async () => {
      throw new Error("The operation timed out.");
    };

    const runtimeStore = createInMemoryForgejoBindingRuntimeStore();
    const provider = await initProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
      runtimeStore,
      retryConfig: { initialSeconds: 0, maxSeconds: 0 },
    });

    await expect(provider.pull(createBinding(), project)).rejects.toThrow("timed out");

    const state = runtimeStore.get(createBinding().id);
    expect(state!.lastError).toContain("transport error");
    expect(state!.retryAttempt).toBe(1);
  });

  it("classifies 404 as non-retryable not-found", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.listIssues = async () => {
      throw new Error("Forgejo API failed: 404 not found");
    };

    const runtimeStore = createInMemoryForgejoBindingRuntimeStore();
    const provider = await initProvider({ issueClient, runtimeStore });

    await expect(provider.pull(createBinding(), project)).rejects.toThrow("404");

    const state = runtimeStore.get(createBinding().id);
    expect(state!.lastError).toContain("resource not found");
  });

  it("classifies network errors as retryable transport", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.listIssues = async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    };

    const runtimeStore = createInMemoryForgejoBindingRuntimeStore();
    const provider = await initProvider({
      issueClient,
      runtimeStore,
      retryConfig: { initialSeconds: 0, maxSeconds: 0 },
    });

    await expect(provider.pull(createBinding(), project)).rejects.toThrow("ECONNREFUSED");

    const state = runtimeStore.get(createBinding().id);
    expect(state!.lastError).toContain("transport error");
    expect(state!.retryAttempt).toBe(1);
  });
});

describe("provider push failure handling", () => {
  it("recreates a missing remote issue for a stale local reference and remirrors comments", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();
    const commentLinkStore = createInMemoryForgejoCommentLinkStore();

    linkStore.save(
      createLinkFromTask({
        binding: createBinding(),
        taskId: createTaskId("task-1"),
        baseUrl: target.baseUrl,
        owner: target.owner,
        repo: target.repo,
        issueNumber: 7,
        lastMirroredAt: "2026-03-12T00:00:00.000Z",
      })
    );
    commentLinkStore.save({
      bindingId: createBinding().id,
      taskId: createTaskId("task-1"),
      noteId: createNoteId("note-1"),
      issueNumber: 7,
      forgejoCommentId: 11,
      lastMirroredAt: "2026-03-12T00:00:00.000Z",
      lastMirroredBody: "Old mirrored body",
    });

    const provider = await initProvider({
      issueClient,
      linkStore,
      commentLinkStore,
    });

    const pushResult = await provider.push(
      createBinding(),
      [
        createPushTask({
          externalId: "https://code.example.com/acme/roadmap#7",
          updatedAt: "2026-03-12T02:00:00.000Z",
          comments: [
            {
              localNoteId: createNoteId("note-1"),
              body: "Updated local note",
              createdAt: "2026-03-12T02:00:00.000Z",
            },
          ],
        }),
      ],
      project
    );

    expect(issueClient.snapshotIssues(target)).toHaveLength(1);
    expect(issueClient.snapshotComments(target, 1)).toHaveLength(1);
    expect(issueClient.snapshotComments(target, 1)[0].body).toContain("Updated local note");
    expect(pushResult.taskLinks).toHaveLength(1);
    expect(pushResult.taskLinks[0].externalId).toBe("https://code.example.com/acme/roadmap#1");
    expect(commentLinkStore.getByNoteId(createBinding().id, createNoteId("note-1"))).toMatchObject({
      issueNumber: 1,
      forgejoCommentId: 1,
    });
    expect(linkStore.getByIssueNumber(createBinding().id, 7)).toBeNull();
    expect(linkStore.getByIssueNumber(createBinding().id, 1)).not.toBeNull();
  });

  it("records failure state when push throws", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.createIssue = async () => {
      throw new Error("Forgejo API failed: 500 internal server error");
    };

    const runtimeStore = createInMemoryForgejoBindingRuntimeStore();
    const provider = await initProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
      runtimeStore,
    });

    await expect(provider.push(createBinding(), [createPushTask()], project)).rejects.toThrow(
      "500"
    );

    const state = runtimeStore.get(createBinding().id);
    expect(state!.retryAttempt).toBe(1);
    expect(state!.lastError).toContain("server error");

    const status = provider.getState().bindingStatuses.get(createBinding().id);
    expect(status!.state).toBe("error");
  });
});
