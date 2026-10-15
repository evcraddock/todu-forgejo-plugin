import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateSyncProviderRegistration,
  type IntegrationBinding,
  type Project,
  type Result,
  type SyncProviderV4,
  type SyncProviderV7,
} from "@todu/core";
import { createDaemonLogger, createSyncPluginWorkerRuntime } from "@todu/daemon";
import { createTodu, type ToduWithInternalTools } from "@todu/engine";
import { createInMemoryForgejoIssueClient } from "@/forgejo-client";
import { createForgejoSyncProvider, syncProvider } from "@/forgejo-provider";
import { createForgejoSyncProvider as createV4Provider } from "@/forgejo-legacy-provider";
import { createForgejoV4DrainProvider } from "@/forgejo-v4-drain";
import { createFileForgejoBindingRuntimeStore } from "@/forgejo-runtime";
import { createFileForgejoItemLinkStore } from "@/forgejo-links";
import { remoteForgejoGroups } from "@/forgejo-v7-fields";
import { createFileForgejoCommentLinkStore } from "@/forgejo-comment-links";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
const OLD = "2026-01-01T00:00:00.000Z";
const target = {
  baseUrl: "https://code.example.com",
  apiBaseUrl: "https://code.example.com/api/v1",
  owner: "acme",
  repo: "roadmap",
};
const issue = (number = 7) => ({
  number,
  externalId: `${target.baseUrl}/acme/roadmap#${number}`,
  sourceUrl: `${target.baseUrl}/acme/roadmap/issues/${number}`,
  title: "Base",
  body: "Body",
  state: "open" as const,
  labels: ["status:active", "priority:medium"],
  assignees: [],
  createdAt: OLD,
  updatedAt: OLD,
});

