import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createIntegrationBindingId } from "@todu/core";

import {
  computeNextForgejoRetryDelay,
  createFileForgejoBindingRuntimeStore,
  createInitialForgejoRuntimeState,
  createInMemoryForgejoBindingRuntimeStore,
  recordForgejoFailure,
  recordForgejoPullSuccess,
  recordForgejoPushSuccess,
  shouldForgejoRetry,
} from "@/forgejo-runtime";

describe("forgejo runtime", () => {
  it("computes bounded exponential retry delays", () => {
    expect(computeNextForgejoRetryDelay(0)).toBe(0);
    expect(computeNextForgejoRetryDelay(1, { initialSeconds: 5, maxSeconds: 300 })).toBe(5);
    expect(computeNextForgejoRetryDelay(2, { initialSeconds: 5, maxSeconds: 300 })).toBe(10);
    expect(computeNextForgejoRetryDelay(10, { initialSeconds: 5, maxSeconds: 30 })).toBe(30);
  });

  it("records failure and success transitions", () => {
    const bindingId = createIntegrationBindingId("binding-1");
    const initial = createInitialForgejoRuntimeState(bindingId);
    const failed = recordForgejoFailure(
      initial,
      "rate limited",
      { initialSeconds: 5, maxSeconds: 300 },
      new Date("2026-03-12T00:00:00.000Z")
    );

    expect(failed.retryAttempt).toBe(1);
    expect(failed.nextRetryAt).toBe("2026-03-12T00:00:05.000Z");
    expect(failed.lastError).toBe("rate limited");
    expect(failed.lastFailurePhase).toBeNull();
    expect(failed.pendingCommentIssueNumbers).toEqual([]);

    const succeeded = recordForgejoPullSuccess(
      failed,
      "2026-03-12T00:01:00.000Z",
      new Date("2026-03-12T00:01:00.000Z")
    );

    expect(succeeded.retryAttempt).toBe(0);
    expect(succeeded.nextRetryAt).toBeNull();
    expect(succeeded.lastError).toBeNull();
    expect(succeeded.issuePullCursor).toBe("2026-03-12T00:01:00.000Z");
    expect(succeeded.commentPullCursor).toBe(succeeded.issuePullCursor);
    expect(succeeded.lastPushSuccessAt).toBeNull();
    expect(succeeded.lastFailurePhase).toBeNull();
    expect(succeeded.pendingCommentIssueNumbers).toEqual([]);
  });

  it("records partial progress details on failure", () => {
    const bindingId = createIntegrationBindingId("binding-1");
    const initial = createInitialForgejoRuntimeState(bindingId);
    const failed = recordForgejoFailure(
      initial,
      "comment pull failed",
      { initialSeconds: 5, maxSeconds: 300 },
      new Date("2026-03-12T00:00:00.000Z"),
      {
        phase: "pull:comments",
        cursor: "2026-03-12T00:01:00.000Z",
        progressAt: "2026-03-12T00:01:00.000Z",
        pendingCommentIssueNumbers: [7, 7, 8],
      }
    );

    expect(failed.issuePullCursor).toBeNull();
    expect(failed.commentPullCursor).toBeNull();
    expect(failed.lastProgressAt).toBe("2026-03-12T00:01:00.000Z");
    expect(failed.lastFailurePhase).toBe("pull:comments");
    expect(failed.lastFailureCursor).toBe("2026-03-12T00:01:00.000Z");
    expect(failed.pendingCommentIssueNumbers).toEqual([7, 8]);
  });

  it("preserves the successful comment checkpoint and pending context across failures", () => {
    const initial = {
      ...createInitialForgejoRuntimeState(createIntegrationBindingId("binding-1")),
      issuePullCursor: "2026-03-12T00:00:00.000Z",
      commentPullCursor: "2026-03-12T00:00:00.000Z",
      lastSuccessAt: "2026-03-12T00:00:00.000Z",
    };
    const failed = recordForgejoFailure(
      initial,
      "comment pull failed",
      { initialSeconds: 5, maxSeconds: 300 },
      new Date("2026-03-12T00:02:03.000Z"),
      {
        phase: "pull:comments",
        cursor: "2026-03-12T00:01:59.000Z",
        progressAt: "2026-03-12T00:02:02.000Z",
        pendingCommentIssueNumbers: [7, 8],
      }
    );
    expect(failed.lastSuccessAt).toBe(initial.lastSuccessAt);
    expect(failed.commentPullCursor).toBe(initial.commentPullCursor);
    expect(failed.lastAttemptAt).toBe("2026-03-12T00:02:03.000Z");
    expect(failed.nextRetryAt).toBe("2026-03-12T00:02:08.000Z");

    const retryFailure = recordForgejoFailure(
      failed,
      "issue discovery failed",
      { initialSeconds: 5, maxSeconds: 300 },
      new Date("2026-03-12T00:02:08.000Z")
    );
    expect(retryFailure).toMatchObject({
      issuePullCursor: failed.issuePullCursor,
      commentPullCursor: initial.commentPullCursor,
      lastSuccessAt: initial.lastSuccessAt,
      lastProgressAt: failed.lastProgressAt,
      lastFailureCursor: failed.issuePullCursor,
      pendingCommentIssueNumbers: [7, 8],
      retryAttempt: 2,
      nextRetryAt: "2026-03-12T00:02:18.000Z",
    });
  });

  it("push success resets push retry state without changing pull checkpoints", () => {
    const pulled = recordForgejoPullSuccess(
      createInitialForgejoRuntimeState(createIntegrationBindingId("binding-1")),
      "2026-03-12T00:00:00.000Z"
    );
    const failed = recordForgejoFailure(pulled, "push failed", undefined, new Date(), {
      phase: "push:comments",
      cursor: "2026-03-12T01:00:00.000Z",
    });
    expect(failed.issuePullCursor).toBe(pulled.issuePullCursor);
    expect(failed.commentPullCursor).toBe(pulled.commentPullCursor);
    expect(failed.lastFailureCursor).toBeNull();
    const pushed = recordForgejoPushSuccess(failed, new Date("2026-03-12T02:00:00.000Z"));
    expect(pushed).toMatchObject({
      issuePullCursor: pulled.issuePullCursor,
      commentPullCursor: pulled.commentPullCursor,
      lastPushSuccessAt: "2026-03-12T02:00:00.000Z",
      retryAttempt: 0,
      nextRetryAt: null,
      lastError: null,
      lastFailurePhase: null,
    });
    const nextPull = recordForgejoPullSuccess(pushed, "2026-03-12T03:00:00.000Z");
    expect(nextPull.lastPushSuccessAt).toBe(pushed.lastPushSuccessAt);
  });

  it("push success cannot clear issue-discovery failure or advance read progress", () => {
    const failed = recordForgejoFailure(
      createInitialForgejoRuntimeState(createIntegrationBindingId("binding-1")),
      "issue discovery failed",
      undefined,
      new Date("2026-03-12T00:00:00.000Z"),
      { phase: "pull:issues" }
    );
    const pushed = recordForgejoPushSuccess(failed, new Date("2026-03-12T00:01:00.000Z"));
    expect(pushed).toEqual({
      ...failed,
      lastPushSuccessAt: "2026-03-12T00:01:00.000Z",
      lastSuccessAt: "2026-03-12T00:01:00.000Z",
      lastAttemptAt: "2026-03-12T00:01:00.000Z",
    });
  });

  it.each(["pull:issues", "pull:comments"] as const)(
    "keeps %s diagnostics through intervening push failures and success",
    (phase) => {
      const failedPull = recordForgejoFailure(
        createInitialForgejoRuntimeState(createIntegrationBindingId("binding-1")),
        "403 forbidden reads",
        undefined,
        new Date("2026-03-12T00:00:00.000Z"),
        { phase, cursor: "2026-03-12T00:00:00.000Z", progressAt: "2026-03-12T00:00:01.000Z" }
      );
      const failedPush = recordForgejoFailure(failedPull, "500 labels", undefined, new Date(), {
        phase: "push:issues",
      });
      expect(failedPush.lastError).toBe("500 labels");
      expect(failedPush.lastFailurePhase).toBe("push:issues");
      const pushed = recordForgejoPushSuccess(failedPush);
      expect(pushed).toMatchObject({
        lastError: failedPull.lastError,
        lastFailurePhase: phase,
        lastFailureCursor: failedPull.lastFailureCursor,
        lastProgressAt: failedPull.lastProgressAt,
        retryAttempt: failedPush.retryAttempt,
        nextRetryAt: failedPush.nextRetryAt,
      });
      expect(
        recordForgejoPullSuccess(pushed, "2026-03-12T00:02:00.000Z").unresolvedPullFailure
      ).toBeNull();
    }
  );

  it("checks retry eligibility against nextRetryAt", () => {
    const bindingId = createIntegrationBindingId("binding-1");
    const state = {
      ...createInitialForgejoRuntimeState(bindingId),
      retryAttempt: 1,
      nextRetryAt: "2026-03-12T00:10:00.000Z",
    };

    expect(shouldForgejoRetry(state, new Date("2026-03-12T00:09:59.000Z"))).toBe(false);
    expect(shouldForgejoRetry(state, new Date("2026-03-12T00:10:00.000Z"))).toBe(true);
  });

  it("stores runtime state in memory per binding", () => {
    const store = createInMemoryForgejoBindingRuntimeStore();
    const bindingId = createIntegrationBindingId("binding-1");
    const state = createInitialForgejoRuntimeState(bindingId);

    store.save(state);

    expect(store.get(bindingId)).toEqual(state);
    expect(store.listAll()).toEqual([state]);

    store.remove(bindingId);
    expect(store.get(bindingId)).toBeNull();
  });
});

