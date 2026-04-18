import {
  createIntegrationBindingId,
  createProjectId,
  createTaskId,
  type IntegrationBinding,
  type TaskPushPayload,
} from "@todu/core";

import { createInMemoryForgejoIssueClient } from "@/forgejo-client";
import { parseForgejoIssueExternalId } from "@/forgejo-ids";
import { createInMemoryForgejoItemLinkStore } from "@/forgejo-links";
import { bootstrapForgejoIssuesToTasks, bootstrapTasksToForgejoIssues } from "@/forgejo-bootstrap";

const binding: IntegrationBinding = {
  id: createIntegrationBindingId("binding-1"),
  provider: "forgejo",
  projectId: createProjectId("project-1"),
  targetKind: "repository",
  targetRef: "erik/todu-forgejo-plugin-test",
  strategy: "bidirectional",
  enabled: true,
  createdAt: "2026-03-12T00:00:00.000Z",
  updatedAt: "2026-03-12T00:00:00.000Z",
};

const target = {
  baseUrl: "https://forgejo.caradoc.com",
  apiBaseUrl: "https://forgejo.caradoc.com/api/v1",
  owner: "erik",
  repo: "todu-forgejo-plugin-test",
};

describe("forgejo bootstrap", () => {
  it("imports open issues with normalized fields and creates durable links", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();

    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#1",
        title: "Open issue",
        body: "Imported body",
        state: "open",
        labels: ["bug", "status:inprogress", "priority:high"],
        assignees: ["erik"],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
      {
        number: 2,
        externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#2",
        title: "Closed issue",
        state: "closed",
        labels: [],
        assigneeActorIds: [],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    const result = await bootstrapForgejoIssuesToTasks({
      binding,
      baseUrl: target.baseUrl,
      apiBaseUrl: target.apiBaseUrl,
      owner: target.owner,
      repo: target.repo,
      issueClient,
      linkStore,
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].externalId).toBe(
      "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#1"
    );
    expect(result.tasks[0].status).toBe("inprogress");
    expect(result.tasks[0].priority).toBe("high");
    expect(result.tasks[0].labels).toEqual(["bug"]);
    expect(result.tasks[0].assignees).toEqual([
      expect.objectContaining({ externalLogin: "erik", displayName: "erik" }),
    ]);
    expect(result.createdLinks).toHaveLength(1);
    expect(linkStore.getByIssueNumber(binding.id, 1)).toMatchObject({
      externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#1",
      lastMirroredAt: "2026-03-12T00:00:00.000Z",
    });
  });

  it("exports active tasks to forgejo with normalized fields, assignees, and creates missing labels", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();
    const tasks: TaskPushPayload[] = [
      {
        id: createTaskId("task-1"),
        title: "Create sync",
        description: "Bootstrap this issue",
        status: "active",
        priority: "high",
        projectId: binding.projectId,
        labels: ["bug"],
        assigneeActorIds: [],
        assignees: ["caradoc"],
        comments: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
      {
        id: createTaskId("task-2"),
        title: "Ignore closed task",
        status: "done",
        priority: "medium",
        projectId: binding.projectId,
        labels: [],
        assigneeActorIds: [],
        assignees: [],
        comments: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ];

    const result = await bootstrapTasksToForgejoIssues({
      binding,
      baseUrl: target.baseUrl,
      apiBaseUrl: target.apiBaseUrl,
      owner: target.owner,
      repo: target.repo,
      tasks,
      issueClient,
      linkStore,
    });

    expect(result.createdIssues).toHaveLength(1);
    expect(result.createdIssues[0].state).toBe("open");
    expect(result.createdIssues[0].labels).toEqual(["bug", "status:active", "priority:high"]);
    expect(result.createdIssues[0].assignees).toEqual([
      expect.objectContaining({ externalLogin: "caradoc", displayName: "caradoc" }),
    ]);
    expect(issueClient.snapshotLabels(target)).toContain("bug");
    expect(result.createdLinks).toHaveLength(1);
    expect(result.createdLinks[0].lastMirroredAt).toBeDefined();
    expect(result.taskUpdates).toEqual([
      expect.objectContaining({
        taskId: String(tasks[0].id),
        externalId: expect.any(String),
        sourceUrl: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test/issues/1",
      }),
    ]);
  });

  it("links to existing matching external ids instead of creating duplicates", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();

    issueClient.seedIssues(target, [
      {
        number: 7,
        externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#7",
        title: "Existing issue",
        state: "open",
        labels: [],
        assigneeActorIds: [],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    const tasks: TaskPushPayload[] = [
      {
        id: createTaskId("task-1"),
        title: "Reuse issue",
        externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#7",
        status: "active",
        priority: "medium",
        projectId: binding.projectId,
        labels: ["needs-review"],
        assigneeActorIds: [],
        assignees: [],
        comments: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ];

    const result = await bootstrapTasksToForgejoIssues({
      binding,
      baseUrl: target.baseUrl,
      apiBaseUrl: target.apiBaseUrl,
      owner: target.owner,
      repo: target.repo,
      tasks,
      issueClient,
      linkStore,
    });

    expect(result.createdIssues).toHaveLength(0);
    expect(result.createdLinks).toHaveLength(1);
    expect(result.updatedIssues).toHaveLength(1);
    expect(result.updatedIssues[0].labels).toEqual([
      "needs-review",
      "status:active",
      "priority:medium",
    ]);
    expect(issueClient.snapshotLabels(target)).toContain("needs-review");
    expect(linkStore.getByTaskId(binding.id, tasks[0].id)).toMatchObject({
      issueNumber: 7,
      lastMirroredAt: expect.any(String),
    });
    expect(parseForgejoIssueExternalId(tasks[0].externalId!).issueNumber).toBe(7);
  });

  it("skips unchanged linked tasks without reading forgejo issues", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();
    linkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-7"),
      issueNumber: 7,
      externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#7",
      lastMirroredAt: "2026-03-12T02:00:00.000Z",
    });

    let getIssueCalls = 0;
    issueClient.getIssue = async () => {
      getIssueCalls += 1;
      throw new Error("getIssue should not be called for unchanged linked tasks");
    };

    const result = await bootstrapTasksToForgejoIssues({
      binding,
      baseUrl: target.baseUrl,
      apiBaseUrl: target.apiBaseUrl,
      owner: target.owner,
      repo: target.repo,
      tasks: [
        {
          id: createTaskId("task-7"),
          title: "Unchanged title",
          description: "Unchanged body",
          status: "active",
          priority: "medium",
          projectId: binding.projectId,
          labels: [],
          assignees: [],
          comments: [],
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T01:00:00.000Z",
        },
      ],
      issueClient,
      linkStore,
    });

    expect(getIssueCalls).toBe(0);
    expect(result).toMatchObject({
      issueReadCount: 0,
      skippedLinkedTasks: 1,
    });
  });

  it("hydrates older linked tasks once and skips push when the remote mirror is newer", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();
    issueClient.seedIssues(target, [
      {
        number: 7,
        externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#7",
        title: "Existing issue",
        body: "Existing body",
        state: "open",
        labels: ["status:active", "priority:medium"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T02:00:00.000Z",
      },
    ]);
    linkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-7"),
      issueNumber: 7,
      externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#7",
    });

    const result = await bootstrapTasksToForgejoIssues({
      binding,
      baseUrl: target.baseUrl,
      apiBaseUrl: target.apiBaseUrl,
      owner: target.owner,
      repo: target.repo,
      tasks: [
        {
          id: createTaskId("task-7"),
          title: "Older task",
          description: "Existing body",
          status: "active",
          priority: "medium",
          projectId: binding.projectId,
          labels: [],
          assignees: [],
          comments: [],
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T01:00:00.000Z",
        },
      ],
      issueClient,
      linkStore,
    });

    expect(result).toMatchObject({
      hydratedLinkedTasks: 1,
      issueReadCount: 1,
      skippedLinkedTasks: 1,
      updatedIssues: [],
    });
    expect(linkStore.getByTaskId(binding.id, createTaskId("task-7"))?.lastMirroredAt).toEqual(
      "2026-03-12T02:00:00.000Z"
    );
  });

  it("does not update a linked issue when the remote mirror is newer even if assignees differ", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();
    issueClient.seedIssues(target, [
      {
        number: 9,
        externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#9",
        title: "test actors",
        state: "open",
        labels: ["status:active", "priority:medium"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T03:00:00.000Z",
      },
    ]);
    linkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-remote-newer"),
      issueNumber: 9,
      externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#9",
      lastMirroredAt: "2026-03-12T03:00:00.000Z",
    });

    const result = await bootstrapTasksToForgejoIssues({
      binding,
      baseUrl: target.baseUrl,
      apiBaseUrl: target.apiBaseUrl,
      owner: target.owner,
      repo: target.repo,
      tasks: [
        {
          id: createTaskId("task-remote-newer"),
          title: "test actors",
          description: undefined,
          status: "active",
          priority: "medium",
          projectId: binding.projectId,
          labels: [],
          assignees: ["caradoc"],
          comments: [],
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T02:00:00.000Z",
          externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#9",
        },
      ],
      issueClient,
      linkStore,
    });

    expect(result.updatedIssues).toHaveLength(0);
    expect(result.skippedLinkedTasks).toBe(1);
    expect(issueClient.snapshotIssues(target)[0].assignees).toEqual([]);
  });

  it("checks forgejo labels once per push cycle", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    let listLabelsCalls = 0;
    const originalListLabels = issueClient.listLabels.bind(issueClient);
    issueClient.listLabels = async (...args) => {
      listLabelsCalls += 1;
      return originalListLabels(...args);
    };

    await bootstrapTasksToForgejoIssues({
      binding,
      baseUrl: target.baseUrl,
      apiBaseUrl: target.apiBaseUrl,
      owner: target.owner,
      repo: target.repo,
      tasks: [
        {
          id: createTaskId("task-a"),
          title: "Task A",
          description: "A",
          status: "active",
          priority: "medium",
          projectId: binding.projectId,
          labels: ["bug"],
          assignees: [],
          comments: [],
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T01:00:00.000Z",
        },
        {
          id: createTaskId("task-b"),
          title: "Task B",
          description: "B",
          status: "active",
          priority: "high",
          projectId: binding.projectId,
          labels: ["feature"],
          assignees: [],
          comments: [],
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T01:00:00.000Z",
        },
      ],
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
    });

    expect(listLabelsCalls).toBe(1);
  });

  it("closes orphaned linked issues and removes their links", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();
    const orphanedTaskId = createTaskId("task-orphaned");

    issueClient.seedIssues(target, [
      {
        number: 11,
        externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#11",
        title: "Orphaned issue",
        state: "open",
        labels: ["bug", "status:active", "priority:medium"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ]);
    linkStore.save({
      bindingId: binding.id,
      taskId: orphanedTaskId,
      issueNumber: 11,
      externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#11",
      lastMirroredAt: "2026-03-12T01:00:00.000Z",
    });

    const result = await bootstrapTasksToForgejoIssues({
      binding,
      baseUrl: target.baseUrl,
      apiBaseUrl: target.apiBaseUrl,
      owner: target.owner,
      repo: target.repo,
      tasks: [],
      issueClient,
      linkStore,
    });

    expect(result.closedIssues).toHaveLength(1);
    expect(result.closedIssues[0]).toMatchObject({
      number: 11,
      state: "closed",
      labels: ["bug", "priority:medium", "status:canceled"],
    });
    expect(result.issueReadCount).toBe(1);
    expect(linkStore.getByTaskId(binding.id, orphanedTaskId)).toBeNull();
  });

  it("skips redundant close calls for already-closed orphaned issues and removes their links", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();
    const orphanedTaskId = createTaskId("task-orphaned");

    issueClient.seedIssues(target, [
      {
        number: 12,
        externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#12",
        title: "Closed orphaned issue",
        state: "closed",
        labels: ["status:done", "priority:medium"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ]);
    linkStore.save({
      bindingId: binding.id,
      taskId: orphanedTaskId,
      issueNumber: 12,
      externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#12",
      lastMirroredAt: "2026-03-12T01:00:00.000Z",
    });

    let updateIssueCalls = 0;
    const originalUpdateIssue = issueClient.updateIssue.bind(issueClient);
    issueClient.updateIssue = async (...args) => {
      updateIssueCalls += 1;
      return originalUpdateIssue(...args);
    };

    const result = await bootstrapTasksToForgejoIssues({
      binding,
      baseUrl: target.baseUrl,
      apiBaseUrl: target.apiBaseUrl,
      owner: target.owner,
      repo: target.repo,
      tasks: [],
      issueClient,
      linkStore,
    });

    expect(result.closedIssues).toEqual([]);
    expect(result.issueReadCount).toBe(1);
    expect(updateIssueCalls).toBe(0);
    expect(linkStore.getByTaskId(binding.id, orphanedTaskId)).toBeNull();
  });

  it("keeps orphaned links when loop prevention skips deletion-driven closes", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();
    const orphanedTaskId = createTaskId("task-orphaned");

    issueClient.seedIssues(target, [
      {
        number: 13,
        externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#13",
        title: "Loop-protected orphaned issue",
        state: "open",
        labels: ["status:active", "priority:medium"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ]);
    linkStore.save({
      bindingId: binding.id,
      taskId: orphanedTaskId,
      issueNumber: 13,
      externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#13",
      lastMirroredAt: "2026-03-12T01:00:00.000Z",
    });

    const result = await bootstrapTasksToForgejoIssues({
      binding,
      baseUrl: target.baseUrl,
      apiBaseUrl: target.apiBaseUrl,
      owner: target.owner,
      repo: target.repo,
      tasks: [],
      issueClient,
      linkStore,
      shouldSkipIssueUpdate: () => true,
    });

    expect(result.closedIssues).toEqual([]);
    expect(linkStore.getByTaskId(binding.id, orphanedTaskId)).not.toBeNull();
  });
});