describe("Forgejo v7 against the published native host", () => {
  let directory: string;
  let todu: ToduWithInternalTools;
  let project: Project;
  let binding: IntegrationBinding;
  let client: ReturnType<typeof createInMemoryForgejoIssueClient>;
  let provider: ReturnType<typeof createForgejoSyncProvider>;
  const config = () => ({
    enabled: true,
    settings: {
      baseUrl: target.baseUrl,
      token: "isolated-test-token",
      storageDir: path.join(directory, "plugin"),
    },
    intervalMs: 60_000,
    retryInitialMs: 60_000,
    retryMaxMs: 60_000,
  });
  const runtimeStore = () =>
    createFileForgejoBindingRuntimeStore(path.join(directory, "plugin/runtime-state.json"));
  const links = () =>
    createFileForgejoItemLinkStore(path.join(directory, "plugin/item-links.json"));
  async function cycle(
    selected: SyncProviderV7 | SyncProviderV4 = provider,
    api = 7,
    error = false
  ) {
    const ack = vi.spyOn(selected, "acknowledgePull");
    const start = ack.mock.calls.length;
    const pushed = vi.spyOn(selected, "push");
    const pushStart = pushed.mock.calls.length;
    const handle = createSyncPluginWorkerRuntime({
      pluginName: "forgejo",
      pluginVersion: selected.version,
      modulePath: "/isolated-v7-fixture",
      authorityId: "isolated-v7-fixture",
      provider: selected,
      providerApiVersion: api,
      config: config(),
      getTodu: () => todu,
      logger: createDaemonLogger({ level: "error" }),
    }).start();
    try {
      await vi.waitFor(
        async () => {
          const status = value(await todu.integration.getStatus(binding.id));
          if (!error) {
            if (binding.strategy === "push")
              expect(pushed.mock.calls.length).toBeGreaterThan(pushStart);
            else expect(ack.mock.calls.length).toBeGreaterThan(start);
          }
          expect(status.state, status.lastErrorSummary ?? undefined).toBe(error ? "error" : "idle");
        },
        { timeout: 6000 }
      );
      return ack.mock.calls.slice(start);
    } finally {
      await handle.stop();
    }
  }
  async function linked(known = false, title = "Base") {
    const task = value(
      await todu.task.create({
        projectId: project.id,
        title,
        description: "Body",
        externalId: issue().externalId,
        sourceUrl: issue().sourceUrl,
        updatedAt: "2026-06-01T00:00:00.000Z",
      })
    );
    links().save({
      bindingId: binding.id,
      taskId: task.id,
      issueNumber: 7,
      externalId: issue().externalId,
      ...(known ? { fieldSnapshots: remoteForgejoGroups(issue(), binding) } : {}),
    });
    return task;
  }
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-v7-host-"));
    for (const key of Object.keys(process.env))
      if (key.startsWith("TODU_")) vi.stubEnv(key, undefined);
    for (const key of [
      "HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
    ])
      vi.stubEnv(key, directory);
    todu = (await createTodu({
      storagePath: path.join(directory, "host"),
    })) as ToduWithInternalTools;
    project = value(await todu.project.create({ name: "V7 isolated" }));
    binding = value(
      await todu.integration.create({
        provider: "forgejo",
        projectId: project.id,
        targetKind: "repository",
        targetRef: "acme/roadmap",
        strategy: "pull",
        enabled: true,
      })
    );
    client = createInMemoryForgejoIssueClient();
    client.seedIssues(target, [issue()]);
    provider = createForgejoSyncProvider({ issueClient: client });
    await provider.initialize(config());
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await todu?.close();
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("requires explicit v7 registration rather than a fallback to an older host", () => {
    expect(validateSyncProviderRegistration(syncProvider).ok).toBe(true);
    expect(
      validateSyncProviderRegistration(syncProvider, { supportedApiVersions: [3, 4, 5, 6] }).ok
    ).toBe(false);
  });
  it.each(["none", "disabled"] as const)("does no provider work for a %s binding", async (mode) => {
    const skipped =
      mode === "none" ? { ...binding, strategy: "none" as const } : { ...binding, enabled: false };
    const requests = vi.spyOn(client, "listIssues");
    expect(await provider.pull(skipped, project, undefined as never)).toEqual({
      tasks: [],
      taskUpdates: [],
      cancelledTaskExclusions: [],
      checkpoint: null,
    });
    expect(await provider.push(skipped, [], project)).toEqual({ taskLinks: [], commentLinks: [] });
    expect(requests).not.toHaveBeenCalled();
    expect(runtimeStore().get(binding.id)).toBeNull();
  });
  it("reports unreadable/unsupported recovery state instead of treating it as an empty queue", async () => {
    await linked();
    await cycle();
    const file = path.join(directory, "plugin/runtime-state.json");
    const damaged = JSON.parse(fs.readFileSync(file, "utf8"));
    damaged[0].fieldSync.version = 99;
    fs.writeFileSync(file, JSON.stringify(damaged));
    await provider.initialize(config());
    expect(await provider.recoveryState(binding, project)).toMatchObject({
      state: "unknown",
      reason: expect.stringContaining("field-sync"),
    });
  });
  it("rejects a changed binding scope without reading or overwriting another repository", async () => {
    await linked();
    await cycle();
    await provider.initialize(config());
    const requests = vi.spyOn(client, "listIssues");
    const changed = { ...binding, targetRef: "other/repository" };
    expect(await provider.recoveryState(changed, project)).toMatchObject({ state: "unknown" });
    await expect(provider.pull(changed, project, undefined as never)).rejects.toThrow(
      /scope changed/
    );
    expect(requests).not.toHaveBeenCalled();
  });
  it("initializes every equal unknown group in pull-only operation without rewriting the task", async () => {
    const task = await linked();
    const update = vi.spyOn(todu.task, "update");
    const calls = await cycle();
    expect(calls[0][3]).toMatchObject({
      bootstrapResults: [],
      taskResults: [
        {
          localTaskId: task.id,
          groups: {
            content: { baseline: "mirrored" },
            workflow: { baseline: "mirrored" },
            classification: { baseline: "mirrored" },
            assignment: { baseline: "mirrored" },
          },
        },
      ],
    });
    expect(links().getByTaskId(binding.id, task.id)?.fieldSnapshots).toEqual(
      remoteForgejoGroups(issue(), binding)
    );
    expect(value(await todu.task.get(task.id)).updatedAt).toBe(task.updatedAt);
    expect(update).not.toHaveBeenCalled();
    expect(runtimeStore().get(binding.id)?.fieldSync?.retryIssueNumbers).toEqual([]);
  });
  it("preserves unknown-history disagreements even during bidirectional push", async () => {
    binding = value(await todu.integration.update(binding.id, { strategy: "bidirectional" }));
    const task = await linked(false, "Local disagreement");
    const patch = vi.spyOn(client, "updateIssue");
    await cycle();
    expect(value(await todu.task.get(task.id)).title).toBe("Local disagreement");
    expect(client.snapshotIssues(target)[0].title).toBe("Base");
    expect(patch).not.toHaveBeenCalled();
    expect(links().getByTaskId(binding.id, task.id)?.fieldSnapshots?.content).toBeUndefined();
    expect(runtimeStore().get(binding.id)?.fieldSync?.retryIssueNumbers).toContain(7);
  });
  it("uses actual bootstrap IDs and defers approval-restricted content without fabricating a baseline", async () => {
    const calls = await cycle();
    const tasks = value(await todu.task.list({ projectId: project.id }));
    expect(tasks).toHaveLength(1);
    expect(calls[0][3]).toMatchObject({
      taskResults: [],
      bootstrapResults: [
        {
          localTaskId: tasks[0].id,
          groups: {
            content: { state: "deferred", reason: "pending-content-approval" },
            workflow: { baseline: "mirrored" },
          },
        },
      ],
    });
    expect(links().list(binding.id)[0].taskId).toBe(tasks[0].id);
    expect(links().list(binding.id)[0].fieldSnapshots?.content).toBeUndefined();
    value(await todu.approval.approveTaskDescription(tasks[0].id));
    provider = createForgejoSyncProvider({ issueClient: client });
    await cycle();
    expect(links().list(binding.id)[0].fieldSnapshots?.content).toEqual({
      title: "Base",
      description: "Body",
    });
    expect(value(await todu.task.list({ projectId: project.id }))).toHaveLength(1);
  });
  it("mirrors independent content/workflow winners through selective remote writes", async () => {
    binding = value(await todu.integration.update(binding.id, { strategy: "bidirectional" }));
    const task = await linked(true, "New local title");
    client.seedIssues(target, [
      {
        ...issue(),
        state: "closed",
        labels: ["status:done", "priority:medium"],
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
    ]);
    const patch = vi.spyOn(client, "updateIssue");
    await cycle();
    expect(value(await todu.task.get(task.id))).toMatchObject({
      title: "New local title",
      status: "done",
    });
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0][2]).toEqual({ title: "New local title", body: "Body" });
    expect(client.snapshotIssues(target)[0]).toMatchObject({
      title: "New local title",
      state: "closed",
      labels: ["status:done", "priority:medium"],
    });
    expect(links().list(binding.id)[0].fieldSnapshots?.content?.title).toBe("New local title");
    expect(runtimeStore().get(binding.id)?.fieldSync?.remoteWrites).toEqual({});
  });
  it("retains local-winning remote writes across pull-only acknowledgment and provider restart", async () => {
    const task = await linked(true, "Local winner");
    await cycle();
    const before = runtimeStore().get(binding.id)!;
    expect(before.fieldSync?.remoteWrites[issue().externalId].groups.content?.title).toBe(
      "Local winner"
    );
    expect(links().getByTaskId(binding.id, task.id)?.fieldSnapshots?.content?.title).toBe("Base");
    const restarted = createForgejoSyncProvider({ issueClient: client });
    await restarted.initialize(config());
    expect(restarted.getState().runtimeStates[0].fieldSync?.remoteWrites).toEqual(
      before.fieldSync?.remoteWrites
    );
    binding = value(await todu.integration.update(binding.id, { strategy: "push" }));
    const handle = createSyncPluginWorkerRuntime({
      pluginName: "forgejo",
      pluginVersion: restarted.version,
      modulePath: "/isolated",
      authorityId: "isolated",
      provider: restarted,
      providerApiVersion: 7,
      config: config(),
      getTodu: () => todu,
      logger: createDaemonLogger({ level: "error" }),
    }).start();
    try {
      await vi.waitFor(() => expect(client.snapshotIssues(target)[0].title).toBe("Local winner"), {
        timeout: 5000,
      });
    } finally {
      await handle.stop();
    }
    expect(runtimeStore().get(binding.id)?.issuePullCursor).toBe(before.issuePullCursor);
    expect(runtimeStore().get(binding.id)?.commentPullCursor).toBe(before.commentPullCursor);
    expect(runtimeStore().get(binding.id)?.fieldSync?.remoteWrites).toEqual({});
  });
  it("does not turn incomplete remote assignments into empty replacements", async () => {
    const task = await linked(true);
    client.seedIssues(target, [
      {
        ...issue(),
        state: "closed",
        labels: ["status:done"],
        assignees: [{ externalAccountId: "999", externalLogin: "unmapped" }],
      },
    ]);
    const calls = await cycle();
    expect(calls[0][3]).toMatchObject({
      taskResults: [
        {
          groups: {
            workflow: { baseline: "mirrored" },
            assignment: { state: "deferred", reason: "incomplete-assignment-mapping" },
          },
        },
      ],
    });
    expect(value(await todu.task.get(task.id)).status).toBe("done");
    expect(links().list(binding.id)[0].fieldSnapshots?.assignment).toEqual({ assignees: [] });
    expect(runtimeStore().get(binding.id)?.fieldSync?.retryIssueNumbers).toContain(7);
  });
  it("replays original pending work with fresh tokens after a host flush failure and restart", async () => {
    const task = await linked(true);
    client.seedIssues(target, [{ ...issue(), state: "closed", labels: ["status:done"] }]);
    vi.spyOn(todu.__internal.syncRuntime, "flush").mockRejectedValueOnce(
      new Error("injected flush failure")
    );
    const pulls = vi.spyOn(provider, "pull");
    await cycle(provider, 7, true);
    const pending = runtimeStore().get(binding.id)?.fieldSync?.pending;
    expect(pending).not.toBeNull();
    expect(runtimeStore().get(binding.id)?.issuePullCursor).toBeNull();
    const firstToken = (await pulls.mock.results[0].value).taskUpdates[0].observationToken;
    expect(JSON.stringify(pending)).not.toContain(firstToken);
    await todu.close();
    todu = (await createTodu({
      storagePath: path.join(directory, "host"),
    })) as ToduWithInternalTools;
    provider = createForgejoSyncProvider({ issueClient: client });
    const retried = vi.spyOn(provider, "pull");
    await cycle();
    const replay = await retried.mock.results[0].value;
    expect(replay.taskUpdates[0].observationToken).not.toBe(firstToken);
    expect(runtimeStore().get(binding.id)?.fieldSync?.pending).toBeNull();
    expect(value(await todu.task.list({ projectId: project.id })).map((row) => row.id)).toEqual([
      task.id,
    ]);
    expect(links().list(binding.id)[0].fieldSnapshots?.workflow).toEqual({ status: "done" });
  });
  it("blocks v7 on original v4 pending work, then drains only that boundary without remote discovery or push", async () => {
    binding = value(await todu.integration.update(binding.id, { strategy: "bidirectional" }));
    client.seedComments(target, 7, [{ id: 11, issueNumber: 7, body: "History", createdAt: OLD }]);
    const old = createV4Provider({ issueClient: client });
    await old.initialize(config());
    await old.pull(binding, project);
    const original = runtimeStore().get(binding.id)!.pendingPull;
    expect(await provider.recoveryState(binding, project)).toMatchObject({
      state: "legacy-pending",
    });
    client.seedIssues(target, []);
    const read = vi.spyOn(client, "listIssues");
    const push = vi.spyOn(client, "updateIssue");
    const drain = createForgejoV4DrainProvider({ issueClient: client });
    vi.spyOn(todu.__internal.syncRuntime, "flush").mockRejectedValueOnce(
      new Error("drain flush failure")
    );
    await cycle(drain, 4, true);
    expect(runtimeStore().get(binding.id)?.pendingPull).toEqual(original);
    const ids = value(await todu.task.list({ projectId: project.id })).map((row) => row.id);
    await cycle(createForgejoV4DrainProvider({ issueClient: client }), 4);
    expect(runtimeStore().get(binding.id)?.pendingPull).toBeNull();
    const boundary = runtimeStore().get(binding.id)?.issuePullCursor;
    await cycle(createForgejoV4DrainProvider({ issueClient: client }), 4);
    expect(runtimeStore().get(binding.id)?.issuePullCursor).toBe(boundary);
    expect(read).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(value(await todu.task.list({ projectId: project.id })).map((row) => row.id)).toEqual(
      ids
    );
    expect(value(await todu.note.list())).toHaveLength(1);
    await provider.initialize(config());
    expect(await provider.recoveryState(binding, project)).toEqual({ state: "ready" });
    // The frozen boundary survives restart: a later v4 batch is not silently admitted.
    const newBatch = structuredClone(original!);
    newBatch.checkpoint.id = "outside-original-drain";
    runtimeStore().save({ ...runtimeStore().get(binding.id)!, pendingPull: newBatch });
    await expect(
      createForgejoV4DrainProvider({ issueClient: client }).initialize(config())
    ).rejects.toThrow(/captured v4 drain boundary/);
  });
  it("rejects retargeted v4 drain work before applying any original rows", async () => {
    const old = createV4Provider({ issueClient: client });
    await old.initialize(config());
    await old.pull(binding, project);
    const drain = createForgejoV4DrainProvider({ issueClient: client });
    await drain.initialize(config());
    await expect(
      drain.pull({ ...binding, targetRef: "other/repository" }, project)
    ).rejects.toThrow(/scope changed/);
    expect(value(await todu.task.list({ projectId: project.id }))).toHaveLength(0);
    expect(runtimeStore().get(binding.id)?.pendingPull).not.toBeNull();
  });
  it("recovers partial remote endpoint success without advancing unverified group bases", async () => {
    binding = value(await todu.integration.update(binding.id, { strategy: "bidirectional" }));
    const task = await linked(true, "Local content");
    value(await todu.task.update(task.id, { status: "waiting" }));
    const patch = client.updateIssue.bind(client);
    const patched = vi
      .spyOn(client, "updateIssue")
      .mockImplementationOnce(async (repository, number, input) => {
        await patch(repository, number, {
          title: input.title,
          body: input.body,
          state: input.state,
        });
        throw new Error("labels endpoint failed after task fields were written");
      });
    await cycle(provider, 7, true);
    expect(client.snapshotIssues(target)[0]).toMatchObject({
      title: "Local content",
      labels: ["status:active", "priority:medium"],
    });
    expect(links().getByTaskId(binding.id, task.id)?.fieldSnapshots?.content?.title).toBe("Base");
    expect(links().getByTaskId(binding.id, task.id)?.fieldSnapshots?.workflow?.status).toBe(
      "active"
    );
    const failed = runtimeStore().get(binding.id)!;
    expect(failed.fieldSync?.remoteWrites[issue().externalId].groups.workflow?.status).toBe(
      "waiting"
    );
    runtimeStore().save({ ...failed, retryAttempt: 0, nextRetryAt: null });
    provider = createForgejoSyncProvider({ issueClient: client });
    await cycle();
    expect(patched.mock.calls[1][2]).toEqual({
      state: "open",
      labels: ["priority:medium", "status:waiting"],
    });
    expect(links().getByTaskId(binding.id, task.id)?.fieldSnapshots?.content?.title).toBe(
      "Local content"
    );
    expect(links().getByTaskId(binding.id, task.id)?.fieldSnapshots?.workflow?.status).toBe(
      "waiting"
    );
    expect(runtimeStore().get(binding.id)?.fieldSync?.remoteWrites).toEqual({});
  });
  it("rejects stale attempt acknowledgments while retaining the pending read boundary", async () => {
    await linked();
    const first = await cycle();
    provider = createForgejoSyncProvider({ issueClient: client });
    vi.spyOn(todu.__internal.syncRuntime, "flush").mockRejectedValueOnce(
      new Error("second attempt flush failure")
    );
    await cycle(provider, 7, true);
    const before = runtimeStore().get(binding.id)!;
    const stale = first[0];
    await provider.initialize(config());
    await expect(provider.acknowledgePull(stale[0], stale[1], stale[2], stale[3]!)).rejects.toThrow(
      /Stale.*attempt/
    );
    expect(runtimeStore().get(binding.id)?.issuePullCursor).toBe(before.issuePullCursor);
    expect(runtimeStore().get(binding.id)?.fieldSync?.pending).toEqual(before.fieldSync?.pending);
  });
  it("imports complete authorized assignments and classification without overwriting content", async () => {
    const task = await linked(true);
    const actor = value(
      await todu.actor.create({ id: "actor-alice" as never, displayName: "Alice" })
    );
    project = value(
      await todu.project.update(project.id, { authorizedAssigneeActorIds: [actor.id] })
    );
    binding = value(
      await todu.integration.update(binding.id, {
        options: {
          actorMappings: [{ actorId: actor.id, externalAccountId: "42", externalLogin: "alice" }],
        },
      })
    );
    client.seedIssues(target, [
      {
        ...issue(),
        labels: ["status:active", "priority:high", "new-label"],
        assignees: [{ externalAccountId: "42", externalLogin: "alice" }],
      },
    ]);
    await cycle();
    expect(value(await todu.task.get(task.id))).toMatchObject({
      title: "Base",
      description: "Body",
      priority: "high",
      labels: ["new-label"],
      assigneeActorIds: [actor.id],
    });
    expect(links().list(binding.id)[0].fieldSnapshots?.assignment).toEqual({
      assignees: [{ externalAccountId: "42" }],
    });
  });
  it("withholds acknowledgment when a same-clock edit occurs during the host flush", async () => {
    const task = await linked(true);
    client.seedIssues(target, [{ ...issue(), state: "closed", labels: ["status:done"] }]);
    const flush = todu.__internal.syncRuntime.flush.bind(todu.__internal.syncRuntime);
    vi.spyOn(todu.__internal.syncRuntime, "flush").mockImplementationOnce(async () => {
      value(
        await todu.task.update(task.id, {
          title: "Concurrent local edit",
          updatedAt: task.updatedAt,
        })
      );
      await flush();
    });
    const ack = vi.spyOn(provider, "acknowledgePull");
    await cycle(provider, 7, true);
    expect(ack).not.toHaveBeenCalled();
    expect(runtimeStore().get(binding.id)?.issuePullCursor).toBeNull();
    expect(value(await todu.task.get(task.id)).title).toBe("Concurrent local edit");
    expect(links().list(binding.id)[0].fieldSnapshots?.workflow).toEqual({ status: "active" });
  });
  it("rejects malformed host receipts without advancing links, snapshots, or checkpoints", async () => {
    await linked();
    const original = provider.acknowledgePull.bind(provider);
    vi.spyOn(provider, "acknowledgePull").mockImplementation(async (b, checkpoint, p, ack) => {
      const corrupt = structuredClone(ack);
      corrupt.taskResults[0].localTaskId = "task-wrong" as never;
      return original(b, checkpoint, p, corrupt);
    });
    await cycle(provider, 7, true);
    expect(runtimeStore().get(binding.id)?.issuePullCursor).toBeNull();
    expect(runtimeStore().get(binding.id)?.fieldSync?.pending).not.toBeNull();
    expect(links().list(binding.id)[0].fieldSnapshots).toBeUndefined();
  });
  it("keeps queued writes and the original batch when acknowledgment storage fails", async () => {
    await linked(true, "Local winner");
    const store = runtimeStore();
    const save = store.save.bind(store);
    vi.spyOn(store, "save").mockImplementation((state) => {
      if (state.fieldSync?.pending === null && state.issuePullCursor)
        throw new Error("injected final acknowledgment save failure");
      save(state);
    });
    provider = createForgejoSyncProvider({ issueClient: client, runtimeStore: store });
    await cycle(provider, 7, true);
    const failed = runtimeStore().get(binding.id)!;
    expect(failed.issuePullCursor).toBeNull();
    expect(failed.fieldSync?.pending).not.toBeNull();
    expect(failed.fieldSync?.remoteWrites[issue().externalId].groups.content?.title).toBe(
      "Local winner"
    );
    runtimeStore().save({ ...failed, retryAttempt: 0, nextRetryAt: null });
    provider = createForgejoSyncProvider({ issueClient: client });
    await cycle();
    expect(runtimeStore().get(binding.id)?.fieldSync?.pending).toBeNull();
    expect(
      runtimeStore().get(binding.id)?.fieldSync?.remoteWrites[issue().externalId].groups.content
        ?.title
    ).toBe("Local winner");
  });
  it("never loses a remote write when push fails after successful pull acknowledgment", async () => {
    binding = value(await todu.integration.update(binding.id, { strategy: "bidirectional" }));
    await linked(true, "Local winner");
    vi.spyOn(client, "updateIssue").mockRejectedValueOnce(new Error("injected remote failure"));
    const calls = await cycle(provider, 7, true);
    expect(calls).toHaveLength(1);
    const failed = runtimeStore().get(binding.id)!;
    expect(failed.issuePullCursor).not.toBeNull();
    expect(failed.fieldSync?.pending).toBeNull();
    expect(failed.fieldSync?.remoteWrites[issue().externalId].groups.content?.title).toBe(
      "Local winner"
    );
    expect(links().list(binding.id)[0].fieldSnapshots?.content?.title).toBe("Base");
    runtimeStore().save({ ...failed, retryAttempt: 0, nextRetryAt: null });
    provider = createForgejoSyncProvider({ issueClient: client });
    await cycle();
    expect(client.snapshotIssues(target)[0].title).toBe("Local winner");
    expect(runtimeStore().get(binding.id)?.fieldSync?.remoteWrites).toEqual({});
  });
  it("revalidates the remote issue before writing and preserves a concurrent remote edit", async () => {
    binding = value(await todu.integration.update(binding.id, { strategy: "bidirectional" }));
    await linked(true, "Local winner");
    const get = client.getIssue.bind(client);
    let calls = 0;
    vi.spyOn(client, "getIssue").mockImplementation(async (...args) => {
      if (++calls === 3)
        client.seedIssues(target, [
          { ...issue(), title: "Concurrent remote edit", updatedAt: "2026-12-01T00:00:00Z" },
        ]);
      return get(...args);
    });
    const patch = vi.spyOn(client, "updateIssue");
    await cycle(provider, 7, true);
    expect(client.snapshotIssues(target)[0].title).toBe("Concurrent remote edit");
    expect(patch).not.toHaveBeenCalled();
    expect(
      runtimeStore().get(binding.id)?.fieldSync?.remoteWrites[issue().externalId]
    ).toBeDefined();
  });
  it("creates and links a fresh outbound task without advancing pull progress", async () => {
    client.seedIssues(target, []);
    binding = value(await todu.integration.update(binding.id, { strategy: "push" }));
    const task = value(
      await todu.task.create({
        projectId: project.id,
        title: "Outbound",
        description: "Local body",
      })
    );
    const create = vi.spyOn(client, "createIssue");
    await cycle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(value(await todu.task.get(task.id)).externalId).toBe(
      client.snapshotIssues(target)[0].externalId
    );
    expect(links().getByTaskId(binding.id, task.id)?.fieldSnapshots?.content).toEqual({
      title: "Outbound",
      description: "Local body",
    });
    expect(runtimeStore().get(binding.id)?.issuePullCursor).toBeNull();
    provider = createForgejoSyncProvider({ issueClient: client });
    await cycle();
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("quarantines an ambiguous create response instead of creating a duplicate on restart", async () => {
    client.seedIssues(target, []);
    binding = value(await todu.integration.update(binding.id, { strategy: "push" }));
    const task = value(
      await todu.task.create({
        projectId: project.id,
        title: "Ambiguous create",
        description: "Body",
      })
    );
    const create = client.createIssue.bind(client);
    const calls = vi.spyOn(client, "createIssue").mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error("response lost after creation");
    });
    await cycle(provider, 7, true);
    expect(runtimeStore().get(binding.id)?.fieldSync?.creations?.[task.id]).toEqual({
      state: "uncertain",
    });
    const failed = runtimeStore().get(binding.id)!;
    runtimeStore().save({ ...failed, retryAttempt: 0, nextRetryAt: null });
    provider = createForgejoSyncProvider({ issueClient: client });
    await cycle(provider, 7, true);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(client.snapshotIssues(target)).toHaveLength(1);
  });
  it("keeps comments independent of deferred task content and retains real task IDs", async () => {
    binding = value(await todu.integration.update(binding.id, { strategy: "bidirectional" }));
    client.seedComments(target, 7, [
      { id: 11, issueNumber: 7, body: "Remote history", createdAt: OLD },
    ]);
    await cycle();
    const task = value(await todu.task.list({ projectId: project.id }))[0];
    expect(
      createFileForgejoCommentLinkStore(
        path.join(directory, "plugin/comment-links.json")
      ).listAll()[0].taskId
    ).toBe(task.id);
    const note = value(await todu.note.list())[0];
    value(await todu.note.update(note.id, { content: "New local comment" }));
    provider = createForgejoSyncProvider({ issueClient: client });
    await cycle();
    expect(client.snapshotComments(target, 7)).toHaveLength(1);
    expect(client.snapshotComments(target, 7)[0].body).toContain("New local comment");
    expect(links().getByTaskId(binding.id, task.id)?.fieldSnapshots?.content).toBeUndefined();
  });
  it("preserves local-deletion closure using a workflow-only patch on complete push exports", async () => {
    const task = await linked(true);
    binding = value(await todu.integration.update(binding.id, { strategy: "push" }));
    value(await todu.task.delete(task.id));
    const patch = vi.spyOn(client, "updateIssue");
    await cycle();
    expect(patch.mock.calls[0][2]).toEqual({
      state: "closed",
      labels: ["priority:medium", "status:canceled"],
    });
    expect(client.snapshotIssues(target)[0]).toMatchObject({
      title: "Base",
      body: "Body",
      state: "closed",
    });
    expect(links().list(binding.id)).toEqual([]);
  });
  it("keeps an unavailable canceled target as a no-op without replacement or link removal", async () => {
    const task = await linked(true);
    value(await todu.task.update(task.id, { status: "canceled" }));
    binding = value(await todu.integration.update(binding.id, { strategy: "push" }));
    client.seedIssues(target, []);
    const create = vi.spyOn(client, "createIssue");
    await cycle();
    expect(create).not.toHaveBeenCalled();
    expect(links().getByTaskId(binding.id, task.id)?.externalId).toBe(issue().externalId);
  });
  it("retains blocked missing-target status during backoff after restart without new requests", async () => {
    await linked(true);
    binding = value(await todu.integration.update(binding.id, { strategy: "push" }));
    client.seedIssues(target, []);
    const get = vi.spyOn(client, "getIssue");
    const pushed = vi.spyOn(provider, "push");
    await cycle(provider, 7, true);
    const exported = pushed.mock.calls[0][1];
    const calls = get.mock.calls.length;
    const restarted = createForgejoSyncProvider({ issueClient: client });
    await restarted.initialize(config());
    await expect(restarted.push(binding, exported, project)).rejects.toThrow(/unavailable/);
    expect(get).toHaveBeenCalledTimes(calls);
    expect(restarted.getState().bindingStatuses.get(binding.id)?.state).toBe("blocked");
  });
  it("does not disguise a reopened local task as authoritative remote cancellation", async () => {
    const task = await linked();
    links().save({
      ...links().getByTaskId(binding.id, task.id)!,
      fieldSnapshots: { workflow: { status: "canceled" } },
    });
    client.seedIssues(target, [{ ...issue(), state: "closed", labels: ["status:canceled"] }]);
    await cycle();
    expect(value(await todu.task.get(task.id)).status).toBe("active");
    expect(
      runtimeStore().get(binding.id)?.fieldSync?.remoteWrites[issue().externalId].groups.workflow
        ?.status
    ).toBe("active");
  });
  it("provides a guarded status-only cancellation path without a workflow baseline, including after reopening", async () => {
    const task = await linked();
    const note = value(
      await todu.note.create({ entityType: "task", entityId: task.id, content: "Local history" })
    );
    const before = value(await todu.task.get(task.id));
    const input = {
      bindingId: binding.id,
      localTaskId: task.id,
      externalId: issue().externalId,
      sourceUrl: issue().sourceUrl,
      intent: "cancel" as const,
      reason: "confirmed-remote-deletion" as const,
    };
    const tools = todu.__internal.syncRuntime.workflowIntent;
    const preview = value(await tools.prepare(input));
    expect(value(await tools.confirm({ token: preview.token, confirmed: true })).status).toBe(
      "canceled"
    );
    expect((await tools.confirm({ token: preview.token, confirmed: true })).ok).toBe(false);
    expect(value(await todu.task.get(task.id))).toMatchObject({
      title: before.title,
      description: before.description,
      labels: before.labels,
      priority: before.priority,
      externalId: before.externalId,
      status: "canceled",
    });
    value(await todu.task.update(task.id, { status: "active" }));
    const again = value(await tools.prepare(input));
    value(await tools.confirm({ token: again.token, confirmed: true }));
    expect(value(await todu.note.get(note.id)).content).toBe("Local history");
    expect(links().list(binding.id)[0].fieldSnapshots).toBeUndefined();
    expect(provider.getState().issueTombstones).toEqual([]);
  });
});
