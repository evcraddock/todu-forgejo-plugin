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
  it("imports open issues and creates durable links", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();

    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#1",
        title: "Open issue",
        body: "Imported body",
        state: "open",
        labels: ["bug"],
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
    expect(result.createdLinks).toHaveLength(1);
    expect(linkStore.getByIssueNumber(binding.id, 1)?.externalId).toBe(
      "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#1"
    );
  });

  it("exports active tasks to forgejo and assigns external ids and source urls", async () => {
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
        labels: [],
        assignees: [],
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
    expect(result.createdLinks).toHaveLength(1);
    expect(tasks[0].externalId).toBeDefined();
    expect(tasks[0].sourceUrl).toBe(
      "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test/issues/1"
    );
    expect(tasks[1].externalId).toBeUndefined();
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
        labels: [],
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
    expect(linkStore.getByTaskId(binding.id, tasks[0].id)?.issueNumber).toBe(7);
    expect(parseForgejoIssueExternalId(tasks[0].externalId!).issueNumber).toBe(7);
  });
});
