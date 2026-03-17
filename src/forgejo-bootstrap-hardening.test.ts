import {
  createIntegrationBindingId,
  createProjectId,
  createTaskId,
  type IntegrationBinding,
  type TaskPushPayload,
} from "@todu/core";

import { createInMemoryForgejoIssueClient } from "@/forgejo-client";
import { createInMemoryForgejoItemLinkStore } from "@/forgejo-links";
import { bootstrapForgejoIssuesToTasks, bootstrapTasksToForgejoIssues } from "@/forgejo-bootstrap";

const binding: IntegrationBinding = {
  id: createIntegrationBindingId("binding-1"),
  provider: "forgejo",
  projectId: createProjectId("project-1"),
  targetKind: "repository",
  targetRef: "acme/roadmap",
  strategy: "bidirectional",
  enabled: true,
  createdAt: "2026-03-12T00:00:00.000Z",
  updatedAt: "2026-03-12T00:00:00.000Z",
};

const target = {
  baseUrl: "https://code.example.com",
  apiBaseUrl: "https://code.example.com/api/v1",
  owner: "acme",
  repo: "roadmap",
};

function createPushTask(overrides: Partial<TaskPushPayload> = {}): TaskPushPayload {
  return {
    id: createTaskId("task-1"),
    title: "Test task",
    description: "",
    status: "active",
    priority: "medium",
    projectId: binding.projectId,
    labels: [],
    assignees: [],
    comments: [],
    createdAt: "2026-03-12T00:00:00.000Z",
    updatedAt: "2026-03-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("bootstrap status transitions", () => {
  it("maps done task to closed issue with status:done label", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();
    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Open issue",
        state: "open",
        labels: ["status:active", "priority:medium"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);
    linkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-1"),
      issueNumber: 1,
      externalId: "https://code.example.com/acme/roadmap#1",
    });

    const result = await bootstrapTasksToForgejoIssues({
      binding,
      ...target,
      tasks: [
        createPushTask({
          status: "done",
          externalId: "https://code.example.com/acme/roadmap#1",
          updatedAt: "2026-03-12T01:00:00.000Z",
        }),
      ],
      issueClient,
      linkStore,
    });

    expect(result.updatedIssues).toHaveLength(1);
    expect(result.updatedIssues[0].state).toBe("closed");
    expect(result.updatedIssues[0].labels).toContain("status:done");
  });

  it("maps canceled task to closed issue with status:canceled label", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();
    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Open issue",
        state: "open",
        labels: ["status:active", "priority:medium"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);
    linkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-1"),
      issueNumber: 1,
      externalId: "https://code.example.com/acme/roadmap#1",
    });

    const result = await bootstrapTasksToForgejoIssues({
      binding,
      ...target,
      tasks: [
        createPushTask({
          status: "canceled",
          externalId: "https://code.example.com/acme/roadmap#1",
          updatedAt: "2026-03-12T01:00:00.000Z",
        }),
      ],
      issueClient,
      linkStore,
    });

    expect(result.updatedIssues).toHaveLength(1);
    expect(result.updatedIssues[0].state).toBe("closed");
    expect(result.updatedIssues[0].labels).toContain("status:canceled");
  });

  it("reopens a closed issue when task moves back to active", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();
    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Closed issue",
        state: "closed",
        labels: ["status:done", "priority:medium"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);
    linkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-1"),
      issueNumber: 1,
      externalId: "https://code.example.com/acme/roadmap#1",
    });

    const result = await bootstrapTasksToForgejoIssues({
      binding,
      ...target,
      tasks: [
        createPushTask({
          status: "active",
          externalId: "https://code.example.com/acme/roadmap#1",
          updatedAt: "2026-03-12T01:00:00.000Z",
        }),
      ],
      issueClient,
      linkStore,
    });

    expect(result.updatedIssues).toHaveLength(1);
    expect(result.updatedIssues[0].state).toBe("open");
    expect(result.updatedIssues[0].labels).toContain("status:active");
    expect(result.updatedIssues[0].labels).not.toContain("status:done");
  });

  it("imports closed issue as done task", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();

    linkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-1"),
      issueNumber: 1,
      externalId: "https://code.example.com/acme/roadmap#1",
    });

    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Closed issue",
        state: "closed",
        labels: ["status:done", "priority:high"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ]);

    const result = await bootstrapForgejoIssuesToTasks({
      binding,
      ...target,
      issueClient,
      linkStore,
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].status).toBe("done");
    expect(result.tasks[0].priority).toBe("high");
  });

  it("imports closed issue with status:canceled as canceled task", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();

    linkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-1"),
      issueNumber: 1,
      externalId: "https://code.example.com/acme/roadmap#1",
    });

    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Canceled issue",
        state: "closed",
        labels: ["status:canceled"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ]);

    const result = await bootstrapForgejoIssuesToTasks({
      binding,
      ...target,
      issueClient,
      linkStore,
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].status).toBe("canceled");
  });

  it("skips unlinked closed issues during initial bootstrap by default", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();

    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Closed issue",
        state: "closed",
        labels: ["status:done"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ]);

    const result = await bootstrapForgejoIssuesToTasks({
      binding,
      ...target,
      issueClient,
      linkStore,
    });

    expect(result.tasks).toHaveLength(0);
    expect(result.createdLinks).toHaveLength(0);
  });

  it("imports unlinked closed issues during initial bootstrap when opt-in is enabled", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();

    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Canceled issue",
        state: "closed",
        labels: ["status:canceled", "priority:high"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ]);

    const result = await bootstrapForgejoIssuesToTasks({
      binding,
      ...target,
      issueClient,
      linkStore,
      importClosedOnBootstrap: true,
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      title: "Canceled issue",
      status: "canceled",
      priority: "high",
    });
    expect(result.createdLinks).toHaveLength(1);
    expect(linkStore.getByIssueNumber(binding.id, 1)).not.toBeNull();
  });

  it("does not import newly seen closed issues during incremental pull even when opt-in is enabled", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();

    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Closed issue",
        state: "closed",
        labels: ["status:done"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T02:00:00.000Z",
      },
    ]);

    const result = await bootstrapForgejoIssuesToTasks({
      binding,
      ...target,
      issueClient,
      linkStore,
      since: "2026-03-12T01:00:00.000Z",
      importClosedOnBootstrap: true,
    });

    expect(result.tasks).toHaveLength(0);
    expect(result.createdLinks).toHaveLength(0);
  });

  it("skips done and canceled tasks during export (no new issue created)", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();

    const result = await bootstrapTasksToForgejoIssues({
      binding,
      ...target,
      tasks: [
        createPushTask({ id: createTaskId("done-task"), status: "done" }),
        createPushTask({ id: createTaskId("canceled-task"), status: "canceled" }),
      ],
      issueClient,
      linkStore,
    });

    expect(result.createdIssues).toHaveLength(0);
    expect(result.createdLinks).toHaveLength(0);
  });

  it("does not update an issue when content already matches", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();

    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Matching title",
        body: "Matching body",
        state: "open",
        labels: ["status:active", "priority:medium"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T05:00:00.000Z",
      },
    ]);
    linkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-1"),
      issueNumber: 1,
      externalId: "https://code.example.com/acme/roadmap#1",
    });

    const result = await bootstrapTasksToForgejoIssues({
      binding,
      ...target,
      tasks: [
        createPushTask({
          title: "Matching title",
          description: "Matching body",
          status: "active",
          priority: "medium",
          externalId: "https://code.example.com/acme/roadmap#1",
          updatedAt: "2026-03-12T01:00:00.000Z",
        }),
      ],
      issueClient,
      linkStore,
    });

    expect(result.updatedIssues).toHaveLength(0);
  });

  it("does not update a linked issue when task and mirror timestamps are equal", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();
    linkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-equal"),
      issueNumber: 1,
      externalId: "https://code.example.com/acme/roadmap#1",
      lastMirroredAt: "2026-03-12T01:00:00.000Z",
    });

    const result = await bootstrapTasksToForgejoIssues({
      binding,
      ...target,
      tasks: [
        createPushTask({
          id: createTaskId("task-equal"),
          title: "Changed title but equal timestamp",
          externalId: "https://code.example.com/acme/roadmap#1",
          updatedAt: "2026-03-12T01:00:00.000Z",
        }),
      ],
      issueClient,
      linkStore,
    });

    expect(result.updatedIssues).toHaveLength(0);
    expect(result.skippedLinkedTasks).toBe(1);
  });
});