describe("forgejo runtime checkpoint migration", () => {
  let dir: string;
  let storagePath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-runtime-"));
    storagePath = path.join(dir, "runtime-state.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true }));

  it("fills old diagnostic defaults without promoting legacy cursor or success to read progress", () => {
    const legacy = {
      bindingId: createIntegrationBindingId("legacy"),
      cursor: "2026-03-12T00:05:00.000Z",
      lastSuccessAt: "2026-03-12T00:06:00.000Z",
      retryAttempt: 3,
      nextRetryAt: "2026-03-12T00:07:00.000Z",
      lastError: "network timeout",
      lastAttemptAt: "2026-03-12T00:06:10.000Z",
    };
    const raw = JSON.stringify([legacy]);
    fs.writeFileSync(storagePath, raw);
    const store = createFileForgejoBindingRuntimeStore(storagePath);
    expect(store.get(legacy.bindingId)).toEqual({
      ...createInitialForgejoRuntimeState(legacy.bindingId),
      lastSuccessAt: legacy.lastSuccessAt,
      lastAttemptAt: legacy.lastAttemptAt,
      retryAttempt: legacy.retryAttempt,
      nextRetryAt: legacy.nextRetryAt,
      lastError: legacy.lastError,
      legacyCheckpoint: { cursor: legacy.cursor, lastSuccessAt: legacy.lastSuccessAt },
      unresolvedPullFailure: {
        lastError: legacy.lastError,
        lastFailurePhase: null,
        lastFailureCursor: null,
        lastProgressAt: null,
      },
    });
    expect(fs.readFileSync(storagePath, "utf8")).toBe(raw);
  });

  it("preserves acknowledged split checkpoints and archives when another legacy binding is saved", () => {
    const current = {
      ...createInitialForgejoRuntimeState(createIntegrationBindingId("current")),
      issuePullCursor: "2026-03-12T00:05:00.000Z",
      commentPullCursor: "2026-03-12T00:04:00.000Z",
      lastPushSuccessAt: "2026-03-12T00:06:00.000Z",
      legacyCheckpoint: { cursor: "2026-03-12T00:02:00.000Z", lastSuccessAt: null },
      pendingCommentIssueNumbers: [7],
      retryAttempt: 2,
      nextRetryAt: "2026-03-12T00:07:00.000Z",
      lastFailurePhase: "pull:comments" as const,
      lastFailureCursor: "2026-03-12T00:05:00.000Z",
      unresolvedPullFailure: {
        lastError: null,
        lastFailurePhase: "pull:comments" as const,
        lastFailureCursor: "2026-03-12T00:05:00.000Z",
        lastProgressAt: null,
      },
    };
    const legacy = {
      bindingId: createIntegrationBindingId("legacy"),
      cursor: null,
      lastSuccessAt: "2026-03-12T00:06:00.000Z",
    };
    fs.writeFileSync(storagePath, JSON.stringify([current, legacy]));
    const store = createFileForgejoBindingRuntimeStore(storagePath);
    const migrated = store.get(legacy.bindingId)!;
    expect(migrated.legacyCheckpoint).toEqual({
      cursor: null,
      lastSuccessAt: legacy.lastSuccessAt,
    });
    store.save(migrated);
    const reopened = createFileForgejoBindingRuntimeStore(storagePath);
    expect(reopened.get(current.bindingId)).toEqual(current);
    expect(reopened.get(legacy.bindingId)).toEqual(migrated);
    expect(reopened.get(legacy.bindingId)?.issuePullCursor).toBeNull();
    expect(reopened.get(legacy.bindingId)?.commentPullCursor).toBeNull();
  });

  it("conservatively retains phase-less legacy errors through push success and restart", () => {
    const bindingId = createIntegrationBindingId("legacy-read-error");
    const legacy = {
      bindingId,
      cursor: "2026-03-12T00:01:00.000Z",
      lastSuccessAt: "2026-03-12T00:01:00.000Z",
      retryAttempt: 2,
      nextRetryAt: "2026-03-12T00:03:00.000Z",
      lastError: "permission denied: 403 issue discovery",
      lastFailurePhase: null,
      lastFailureCursor: "2026-03-12T00:01:00.000Z",
    };
    fs.writeFileSync(storagePath, JSON.stringify([legacy]));
    const store = createFileForgejoBindingRuntimeStore(storagePath);
    const migrated = store.get(bindingId)!;
    const failedPush = recordForgejoFailure(migrated, "500 labels", undefined, new Date(), {
      phase: "push:issues",
    });
    store.save(failedPush);
    const reopened = createFileForgejoBindingRuntimeStore(storagePath);
    const pushed = recordForgejoPushSuccess(reopened.get(bindingId)!);
    expect(pushed).toMatchObject({
      lastError: legacy.lastError,
      lastFailurePhase: null,
      lastFailureCursor: legacy.lastFailureCursor,
      retryAttempt: failedPush.retryAttempt,
      nextRetryAt: failedPush.nextRetryAt,
      issuePullCursor: null,
      commentPullCursor: null,
    });
    reopened.save(pushed);
    expect(createFileForgejoBindingRuntimeStore(storagePath).get(bindingId)).toEqual(pushed);
    expect(
      recordForgejoPullSuccess(pushed, "2026-03-12T00:05:00.000Z").unresolvedPullFailure
    ).toBeNull();
  });

  it("archives v1 pre-application read checkpoints while preserving push success and backoff", () => {
    const v1 = {
      ...createInitialForgejoRuntimeState(createIntegrationBindingId("pre-ack")),
      checkpointVersion: 1,
      issuePullCursor: "2026-03-12T00:05:00.000Z",
      commentPullCursor: "2026-03-12T00:04:00.000Z",
      lastPushSuccessAt: "2026-03-12T00:06:00.000Z",
      lastSuccessAt: "2026-03-12T00:06:00.000Z",
      retryAttempt: 2,
      nextRetryAt: "2026-03-12T00:07:00.000Z",
      lastError: "500 comment read failed",
      lastFailurePhase: "pull:comments",
      pendingCommentIssueNumbers: [7],
    };
    fs.writeFileSync(storagePath, JSON.stringify([v1]));
    const store = createFileForgejoBindingRuntimeStore(storagePath);
    const migrated = store.get(v1.bindingId)!;
    expect(migrated).toMatchObject({
      checkpointVersion: 2,
      issuePullCursor: null,
      commentPullCursor: null,
      pendingPull: null,
      lastAcknowledgedPull: null,
      preAcknowledgmentCheckpoint: {
        issuePullCursor: v1.issuePullCursor,
        commentPullCursor: v1.commentPullCursor,
      },
      lastPushSuccessAt: v1.lastPushSuccessAt,
      lastSuccessAt: v1.lastSuccessAt,
      retryAttempt: v1.retryAttempt,
      nextRetryAt: v1.nextRetryAt,
      lastError: v1.lastError,
      pendingCommentIssueNumbers: [7],
    });
    store.save(migrated);
    expect(createFileForgejoBindingRuntimeStore(storagePath).get(v1.bindingId)).toEqual(migrated);
  });

  it("rejects malformed durable acknowledgment data without changing the file", () => {
    const state = createInitialForgejoRuntimeState(createIntegrationBindingId("invalid-ack"));
    for (const invalid of [
      { pendingPull: {} },
      { lastAcknowledgedPull: "not-a-checkpoint" },
      {
        pendingPull: {
          checkpoint: { id: "batch", scope: "scope" },
          issueCursor: "invalid",
          commentCursor: "2026-03-12T00:00:00Z",
          result: { tasks: [], comments: [] },
          itemUpserts: [],
          itemRemovals: [],
          commentUpserts: [],
          commentRemovals: [],
        },
      },
    ]) {
      const raw = JSON.stringify([{ ...state, ...invalid }]);
      fs.writeFileSync(storagePath, raw);
      expect(() => createFileForgejoBindingRuntimeStore(storagePath).listAll()).toThrow(
        "Invalid Forgejo runtime store"
      );
      expect(fs.readFileSync(storagePath, "utf8")).toBe(raw);
    }
  });

  it("allows a successful push to clear a known legacy push-only failure", () => {
    const bindingId = createIntegrationBindingId("legacy-push-error");
    fs.writeFileSync(
      storagePath,
      JSON.stringify([
        {
          bindingId,
          lastError: "500 label read failed",
          lastFailurePhase: "push:issues",
          retryAttempt: 1,
        },
      ])
    );
    const migrated = createFileForgejoBindingRuntimeStore(storagePath).get(bindingId)!;
    expect(migrated.unresolvedPullFailure).toBeNull();
    expect(recordForgejoPushSuccess(migrated)).toMatchObject({
      lastError: null,
      lastFailurePhase: null,
      retryAttempt: 0,
      unresolvedPullFailure: null,
      issuePullCursor: null,
      commentPullCursor: null,
    });
  });

  it("preserves explicit null checkpoints after push-only success and restart", () => {
    const initial = createInitialForgejoRuntimeState(createIntegrationBindingId("push-only"));
    const pushed = recordForgejoPushSuccess(initial, new Date("2026-03-12T00:06:00.000Z"));
    const store = createFileForgejoBindingRuntimeStore(storagePath);
    store.save(pushed);
    expect(createFileForgejoBindingRuntimeStore(storagePath).get(initial.bindingId)).toEqual(
      pushed
    );
  });

  it.each([
    { checkpointVersion: 3 },
    {
      checkpointVersion: 1,
      issuePullCursor: "invalid timestamp",
      commentPullCursor: null,
      lastPushSuccessAt: null,
    },
    { checkpointVersion: 1, issuePullCursor: null, commentPullCursor: null },
    {
      checkpointVersion: 1,
      issuePullCursor: null,
      commentPullCursor: null,
      lastPushSuccessAt: null,
      unresolvedPullFailure: {
        lastFailurePhase: "push:issues",
        lastError: "push error",
        lastFailureCursor: null,
        lastProgressAt: null,
      },
    },
  ])(
    "rejects unsupported or malformed split state rather than silently resetting it: %j",
    (invalid) => {
      const raw = JSON.stringify([{ bindingId: "invalid", ...invalid }]);
      fs.writeFileSync(storagePath, raw);
      expect(() => createFileForgejoBindingRuntimeStore(storagePath).listAll()).toThrow(
        "Invalid Forgejo runtime store"
      );
      expect(fs.readFileSync(storagePath, "utf8")).toBe(raw);
    }
  );
});
