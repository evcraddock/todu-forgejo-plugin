import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createIntegrationBindingId,
  createProjectId,
  validateSyncProviderRegistration,
} from "@todu/core";

import { createInMemoryForgejoIssueClient } from "@/forgejo-client";
import { createInMemoryForgejoItemLinkStore } from "@/forgejo-links";
import { createForgejoSyncProvider, syncProvider } from "@/forgejo-provider";
import { createInMemoryForgejoBindingRuntimeStore } from "@/forgejo-runtime";

const binding = {
  id: createIntegrationBindingId("binding-ack"),
  provider: "forgejo",
  projectId: createProjectId("project-ack"),
  targetKind: "repository",
  targetRef: "acme/roadmap",
  strategy: "bidirectional" as const,
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
  labels: [],
  assignees: [],
  createdAt: binding.createdAt,
  updatedAt: "2026-03-12T00:01:00.000Z",
};
const comment = {
  id: 11,
  issueNumber: 7,
  body: "Unread comment",
  createdAt: "2026-03-12T00:01:30.000Z",
};

async function fixture(storageDir?: string) {
  const issueClient = createInMemoryForgejoIssueClient();
  issueClient.seedIssues(target, [issue]);
  issueClient.seedComments(target, 7, [comment]);
  const provider = createForgejoSyncProvider({ issueClient });
  const config = {
    settings: {
      baseUrl: target.baseUrl,
      token: "test-token",
      ...(storageDir ? { storageDir } : {}),
    },
  };
  await provider.initialize(config);
  return { provider, issueClient, config };
}