describe("bootstrap pull request filtering", () => {
  it("skips pull requests during import", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();

    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Real issue",
        state: "open",
        labels: [],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
      {
        number: 2,
        externalId: "https://code.example.com/acme/roadmap#2",
        title: "Pull request",
        state: "open",
        labels: [],
        assignees: [],
        isPullRequest: true,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    const result = await bootstrapForgejoIssuesToTasks({
      binding,
      ...target,
      issueClient,
      linkStore,
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe("Real issue");
  });
});

describe("bootstrap steady-state deduplication", () => {
  it("does not create duplicate issues on repeated push cycles", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();
    const task = createPushTask({ title: "Once only" });

    await bootstrapTasksToForgejoIssues({
      binding,
      ...target,
      tasks: [task],
      issueClient,
      linkStore,
    });

    expect(issueClient.snapshotIssues(target)).toHaveLength(1);

    await bootstrapTasksToForgejoIssues({
      binding,
      ...target,
      tasks: [task],
      issueClient,
      linkStore,
    });

    expect(issueClient.snapshotIssues(target)).toHaveLength(1);
  });

  it("does not create duplicate links on repeated pull cycles", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();

    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Issue",
        state: "open",
        labels: [],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    const first = await bootstrapForgejoIssuesToTasks({
      binding,
      ...target,
      issueClient,
      linkStore,
    });
    const second = await bootstrapForgejoIssuesToTasks({
      binding,
      ...target,
      issueClient,
      linkStore,
    });

    expect(first.createdLinks).toHaveLength(1);
    expect(second.createdLinks).toHaveLength(0);
    expect(linkStore.listAll()).toHaveLength(1);
  });
});
