import {
  createIntegrationBindingId,
  createProjectId,
  createTaskId,
  type IntegrationBinding,
  type TaskPushPayload,
} from "@todu/core";

import { FORGEJO_PROVIDER_NAME, FORGEJO_REPOSITORY_TARGET_KIND } from "@/forgejo-binding";
import { createInMemoryForgejoIssueClient } from "@/forgejo-client";
import { createInMemoryForgejoItemLinkStore } from "@/forgejo-links";
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
    projectId: createBinding().projectId,
    labels: [],
    assignees: [],
    comments: [],
    createdAt: "2026-03-12T00:00:00.000Z",
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