describe("acknowledged Forgejo pulls", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T00:02:00.750Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("registers the published acknowledgment-capable v4 contract, not latest v5", () => {
    expect(syncProvider.manifest.apiVersion).toBe(4);
    expect(validateSyncProviderRegistration(syncProvider).ok).toBe(true);
  });

  it("stages records and link snapshots; only acknowledgment commits the pull boundary", async () => {
    const { provider } = await fixture();
    const batch = await provider.pull(binding, project);
    expect(batch.tasks).toHaveLength(1);
    expect(batch.comments).toHaveLength(1);
    expect(batch.checkpoint).not.toBeNull();
    expect(provider.getState().itemLinks).toEqual([]);
    expect(provider.getState().commentLinks).toEqual([]);
    expect(provider.getState().runtimeStates[0]).toMatchObject({
      issuePullCursor: null,
      commentPullCursor: null,
      lastSuccessAt: null,
    });
    await provider.acknowledgePull(binding, batch.checkpoint, project);
    expect(provider.getState().runtimeStates[0]).toMatchObject({
      issuePullCursor: "2026-03-12T00:01:59.000Z",
      commentPullCursor: "2026-03-12T00:01:59.000Z",
      pendingPull: null,
      retryAttempt: 0,
    });
    expect(provider.getState().itemLinks).toHaveLength(1);
    expect(provider.getState().commentLinks).toHaveLength(1);
    await provider.acknowledgePull(binding, batch.checkpoint, project);
    expect(provider.getState().itemLinks).toHaveLength(1);
    expect(provider.getState().commentLinks).toHaveLength(1);
  });

  it("replays an immutable batch after host apply failure, despite newer remote changes", async () => {
    const { provider, issueClient } = await fixture();
    const batch = await provider.pull(binding, project);
    // The host never acknowledges its partially applied batch.
    batch.tasks[0].title = "Host mutated result";
    issueClient.seedIssues(target, [
      {
        ...issue,
        title: "Later remote title",
        state: "closed",
        updatedAt: "2026-03-12T00:03:00.000Z",
      },
    ]);
    const replay = await provider.pull(binding, project);
    expect(replay.tasks[0].title).toBe(issue.title);
    expect(replay.checkpoint).toEqual(batch.checkpoint);
    expect(replay.comments).toHaveLength(1);
    expect(provider.getState().runtimeStates[0].issuePullCursor).toBeNull();
    await provider.acknowledgePull(binding, replay.checkpoint, project);
    const next = await provider.pull(binding, project);
    expect(next.tasks[0].title).toBe("Later remote title");
    expect(next.tasks[0].status).toBe("done");
  });

  it("replays tasks and comments after restart before acknowledgment", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-ack-"));
    try {
      const { provider, issueClient, config } = await fixture(dir);
      const batch = await provider.pull(binding, project);
      await provider.shutdown();
      issueClient.seedIssues(target, []);
      issueClient.seedComments(target, 7, []);
      const restarted = createForgejoSyncProvider({ issueClient });
      await restarted.initialize(config);
      const replay = await restarted.pull(binding, project);
      expect(replay).toEqual(batch);
      expect(restarted.getState().runtimeStates[0].issuePullCursor).toBeNull();
      await restarted.acknowledgePull(binding, replay.checkpoint, project);
      await restarted.shutdown();
      await restarted.initialize(config);
      await restarted.acknowledgePull(binding, batch.checkpoint, project);
      expect(restarted.getState().runtimeStates[0].pendingPull).toBeNull();
      expect(restarted.getState().itemLinks).toHaveLength(1);
      expect(restarted.getState().commentLinks).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("checkpoints an empty fetched batch but leaves skipped/backoff pulls uncommitted", async () => {
    const { provider, issueClient } = await fixture();
    issueClient.seedIssues(target, []);
    const batch = await provider.pull(binding, project);
    expect(batch).toMatchObject({ tasks: [], comments: [] });
    expect(batch.checkpoint).not.toBeNull();
    expect(provider.getState().runtimeStates[0].issuePullCursor).toBeNull();
    await provider.acknowledgePull(binding, batch.checkpoint, project);
    const before = provider.getState().runtimeStates[0];
    const skipped = await provider.pull({ ...binding, strategy: "push" }, project);
    expect(skipped.checkpoint).toBeNull();
    await provider.acknowledgePull(binding, skipped.checkpoint, project);
    expect(provider.getState().runtimeStates[0]).toEqual(before);
  });

  it("rejects unknown, stale, cross-binding, and retargeted acknowledgments", async () => {
    const { provider } = await fixture();
    const batch = await provider.pull(binding, project);
    await expect(provider.acknowledgePull(binding, { id: "unknown" }, project)).rejects.toThrow(
      "checkpoint"
    );
    await expect(
      provider.acknowledgePull(
        { ...binding, id: createIntegrationBindingId("other") },
        batch.checkpoint,
        project
      )
    ).rejects.toThrow("checkpoint");
    await expect(
      provider.acknowledgePull({ ...binding, targetRef: "acme/other" }, batch.checkpoint, project)
    ).rejects.toThrow("checkpoint");
    expect(
      provider.getState().runtimeStates.find((state) => state.bindingId === binding.id)
        ?.issuePullCursor
    ).toBeNull();
    await provider.acknowledgePull(binding, batch.checkpoint, project);
    const next = await provider.pull(binding, project);
    await expect(provider.acknowledgePull(binding, batch.checkpoint, project)).rejects.toThrow(
      "checkpoint"
    );
    await provider.acknowledgePull(binding, next.checkpoint, project);
  });

  it("acknowledgment failure retains the batch, cursors, and diagnostics until retry succeeds", async () => {
    const runtimeStore = createInMemoryForgejoBindingRuntimeStore();
    const linkStore = createInMemoryForgejoItemLinkStore();
    const { issueClient, config } = await fixture();
    const provider = createForgejoSyncProvider({ issueClient, linkStore, runtimeStore });
    await provider.initialize(config);
    const batch = await provider.pull(binding, project);
    const save = linkStore.save;
    linkStore.save = () => {
      throw new Error("disk unavailable");
    };
    await expect(provider.acknowledgePull(binding, batch.checkpoint, project)).rejects.toThrow(
      "disk unavailable"
    );
    expect(runtimeStore.get(binding.id)).toMatchObject({
      issuePullCursor: null,
      commentPullCursor: null,
      lastFailurePhase: "pull:acknowledgment",
      retryAttempt: 1,
      lastError: "disk unavailable",
    });
    expect(runtimeStore.get(binding.id)?.pendingPull).not.toBeNull();
    const skipped = await provider.pull(binding, project);
    expect(skipped.checkpoint).toBeNull();
    await provider.acknowledgePull(binding, skipped.checkpoint, project);
    linkStore.save = save;
    vi.setSystemTime(new Date(runtimeStore.get(binding.id)!.nextRetryAt!));
    expect(await provider.pull(binding, project)).toEqual(batch);
    await provider.push(binding, [], project);
    expect(runtimeStore.get(binding.id)).toMatchObject({
      issuePullCursor: null,
      lastFailurePhase: "pull:acknowledgment",
      retryAttempt: 1,
    });
    await provider.acknowledgePull(binding, batch.checkpoint, project);
    expect(runtimeStore.get(binding.id)).toMatchObject({
      pendingPull: null,
      lastFailurePhase: null,
      retryAttempt: 0,
    });
  });

  it("retains repaired-read diagnostics and pending comments until the host acknowledges", async () => {
    const { provider, issueClient } = await fixture();
    const listComments = issueClient.listComments;
    issueClient.listComments = async () => {
      throw new Error("500 failed comment read");
    };
    await expect(provider.pull(binding, project)).rejects.toThrow("500");
    const failed = provider.getState().runtimeStates[0];
    vi.setSystemTime(new Date(failed.nextRetryAt!));
    issueClient.listComments = listComments;
    const repaired = await provider.pull(binding, project);
    expect(provider.getState().runtimeStates[0]).toMatchObject({
      issuePullCursor: null,
      commentPullCursor: null,
      pendingCommentIssueNumbers: [7],
      retryAttempt: failed.retryAttempt,
      lastError: failed.lastError,
    });
    await provider.push(binding, [], project);
    expect(provider.getState().runtimeStates[0]).toMatchObject({
      pendingCommentIssueNumbers: [7],
      lastFailurePhase: "pull:comments",
      lastError: failed.lastError,
    });
    await provider.acknowledgePull(binding, repaired.checkpoint, project);
    expect(provider.getState().runtimeStates[0]).toMatchObject({
      pendingCommentIssueNumbers: [],
      unresolvedPullFailure: null,
      lastFailurePhase: null,
      retryAttempt: 0,
    });
  });

  it("replays a newly discovered issue that closes after a comment-read failure", async () => {
    const { provider, issueClient } = await fixture();
    const listComments = issueClient.listComments;
    issueClient.listComments = async () => {
      throw new Error("500 failed comment read");
    };
    await expect(provider.pull(binding, project)).rejects.toThrow("500");
    issueClient.seedIssues(target, [{ ...issue, state: "closed", labels: ["status:done"] }]);
    issueClient.listComments = listComments;
    vi.setSystemTime(new Date(provider.getState().runtimeStates[0].nextRetryAt!));
    const retry = await provider.pull(binding, project);
    expect(retry.tasks).toHaveLength(1);
    expect(retry.tasks[0].status).toBe("done");
    expect(retry.comments).toHaveLength(1);
    await provider.acknowledgePull(binding, retry.checkpoint, project);
    expect(provider.getState().runtimeStates[0].pendingCommentIssueNumbers).toEqual([]);
    expect(provider.getState().itemLinks).toHaveLength(1);
  });

  it("coalesces overlapping pulls into one immutable checkpoint", async () => {
    const { provider, issueClient } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listComments = issueClient.listComments.bind(issueClient);
    const read = vi.spyOn(issueClient, "listComments").mockImplementation(async (...args) => {
      await gate;
      return listComments(...args);
    });
    const first = provider.pull(binding, project);
    const second = provider.pull(binding, project);
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(left.checkpoint).toEqual(right.checkpoint);
    left.tasks[0].title = "Mutated by first caller";
    expect(right.tasks[0].title).toBe(issue.title);
    await provider.acknowledgePull(binding, right.checkpoint, project);
    await provider.acknowledgePull(binding, left.checkpoint, project);
  });

  it("isolates durable batches when different bindings pull concurrently", async () => {
    const { provider, issueClient } = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const listComments = issueClient.listComments.bind(issueClient);
    issueClient.listComments = async (...args) => {
      if (args[0].repo === target.repo) {
        entered();
        await gate;
      }
      return listComments(...args);
    };
    const otherTarget = { ...target, repo: "other" };
    issueClient.seedIssues(otherTarget, [
      { ...issue, externalId: `${target.baseUrl}/acme/other#7`, title: "Other project issue" },
    ]);
    const otherBinding = {
      ...binding,
      id: createIntegrationBindingId("binding-other"),
      projectId: createProjectId("project-other"),
      targetRef: "acme/other",
    };
    const first = provider.pull(binding, project);
    await ready;
    const other = await provider.pull(otherBinding, { ...project, id: otherBinding.projectId });
    release();
    const original = await first;
    expect(original.tasks[0].title).toBe(issue.title);
    expect(original.comments).toHaveLength(1);
    expect(other.tasks[0].title).toBe("Other project issue");
    expect(other.comments).toEqual([]);
    expect(await provider.pull(binding, project)).toEqual(original);
    await provider.acknowledgePull(binding, original.checkpoint, project);
    expect(
      provider.getState().runtimeStates.find((state) => state.bindingId === otherBinding.id)
        ?.pendingPull
    ).not.toBeNull();
  });

  it.each(["comment-links.json", "runtime-state.json"])(
    "retains a replayable batch when acknowledgment cannot replace %s",
    async (filename) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-ack-write-"));
      try {
        const { provider, issueClient, config } = await fixture(dir);
        const batch = await provider.pull(binding, project);
        const rename = fs.renameSync;
        let failed = false;
        const replacement = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
          if (!failed && destination === path.join(dir, filename)) {
            failed = true;
            throw new Error("injected state replacement failure");
          }
          return rename(source, destination);
        });
        await expect(provider.acknowledgePull(binding, batch.checkpoint, project)).rejects.toThrow(
          "replacement failure"
        );
        replacement.mockRestore();
        expect(provider.getState().runtimeStates[0]).toMatchObject({
          issuePullCursor: null,
          commentPullCursor: null,
          lastFailurePhase: "pull:acknowledgment",
          retryAttempt: 1,
        });
        expect(fs.readdirSync(dir).some((file) => file.endsWith(".tmp"))).toBe(false);
        await provider.shutdown();
        const restarted = createForgejoSyncProvider({ issueClient });
        await restarted.initialize(config);
        vi.setSystemTime(new Date(restarted.getState().runtimeStates[0].nextRetryAt!));
        expect(await restarted.pull(binding, project)).toEqual(batch);
        await restarted.acknowledgePull(binding, batch.checkpoint, project);
        expect(restarted.getState().itemLinks).toHaveLength(1);
        expect(restarted.getState().commentLinks).toHaveLength(1);
        expect(restarted.getState().runtimeStates[0]).toMatchObject({
          pendingPull: null,
          issuePullCursor: "2026-03-12T00:01:59.000Z",
          lastFailurePhase: null,
        });
      } finally {
        vi.restoreAllMocks();
        fs.rmSync(dir, { recursive: true });
      }
    }
  );

  it("cannot commit issue-only progress when comments fail before a batch is returned", async () => {
    const { provider, issueClient } = await fixture();
    issueClient.listComments = async () => {
      throw new Error("500 comments unavailable");
    };
    await expect(provider.pull(binding, project)).rejects.toThrow("500");
    expect(provider.getState().runtimeStates[0]).toMatchObject({
      issuePullCursor: null,
      commentPullCursor: null,
      pendingPull: null,
      pendingCommentIssueNumbers: [7],
      lastFailurePhase: "pull:comments",
      lastFailureCursor: "2026-03-12T00:01:59.000Z",
    });
    expect(provider.getState().itemLinks).toEqual([]);
    expect(provider.getState().commentLinks).toEqual([]);
  });
});
