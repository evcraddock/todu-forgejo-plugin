import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createIntegrationBindingId,
  createProjectId,
  createTaskId,
  type ExportedTaskInput,
  type IntegrationBinding,
} from "@todu/core";

import { createInMemoryForgejoIssueClient } from "@/forgejo-client";
import { createInMemoryForgejoItemLinkStore } from "@/forgejo-links";
import { createForgejoSyncProvider } from "@/forgejo-provider";
import {
  createFileForgejoBindingRuntimeStore,
  createInMemoryForgejoBindingRuntimeStore,
} from "@/forgejo-runtime";

const binding: IntegrationBinding = {
  id: createIntegrationBindingId("binding-checkpoints"),
  provider: "forgejo",
  projectId: createProjectId("project-checkpoints"),
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
const issue = {
  number: 7,
  externalId: `${target.baseUrl}/acme/roadmap#7`,
  title: "Observed issue",
  state: "open" as const,
  labels: ["status:active", "priority:medium"],
  assignees: [],
  createdAt: "2026-03-12T00:00:00.000Z",
  updatedAt: "2026-03-12T00:01:00.000Z",
};
const task: ExportedTaskInput = {
  localTaskId: createTaskId("task-7"),
  externalId: issue.externalId,
  title: issue.title,
  description: "",
  status: "active",
  priority: "medium",
  labels: [],
  assignees: [],
  comments: [],
  updatedAt: issue.updatedAt,
};

async function createFixture(runtimeStore = createInMemoryForgejoBindingRuntimeStore()) {
  const issueClient = createInMemoryForgejoIssueClient();
  issueClient.seedIssues(target, [issue]);
  const linkStore = createInMemoryForgejoItemLinkStore();
  linkStore.save({
    bindingId: binding.id,
    taskId: task.localTaskId,
    issueNumber: issue.number,
    externalId: issue.externalId,
    lastMirroredAt: issue.updatedAt,
  });
  const issueSinceValues: Array<string | undefined> = [];
  const commentSinceValues: Array<string | undefined> = [];
  const listIssues = issueClient.listIssues.bind(issueClient);
  const listComments = issueClient.listComments.bind(issueClient);
  issueClient.listIssues = async (repository, options) => {
    issueSinceValues.push(options?.since);
    return listIssues(repository, options);
  };
  issueClient.listComments = async (repository, number, options) => {
    commentSinceValues.push(options?.since);
    return listComments(repository, number, options);
  };
  const provider = createForgejoSyncProvider({ issueClient, linkStore, runtimeStore });
  await provider.initialize({ settings: { baseUrl: target.baseUrl, token: "test-token" } });
  return { provider, issueClient, linkStore, runtimeStore, issueSinceValues, commentSinceValues };
}

async function pullAndAcknowledge(provider: ReturnType<typeof createForgejoSyncProvider>) {
  const batch = await provider.pull(binding, project);
  await provider.acknowledgePull(binding, batch.checkpoint, project);
  return batch;
}

describe("Forgejo read/write checkpoint isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T00:02:00.750Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("keeps both pull cursors when issues and comments change between pull and push", async () => {
    const fixture = await createFixture();
    await pullAndAcknowledge(fixture.provider);
    const beforePush = fixture.runtimeStore.get(binding.id)!;
    vi.setSystemTime(new Date("2026-03-12T00:02:01.000Z"));
    fixture.issueClient.seedIssues(target, [
      { ...issue, title: "Between pull and push", updatedAt: new Date().toISOString() },
    ]);
    fixture.issueClient.seedComments(target, 7, [
      {
        id: 11,
        issueNumber: 7,
        body: "Between pull and push",
        createdAt: new Date().toISOString(),
      },
    ]);
    const listLabels = fixture.issueClient.listLabels.bind(fixture.issueClient);
    fixture.issueClient.listLabels = async (repository) => {
      vi.setSystemTime(new Date("2026-03-12T00:02:02.000Z"));
      fixture.issueClient.seedComments(target, 7, [
        ...fixture.issueClient.snapshotComments(target, 7),
        { id: 12, issueNumber: 7, body: "During push", createdAt: new Date().toISOString() },
      ]);
      return listLabels(repository);
    };
    await fixture.provider.push(binding, [task], project);
    const afterPush = fixture.runtimeStore.get(binding.id)!;
    expect(afterPush.issuePullCursor).toBe("2026-03-12T00:01:59.000Z");
    expect(afterPush.commentPullCursor).toBe("2026-03-12T00:01:59.000Z");
    expect(afterPush.issuePullCursor).toBe(beforePush.issuePullCursor);
    expect(afterPush.commentPullCursor).toBe(beforePush.commentPullCursor);
    expect(afterPush.lastPushSuccessAt).toBe("2026-03-12T00:02:02.000Z");

    vi.setSystemTime(new Date("2026-03-12T00:02:10.000Z"));
    const replay = await fixture.provider.pull(binding, project);
    expect(fixture.issueSinceValues.at(-1)).toBe(beforePush.issuePullCursor);
    expect(fixture.commentSinceValues.at(-1)).toBe(beforePush.commentPullCursor);
    expect(replay.tasks[0].title).toBe("Between pull and push");
    expect(replay.comments?.map((comment) => comment.externalId)).toEqual(["11", "12"]);
  });

  it("checkpoints empty pulls without allowing a later push to move either read boundary", async () => {
    const fixture = await createFixture();
    fixture.issueClient.seedIssues(target, []);
    fixture.linkStore.remove(binding.id, task.localTaskId);
    expect(await pullAndAcknowledge(fixture.provider)).toMatchObject({ tasks: [], comments: [] });
    vi.setSystemTime(new Date("2026-03-12T00:05:00.000Z"));
    await fixture.provider.push(binding, [], project);
    expect(fixture.runtimeStore.get(binding.id)).toMatchObject({
      issuePullCursor: "2026-03-12T00:01:59.000Z",
      commentPullCursor: "2026-03-12T00:01:59.000Z",
      lastPushSuccessAt: "2026-03-12T00:05:00.000Z",
    });
  });

  it("does not establish pull progress in push-only mode before switching to pull", async () => {
    const fixture = await createFixture();
    vi.setSystemTime(new Date("2026-03-12T00:05:00.000Z"));
    await fixture.provider.push({ ...binding, strategy: "push" }, [task], project);
    expect(fixture.runtimeStore.get(binding.id)).toMatchObject({
      issuePullCursor: null,
      commentPullCursor: null,
      lastPushSuccessAt: "2026-03-12T00:05:00.000Z",
    });
    fixture.issueClient.seedComments(target, 7, [
      { id: 11, issueNumber: 7, body: "Older than push", createdAt: "2026-03-12T00:01:30.000Z" },
    ]);
    const result = await fixture.provider.pull({ ...binding, strategy: "pull" }, project);
    expect(fixture.issueSinceValues.at(-1)).toBeUndefined();
    expect(fixture.commentSinceValues.at(-1)).toBeUndefined();
    expect(result.tasks).toHaveLength(1);
    expect(result.comments).toHaveLength(1);
  });

  it.each(["500 unavailable", "403 forbidden"])(
    "push success preserves pending pull progress and diagnostics after %s",
    async (error) => {
      const fixture = await createFixture();
      await pullAndAcknowledge(fixture.provider);
      fixture.issueClient.seedComments(target, 7, [
        { id: 11, issueNumber: 7, body: "Unread comment", createdAt: "2026-03-12T00:02:01.000Z" },
      ]);
      const listComments = fixture.issueClient.listComments.bind(fixture.issueClient);
      fixture.issueClient.listComments = async () => {
        throw new Error(error);
      };
      vi.setSystemTime(new Date("2026-03-12T00:03:00.000Z"));
      await expect(fixture.provider.pull(binding, project)).rejects.toThrow(error);
      const failed = fixture.runtimeStore.get(binding.id)!;
      fixture.issueClient.listComments = listComments;
      vi.setSystemTime(new Date(failed.nextRetryAt!));
      await fixture.provider.push(binding, [task], project);
      const pushed = fixture.runtimeStore.get(binding.id)!;
      expect(pushed).toMatchObject({
        issuePullCursor: "2026-03-12T00:01:59.000Z",
        commentPullCursor: "2026-03-12T00:01:59.000Z",
        pendingCommentIssueNumbers: [7],
        retryAttempt: failed.retryAttempt,
        nextRetryAt: failed.nextRetryAt,
        lastError: failed.lastError,
        lastFailurePhase: "pull:comments",
        lastFailureCursor: failed.lastFailureCursor,
        lastProgressAt: failed.lastProgressAt,
      });
      expect(fixture.provider.getState().bindingStatuses.get(binding.id)?.state).toBe(
        error.startsWith("403") ? "blocked" : "error"
      );
      const recovered = await pullAndAcknowledge(fixture.provider);
      expect(recovered.tasks).toEqual([]);
      expect(recovered.comments).toHaveLength(1);
      expect(fixture.commentSinceValues.at(-1)).toBe("2026-03-12T00:01:59.000Z");
      expect(fixture.runtimeStore.get(binding.id)).toMatchObject({
        pendingCommentIssueNumbers: [],
        retryAttempt: 0,
        lastFailurePhase: null,
      });
    }
  );

  it("retains an issue-read failure across failed/successful pushes and restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-pull-failure-"));
    try {
      const storagePath = path.join(dir, "runtime-state.json");
      const fixture = await createFixture(createFileForgejoBindingRuntimeStore(storagePath));
      await pullAndAcknowledge(fixture.provider);
      fixture.issueClient.listIssues = async () => {
        throw new Error("403 forbidden issue reads");
      };
      await expect(fixture.provider.pull(binding, project)).rejects.toThrow("403");
      const failedPull = fixture.runtimeStore.get(binding.id)!;
      const pushBinding = { ...binding, strategy: "push" as const };
      const listLabels = fixture.issueClient.listLabels.bind(fixture.issueClient);
      fixture.issueClient.listLabels = async () => {
        throw new Error("500 unavailable labels");
      };
      vi.setSystemTime(new Date(failedPull.nextRetryAt!));
      await expect(fixture.provider.push(pushBinding, [task], project)).rejects.toThrow("500");
      const failedPush = fixture.runtimeStore.get(binding.id)!;
      expect(failedPush.lastFailurePhase).toBe("push:issues");
      expect(failedPush.lastError).toContain("500");
      expect(failedPush.retryAttempt).toBe(2);
      // Reopen durable state before the successful write, without any recovery pull.
      const runtimeStore = createFileForgejoBindingRuntimeStore(storagePath);
      const provider = createForgejoSyncProvider({
        issueClient: fixture.issueClient,
        linkStore: fixture.linkStore,
        runtimeStore,
      });
      await provider.initialize({ settings: { baseUrl: target.baseUrl, token: "test-token" } });
      fixture.issueClient.listLabels = listLabels;
      vi.setSystemTime(new Date(failedPush.nextRetryAt!));
      await provider.push(pushBinding, [task], project);
      const pushed = runtimeStore.get(binding.id)!;
      expect(pushed).toMatchObject({
        issuePullCursor: failedPull.issuePullCursor,
        commentPullCursor: failedPull.commentPullCursor,
        lastError: failedPull.lastError,
        lastFailurePhase: "pull:issues",
        lastFailureCursor: failedPull.lastFailureCursor,
        lastProgressAt: failedPull.lastProgressAt,
        retryAttempt: failedPush.retryAttempt,
        nextRetryAt: failedPush.nextRetryAt,
      });
      expect(provider.getState().bindingStatuses.get(binding.id)?.state).toBe("blocked");
      expect(pushed.unresolvedPullFailure).not.toBeNull();
      fixture.issueClient.listIssues = async () => [];
      await pullAndAcknowledge(provider);
      expect(runtimeStore.get(binding.id)).toMatchObject({
        unresolvedPullFailure: null,
        lastError: null,
        lastFailurePhase: null,
        retryAttempt: 0,
      });
      expect(provider.getState().bindingStatuses.get(binding.id)?.state).toBe("idle");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("keeps migrated unknown read errors visible after a successful push", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-unknown-failure-"));
    try {
      const storagePath = path.join(dir, "runtime-state.json");
      fs.writeFileSync(
        storagePath,
        JSON.stringify([
          {
            bindingId: binding.id,
            cursor: "2026-03-12T00:01:00.000Z",
            lastSuccessAt: "2026-03-12T00:01:00.000Z",
            lastError: "permission denied: 403 issue discovery",
            retryAttempt: 1,
            nextRetryAt: "2026-03-12T00:02:00.000Z",
            lastFailurePhase: null,
          },
        ])
      );
      const fixture = await createFixture(createFileForgejoBindingRuntimeStore(storagePath));
      await fixture.provider.push({ ...binding, strategy: "push" }, [task], project);
      expect(fixture.provider.getState().bindingStatuses.get(binding.id)?.state).toBe("blocked");
      expect(fixture.runtimeStore.get(binding.id)).toMatchObject({
        issuePullCursor: null,
        commentPullCursor: null,
        lastError: "permission denied: 403 issue discovery",
        lastFailurePhase: null,
        retryAttempt: 1,
      });
      expect(fixture.issueSinceValues).toEqual([]);
      await pullAndAcknowledge(fixture.provider);
      expect(fixture.runtimeStore.get(binding.id)?.unresolvedPullFailure).toBeNull();
      expect(fixture.provider.getState().bindingStatuses.get(binding.id)?.state).toBe("idle");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("replays comments in the pull-start second without creating duplicate links", async () => {
    const fixture = await createFixture();
    const listComments = fixture.issueClient.listComments.bind(fixture.issueClient);
    let firstRead = true;
    fixture.issueClient.listComments = async (repository, number, options) => {
      // Model exclusive timestamp filtering and a new comment absent from the snapshot.
      const snapshot = (await listComments(repository, number, options)).filter(
        (comment) => !options?.since || Date.parse(comment.createdAt) > Date.parse(options.since)
      );
      if (firstRead) {
        firstRead = false;
        fixture.issueClient.seedComments(target, 7, [
          {
            id: 11,
            issueNumber: 7,
            body: "Start-second comment",
            createdAt: "2026-03-12T00:02:00.000Z",
          },
        ]);
        vi.setSystemTime(new Date("2026-03-12T00:02:00.900Z"));
      }
      return snapshot;
    };
    expect((await pullAndAcknowledge(fixture.provider)).comments).toEqual([]);
    expect((await pullAndAcknowledge(fixture.provider)).comments).toHaveLength(1);
    expect((await pullAndAcknowledge(fixture.provider)).comments).toHaveLength(1);
    expect(fixture.provider.getState().commentLinks).toHaveLength(1);
    expect(fixture.provider.getState().commentLinks[0].forgejoCommentId).toBe(11);
  });

  it("loads legacy checkpoints conservatively and persists migration across restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-checkpoints-"));
    try {
      const storagePath = path.join(dir, "runtime-state.json");
      const legacy = {
        bindingId: binding.id,
        cursor: "2026-03-12T00:05:00.000Z",
        lastSuccessAt: "2026-03-12T00:05:00.000Z",
        retryAttempt: 2,
        nextRetryAt: "2026-03-12T00:06:00.000Z",
        lastError: "server error: 500 unavailable",
        lastAttemptAt: "2026-03-12T00:05:10.000Z",
        lastProgressAt: "2026-03-12T00:05:09.000Z",
        lastFailurePhase: "pull:comments",
        lastFailureCursor: "2026-03-12T00:05:00.000Z",
        pendingCommentIssueNumbers: [7],
      };
      fs.writeFileSync(storagePath, JSON.stringify([legacy]));
      const runtimeStore = createFileForgejoBindingRuntimeStore(storagePath);
      const migrated = runtimeStore.get(binding.id)!;
      expect(migrated).toMatchObject({
        checkpointVersion: 2,
        issuePullCursor: null,
        commentPullCursor: null,
        lastPushSuccessAt: null,
        legacyCheckpoint: { cursor: legacy.cursor, lastSuccessAt: legacy.lastSuccessAt },
        retryAttempt: legacy.retryAttempt,
        nextRetryAt: legacy.nextRetryAt,
        lastError: legacy.lastError,
        lastFailurePhase: legacy.lastFailurePhase,
        lastFailureCursor: legacy.lastFailureCursor,
        pendingCommentIssueNumbers: [7],
      });
      runtimeStore.save(migrated);
      expect(createFileForgejoBindingRuntimeStore(storagePath).get(binding.id)).toEqual(migrated);
      const fixture = await createFixture(runtimeStore);
      fixture.issueClient.seedIssues(target, [
        { ...issue, state: "closed", labels: ["status:done"] },
      ]);
      fixture.issueClient.seedComments(target, 7, [
        {
          id: 11,
          issueNumber: 7,
          body: "Before legacy push",
          createdAt: "2026-03-12T00:01:30.000Z",
        },
      ]);
      expect(await fixture.provider.pull(binding, project)).toEqual({
        tasks: [],
        checkpoint: null,
      });
      expect(fixture.issueSinceValues).toEqual([]);
      vi.setSystemTime(new Date(legacy.nextRetryAt));
      const result = await pullAndAcknowledge(fixture.provider);
      expect(result.tasks[0].status).toBe("done");
      expect(result.comments).toHaveLength(1);
      expect(fixture.issueSinceValues.at(-1)).toBeUndefined();
      expect(fixture.commentSinceValues.at(-1)).toBeUndefined();
      const saved = createFileForgejoBindingRuntimeStore(storagePath).get(binding.id)!;
      expect(saved.issuePullCursor).toBe("2026-03-12T00:05:59.000Z");
      expect(saved.commentPullCursor).toBe(saved.issuePullCursor);
      expect(saved.legacyCheckpoint).toEqual(migrated.legacyCheckpoint);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
