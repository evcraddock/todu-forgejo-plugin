import {
  createIntegrationBindingId,
  createProjectId,
  createTaskId,
  type ExportedTaskInput,
  type IntegrationBinding,
} from "@todu/core";

import { FORGEJO_PROVIDER_NAME, FORGEJO_REPOSITORY_TARGET_KIND } from "@/forgejo-binding";
import { createInMemoryForgejoIssueClient } from "@/forgejo-client";
import { createForgejoSyncLogger } from "@/forgejo-logger";
import { createInMemoryForgejoItemLinkStore } from "@/forgejo-links";
import { createForgejoLoopPreventionStore } from "@/forgejo-loop-prevention";
import { classifyForgejoSyncError, createForgejoSyncProvider } from "@/forgejo-provider";
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

function createExportedTask(overrides: Partial<ExportedTaskInput> = {}): ExportedTaskInput {
  return {
    localTaskId: createTaskId("task-1"),
    title: "Test task",
    description: "",
    status: "active",
    priority: "medium",
    labels: [],
    assignees: [],
    updatedAt: "2026-03-12T00:00:00.000Z",
    comments: [],
    ...overrides,
  };
}

describe("forgejo provider", () => {
  it("exports initialized settings after initialize and resets on shutdown", async () => {
    const provider = createForgejoSyncProvider({ issueClient: createInMemoryForgejoIssueClient() });

    expect(provider.getState().initialized).toBe(false);

    await provider.initialize({
      settings: {
        baseUrl: "https://code.example.com",
        token: "secret-token",
      },
    });

    expect(provider.getState().initialized).toBe(true);
    expect(provider.getState().settings?.apiBaseUrl).toBe("https://code.example.com/api/v1");

    await provider.shutdown();
    expect(provider.getState().initialized).toBe(false);
  });

  it("validates bindings during pull and push", async () => {
    const provider = createForgejoSyncProvider({ issueClient: createInMemoryForgejoIssueClient() });
    await provider.initialize({
      settings: {
        baseUrl: "https://code.example.com",
        token: "secret-token",
      },
    });

    await expect(provider.pull(createBinding(), project)).resolves.toEqual({
      tasks: [],
      comments: [],
    });
    await expect(provider.push(createBinding(), [], project)).resolves.toEqual({
      commentLinks: [],
      taskLinks: [],
    });
    await expect(provider.pull(createBinding({ provider: "github" }), project)).rejects.toThrow();
  });

  it("respects binding strategies for field and comment sync", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const provider = createForgejoSyncProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
    });
    await provider.initialize({
      settings: {
        baseUrl: "https://code.example.com",
        token: "secret-token",
      },
    });

    await expect(provider.pull(createBinding({ strategy: "push" }), project)).resolves.toEqual({
      tasks: [],
    });
    await expect(provider.push(createBinding({ strategy: "pull" }), [], project)).resolves.toEqual({
      commentLinks: [],
      taskLinks: [],
    });
  });

  it("returns empty normalized payloads for an empty repo", async () => {
    const provider = createForgejoSyncProvider({ issueClient: createInMemoryForgejoIssueClient() });
    await provider.initialize({
      settings: {
        baseUrl: "https://code.example.com",
        token: "secret-token",
      },
    });

    await expect(provider.pull(createBinding(), project)).resolves.toEqual({
      tasks: [],
      comments: [],
    });
  });
});

describe("forgejo provider runtime integration", () => {
  const target = {
    baseUrl: "https://code.example.com",
    apiBaseUrl: "https://code.example.com/api/v1",
    owner: "acme",
    repo: "roadmap",
  };

  it("records success in runtime store after a successful pull", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Issue",
        state: "open",
        labels: ["status:active"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    const runtimeStore = createInMemoryForgejoBindingRuntimeStore();
    const provider = createForgejoSyncProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
      runtimeStore,
    });

    await provider.initialize({
      settings: {
        baseUrl: target.baseUrl,
        token: "secret-token",
      },
    });
    await provider.pull(createBinding(), project);

    const state = runtimeStore.get(createBinding().id);
    expect(state).not.toBeNull();
    expect(state!.retryAttempt).toBe(0);
    expect(state!.lastSuccessAt).not.toBeNull();
    expect(state!.cursor).not.toBeNull();
    expect(state!.lastError).toBeNull();
  });

  it("imports closed issues and their comments on initial bootstrap when the binding option is enabled", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [
      {
        number: 7,
        externalId: "https://code.example.com/acme/roadmap#7",
        title: "Closed issue",
        state: "closed",
        labels: ["status:done", "priority:high"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ]);
    issueClient.seedComments(target, 7, [
      {
        id: 11,
        issueNumber: 7,
        body: "Imported comment body",
        author: "alice",
        createdAt: "2026-03-12T01:30:00.000Z",
        updatedAt: "2026-03-12T01:45:00.000Z",
      },
    ]);

    const provider = createForgejoSyncProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
      runtimeStore: createInMemoryForgejoBindingRuntimeStore(),
    });

    await provider.initialize({
      settings: {
        baseUrl: target.baseUrl,
        token: "secret-token",
      },
    });

    const result = await provider.pull(
      createBinding({ options: { importClosedOnBootstrap: true } }),
      project
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      title: "Closed issue",
      status: "done",
      priority: "high",
    });
    expect(result.comments).toHaveLength(1);
    expect(result.comments?.[0]).toMatchObject({
      externalId: "11",
      author: expect.objectContaining({ externalLogin: "alice", displayName: "alice" }),
    });
    expect(result.comments?.[0].body).toContain("Imported comment body");
    expect(provider.getState().commentLinks).toHaveLength(1);
  });

  it("limits incremental comment pulls to touched issues", async () => {
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
      {
        number: 8,
        externalId: "https://code.example.com/acme/roadmap#8",
        title: "Issue eight",
        state: "open",
        labels: ["status:active"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ]);
    issueClient.seedComments(target, 7, [
      {
        id: 11,
        issueNumber: 7,
        body: "Comment seven",
        author: "alice",
        createdAt: "2026-03-12T01:30:00.000Z",
        updatedAt: "2026-03-12T01:30:00.000Z",
      },
    ]);
    issueClient.seedComments(target, 8, [
      {
        id: 21,
        issueNumber: 8,
        body: "Comment eight",
        author: "bob",
        createdAt: "2026-03-12T01:30:00.000Z",
        updatedAt: "2026-03-12T01:30:00.000Z",
      },
    ]);

    const runtimeStore = createInMemoryForgejoBindingRuntimeStore();
    const provider = createForgejoSyncProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
      runtimeStore,
    });

    await provider.initialize({
      settings: {
        baseUrl: target.baseUrl,
        token: "secret-token",
      },
    });

    await provider.pull(createBinding(), project);

    const updatedAtAfterFirstPull = new Date(Date.now() + 60_000).toISOString();
    issueClient.seedIssues(target, [
      {
        number: 7,
        externalId: "https://code.example.com/acme/roadmap#7",
        title: "Issue seven updated",
        state: "open",
        labels: ["status:active"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: updatedAtAfterFirstPull,
      },
      {
        number: 8,
        externalId: "https://code.example.com/acme/roadmap#8",
        title: "Issue eight",
        state: "open",
        labels: ["status:active"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ]);

    const listCommentsCalls: Array<{ issueNumber: number; since?: string }> = [];
    const originalListComments = issueClient.listComments.bind(issueClient);
    issueClient.listComments = async (bindingTarget, issueNumber, options) => {
      listCommentsCalls.push({ issueNumber, since: options?.since });
      return originalListComments(bindingTarget, issueNumber, options);
    };

    await provider.pull(createBinding(), project);

    expect(listCommentsCalls).toHaveLength(1);
    expect(listCommentsCalls[0].issueNumber).toBe(7);
    expect(listCommentsCalls[0].since).toEqual(expect.any(String));
  });

  it("records failure in runtime store when pull throws", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.listIssues = async () => {
      throw new Error("Forgejo API GET /repos/acme/roadmap/issues failed: 429 slow down");
    };

    const runtimeStore = createInMemoryForgejoBindingRuntimeStore();
    const provider = createForgejoSyncProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
      runtimeStore,
    });

    await provider.initialize({
      settings: {
        baseUrl: target.baseUrl,
        token: "secret-token",
      },
    });

    await expect(provider.pull(createBinding(), project)).rejects.toThrow("429 slow down");

    const state = runtimeStore.get(createBinding().id);
    expect(state).not.toBeNull();
    expect(state!.retryAttempt).toBe(1);
    expect(state!.lastError).toContain("rate limited");
    expect(state!.nextRetryAt).not.toBeNull();
  });

  it("skips pull when retry backoff has not elapsed", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Issue",
        state: "open",
        labels: ["status:active"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    const originalListIssues = issueClient.listIssues.bind(issueClient);
    let callCount = 0;
    issueClient.listIssues = async (bindingTarget, options) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("transient network failure");
      }

      return originalListIssues(bindingTarget, options);
    };

    const runtimeStore = createInMemoryForgejoBindingRuntimeStore();
    const provider = createForgejoSyncProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
      runtimeStore,
      retryConfig: { initialSeconds: 3600, maxSeconds: 3600 },
    });

    await provider.initialize({
      settings: {
        baseUrl: target.baseUrl,
        token: "secret-token",
      },
    });

    await expect(provider.pull(createBinding(), project)).rejects.toThrow();

    const result = await provider.pull(createBinding(), project);
    expect(result.tasks).toEqual([]);
    expect(callCount).toBe(1);
  });

  it("records loop prevention writes during push and includes outbound assignees", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const loopPreventionStore = createForgejoLoopPreventionStore();
    const provider = createForgejoSyncProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
      loopPreventionStore,
    });

    await provider.initialize({
      settings: {
        baseUrl: target.baseUrl,
        token: "secret-token",
      },
    });

    const tasks: ExportedTaskInput[] = [
      createExportedTask({
        localTaskId: createTaskId("task-loop"),
        title: "Loop test",
        assignees: [{ externalLogin: "caradoc", displayName: "caradoc" }],
      }),
    ];

    await provider.push(createBinding(), tasks, project);

    const writes = loopPreventionStore.listAll();
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0].key).toContain("issue:");
    expect(issueClient.snapshotIssues(target)[0].assignees).toEqual([
      expect.objectContaining({ externalLogin: "caradoc", displayName: "caradoc" }),
    ]);
  });

  it("records closed orphaned issues in loop prevention and push summary logging", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [
      {
        number: 9,
        externalId: "https://code.example.com/acme/roadmap#9",
        title: "Deleted task issue",
        state: "open",
        labels: ["status:active", "priority:medium"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ]);

    const linkStore = createInMemoryForgejoItemLinkStore();
    linkStore.save({
      bindingId: createBinding().id,
      taskId: createTaskId("task-deleted"),
      issueNumber: 9,
      externalId: "https://code.example.com/acme/roadmap#9",
      lastMirroredAt: "2026-03-12T01:00:00.000Z",
    });

    const loopPreventionStore = createForgejoLoopPreventionStore();
    const logger = createForgejoSyncLogger();
    const provider = createForgejoSyncProvider({
      issueClient,
      linkStore,
      loopPreventionStore,
      logger,
    });

    await provider.initialize({
      settings: {
        baseUrl: target.baseUrl,
        token: "secret-token",
      },
    });

    await provider.push(createBinding(), [], project);

    expect(provider.getState().lastPushResult).toMatchObject({
      closedIssues: [expect.objectContaining({ number: 9, state: "closed" })],
    });
    expect(linkStore.getByTaskId(createBinding().id, createTaskId("task-deleted"))).toBeNull();
    expect(loopPreventionStore.listAll()).toContainEqual(
      expect.objectContaining({ key: `issue:${createBinding().id}:9` })
    );
    expect(logger.getEntries().at(-1)).toMatchObject({
      message: "push completed",
      context: expect.objectContaining({ itemId: expect.stringContaining("1 closed") }),
    });
  });

  it("reports skipped linked task push metrics without reading forgejo issues", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const linkStore = createInMemoryForgejoItemLinkStore();
    linkStore.save({
      bindingId: createBinding().id,
      taskId: createTaskId("task-7"),
      issueNumber: 7,
      externalId: "https://code.example.com/acme/roadmap#7",
      lastMirroredAt: "2026-03-12T02:00:00.000Z",
    });

    let getIssueCalls = 0;
    issueClient.getIssue = async () => {
      getIssueCalls += 1;
      throw new Error("getIssue should not be called for unchanged linked tasks");
    };

    const provider = createForgejoSyncProvider({ issueClient, linkStore });
    await provider.initialize({
      settings: {
        baseUrl: target.baseUrl,
        token: "secret-token",
      },
    });

    await provider.push(
      createBinding(),
      [
        createExportedTask({
          localTaskId: createTaskId("task-7"),
          title: "Unchanged task",
          updatedAt: "2026-03-12T01:00:00.000Z",
        }),
      ],
      project
    );

    expect(getIssueCalls).toBe(0);
    expect(provider.getState().lastPushResult).toMatchObject({
      issueReadCount: 0,
      skippedLinkedTasks: 1,
      hydratedLinkedTasks: 0,
    });
  });

  it("uses loop prevention to skip repeated issue mirror writes", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Loop test",
        state: "open",
        labels: ["status:active", "priority:medium"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    const linkStore = createInMemoryForgejoItemLinkStore();
    linkStore.save({
      bindingId: createBinding().id,
      taskId: createTaskId("task-loop"),
      issueNumber: 1,
      externalId: "https://code.example.com/acme/roadmap#1",
    });

    const originalUpdateIssue = issueClient.updateIssue.bind(issueClient);
    let updateCallCount = 0;
    issueClient.updateIssue = async (bindingTarget, issueNumber, input) => {
      updateCallCount += 1;
      return originalUpdateIssue(bindingTarget, issueNumber, input);
    };

    const loopPreventionStore = createForgejoLoopPreventionStore();
    const provider = createForgejoSyncProvider({
      issueClient,
      linkStore,
      loopPreventionStore,
    });

    await provider.initialize({
      settings: {
        baseUrl: target.baseUrl,
        token: "secret-token",
      },
    });

    const firstTask: ExportedTaskInput = createExportedTask({
      localTaskId: createTaskId("task-loop"),
      title: "Loop test updated",
      updatedAt: "2026-03-12T01:00:00.000Z",
    });

    await provider.push(createBinding(), [firstTask], project);
    expect(updateCallCount).toBe(1);

    const issueUpdatedAt = issueClient.snapshotIssues(target)[0].updatedAt!;
    const secondTask: ExportedTaskInput = {
      ...firstTask,
      updatedAt: issueUpdatedAt,
    };

    await provider.push(createBinding(), [secondTask], project);
    expect(updateCallCount).toBe(1);
  });

  it("updates binding status through running to idle on success", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Issue",
        state: "open",
        labels: ["status:active"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);
    const provider = createForgejoSyncProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
    });

    await provider.initialize({
      settings: {
        baseUrl: target.baseUrl,
        token: "secret-token",
      },
    });
    await provider.pull(createBinding(), project);

    const status = provider.getState().bindingStatuses.get(createBinding().id);
    expect(status).toBeDefined();
    expect(status!.state).toBe("idle");
    expect(status!.lastSuccessAt).not.toBeNull();
  });

  it("updates binding status to blocked on auth failures", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.listIssues = async () => {
      throw new Error("Forgejo API GET /repos/acme/roadmap/issues failed: 401 unauthorized");
    };

    const logger = createForgejoSyncLogger();
    const provider = createForgejoSyncProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
      logger,
    });

    await provider.initialize({
      settings: {
        baseUrl: target.baseUrl,
        token: "secret-token",
      },
    });
    await expect(provider.pull(createBinding(), project)).rejects.toThrow();

    const status = provider.getState().bindingStatuses.get(createBinding().id);
    expect(status).toBeDefined();
    expect(status!.state).toBe("blocked");
    expect(status!.lastErrorSummary).toContain("authentication failed");
    expect(logger.getEntries().at(-1)?.message).toBe("pull blocked");
  });

  it("skips future cycles temporarily after a blocked auth failure", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    let callCount = 0;
    issueClient.listIssues = async () => {
      callCount += 1;
      throw new Error("Forgejo API GET /repos/acme/roadmap/issues failed: 401 unauthorized");
    };

    const runtimeStore = createInMemoryForgejoBindingRuntimeStore();
    const provider = createForgejoSyncProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
      runtimeStore,
    });

    await provider.initialize({
      settings: {
        baseUrl: target.baseUrl,
        token: "secret-token",
      },
    });

    await expect(provider.pull(createBinding(), project)).rejects.toThrow();
    const retryResult = await provider.pull(createBinding(), project);

    expect(retryResult.tasks).toEqual([]);
    expect(callCount).toBe(1);
    expect(runtimeStore.get(createBinding().id)?.nextRetryAt).not.toBeNull();
  });

  it("resets retry state after a successful cycle following a failure", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    issueClient.seedIssues(target, [
      {
        number: 1,
        externalId: "https://code.example.com/acme/roadmap#1",
        title: "Issue",
        state: "open",
        labels: ["status:active"],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    let shouldFail = true;
    const originalListIssues = issueClient.listIssues.bind(issueClient);
    issueClient.listIssues = async (bindingTarget, options) => {
      if (shouldFail) {
        throw new Error("Forgejo API GET /repos/acme/roadmap/issues failed: 500 server error");
      }

      return originalListIssues(bindingTarget, options);
    };

    const runtimeStore = createInMemoryForgejoBindingRuntimeStore();
    const provider = createForgejoSyncProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
      runtimeStore,
      retryConfig: { initialSeconds: 0, maxSeconds: 0 },
    });

    await provider.initialize({
      settings: {
        baseUrl: target.baseUrl,
        token: "secret-token",
      },
    });
    await expect(provider.pull(createBinding(), project)).rejects.toThrow();

    const failedState = runtimeStore.get(createBinding().id);
    expect(failedState!.retryAttempt).toBe(1);

    shouldFail = false;
    await provider.pull(createBinding(), project);

    const successState = runtimeStore.get(createBinding().id);
    expect(successState!.retryAttempt).toBe(0);
    expect(successState!.lastError).toBeNull();
    expect(successState!.lastSuccessAt).not.toBeNull();
  });
});

describe("classifyForgejoSyncError", () => {
  it("classifies auth, permission, rate limit, server, and transport failures", () => {
    expect(classifyForgejoSyncError(new Error("401 unauthorized"))).toMatchObject({
      kind: "auth",
      retryable: false,
    });
    expect(classifyForgejoSyncError(new Error("403 forbidden"))).toMatchObject({
      kind: "permission",
      retryable: false,
    });
    expect(classifyForgejoSyncError(new Error("429 rate limit"))).toMatchObject({
      kind: "rate-limit",
      retryable: true,
    });
    expect(classifyForgejoSyncError(new Error("500 internal server error"))).toMatchObject({
      kind: "server",
      retryable: true,
    });
    expect(classifyForgejoSyncError(new Error("network timeout"))).toMatchObject({
      kind: "transport",
      retryable: true,
    });
  });
});
