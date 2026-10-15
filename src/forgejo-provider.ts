import { randomUUID } from "node:crypto";
import {
  SYNC_PROVIDER_API_VERSION_V7,
  SYNC_TASK_FIELD_GROUPS,
  type ExportedTaskInputV7,
  type IntegrationBinding,
  type Project,
  type SyncProviderPullContextV7,
  type SyncProviderPullResultV7,
  type SyncProviderRegistrationV7,
  type SyncProviderV7,
  type SyncTaskFieldGroupUpdateV7,
} from "@todu/core";
import { bootstrapForgejoIssuesToTasks } from "@/forgejo-bootstrap";
import { pullComments, pushComments } from "@/forgejo-comments";
import { createLinkFromTask, updateForgejoItemFieldSnapshots } from "@/forgejo-links";
import {
  createImportedTaskId,
  formatForgejoIssueExternalId,
  parseForgejoIssueExternalId,
} from "@/forgejo-ids";
import { createForgejoIssueCreateFromTask, mapForgejoIssueToImportedTask } from "@/forgejo-fields";
import {
  createForgejoBindingStatus,
  updateForgejoBindingStatusRunning,
  updateForgejoBindingStatusIdle,
  updateForgejoBindingStatusError,
  updateForgejoBindingStatusBlocked,
} from "@/forgejo-binding-status";
import { parseForgejoBinding } from "@/forgejo-binding";
import {
  commitForgejoPullLinks,
  createForgejoPullCheckpoint,
  stageForgejoPullLinks,
} from "@/forgejo-pull-checkpoint";
import {
  createInitialForgejoRuntimeState,
  recordForgejoFailure,
  recordForgejoBlocked,
  recordForgejoPullSuccess,
  recordForgejoPushSuccess,
  shouldForgejoRetry,
  type ForgejoRuntimeFailurePhase,
} from "@/forgejo-runtime";
import {
  createInitialForgejoFieldSync,
  isForgejoV7Checkpoint,
  validateForgejoFieldSync,
  type ForgejoFieldSyncState,
  type ForgejoV7Payload,
  type ForgejoV7Pending,
} from "@/forgejo-v7-ledger";
import {
  exportedForgejoGroups,
  forgejoAssignmentLogins,
  forgejoGroupedPatch,
  remoteForgejoGroups,
  selectForgejoPushGroups,
} from "@/forgejo-v7-fields";
import { equalForgejoFieldSnapshot } from "@/forgejo-field-snapshots";
import { validateForgejoV7Receipts } from "@/forgejo-v7-receipts";
import { ForgejoIdentityError } from "@/forgejo-identity";
import { getForgejoHttpStatus } from "@/forgejo-http-error";
import {
  checkpointScope,
  classifyForgejoSyncError,
  createForgejoRepositoryTarget,
  createForgejoSyncProvider as createV4Provider,
  FORGEJO_PROVIDER_VERSION,
  getImportClosedOnBootstrap,
  type CreateForgejoSyncProviderOptions,
  type ForgejoProviderState,
} from "@/forgejo-legacy-provider";

export {
  classifyForgejoSyncError,
  createForgejoRepositoryTarget,
  FORGEJO_PROVIDER_VERSION,
  getImportClosedOnBootstrap,
} from "@/forgejo-legacy-provider";
export type {
  CreateForgejoSyncProviderOptions,
  ForgejoProviderState,
  ForgejoSyncErrorClassification,
} from "@/forgejo-legacy-provider";
export interface ForgejoSyncProvider extends SyncProviderV7 {
  getState(): ForgejoProviderState;
}
class ForgejoPhaseError extends Error {
  constructor(
    readonly phase: ForgejoRuntimeFailurePhase,
    cause: unknown,
    readonly cursor?: string
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export function createForgejoSyncProvider(
  options: CreateForgejoSyncProviderOptions = {}
): ForgejoSyncProvider {
  // Reuse lifecycle/config/store wiring, never legacy pull/push application semantics.
  const lifecycle = createV4Provider(options);
  const statuses = new Map<
    IntegrationBinding["id"],
    ReturnType<typeof createForgejoBindingStatus>
  >();
  const busy = new Set<IntegrationBinding["id"]>();
  const resources = () => lifecycle.resources();
  const state = (binding: IntegrationBinding) =>
    resources().runtimeStore.get(binding.id) ?? createInitialForgejoRuntimeState(binding.id);
  const target = (binding: IntegrationBinding) =>
    createForgejoRepositoryTarget(parseForgejoBinding(binding), resources().settings);
  const scope = (binding: IntegrationBinding, project: Project) =>
    checkpointScope(binding, target(binding), project.id);
  const fields = (binding: IntegrationBinding, project: Project): ForgejoFieldSyncState => {
    const ledger = state(binding).fieldSync ?? createInitialForgejoFieldSync();
    validateForgejoFieldSync(ledger, binding.id);
    if (ledger.scope !== undefined && ledger.scope !== scope(binding, project))
      throw new ForgejoIdentityError(
        "field-sync ledger scope changed; preserve state and perform an explicit identity migration"
      );
    return ledger;
  };
  const save = (binding: IntegrationBinding, project: Project, ledger: ForgejoFieldSyncState) => {
    const saved = { ...ledger, scope: scope(binding, project) };
    validateForgejoFieldSync(saved, binding.id);
    resources().runtimeStore.save({ ...state(binding), fieldSync: saved });
  };
  const ready = (binding: IntegrationBinding, project: Project) => {
    if (state(binding).pendingPull)
      throw new Error("Forgejo v7 requires a bounded original-v4 drain; pending work retained");
    fields(binding, project);
  };
  const run = async <T>(
    binding: IntegrationBinding,
    phase: ForgejoRuntimeFailurePhase,
    action: () => Promise<T>
  ): Promise<T> => {
    if (busy.has(binding.id))
      throw new Error("Overlapping Forgejo operations cannot share invocation-local observations");
    busy.add(binding.id);
    statuses.set(
      binding.id,
      updateForgejoBindingStatusRunning(
        statuses.get(binding.id) ?? createForgejoBindingStatus(binding.id)
      )
    );
    try {
      return await action();
    } catch (error) {
      const classified = classifyForgejoSyncError(error);
      const current = state(binding);
      resources().runtimeStore.save(
        (classified.retryable ? recordForgejoFailure : recordForgejoBlocked)(
          current,
          classified.summary,
          classified.retryable ? options.retryConfig : undefined,
          new Date(),
          {
            phase: error instanceof ForgejoPhaseError ? error.phase : phase,
            ...(error instanceof ForgejoPhaseError && error.cursor
              ? { cursor: error.cursor, progressAt: new Date().toISOString() }
              : {}),
          }
        )
      );
      const status = statuses.get(binding.id)!;
      statuses.set(
        binding.id,
        classified.retryable
          ? updateForgejoBindingStatusError(status, classified.summary)
          : updateForgejoBindingStatusBlocked(status, classified.summary)
      );
      throw error;
    } finally {
      busy.delete(binding.id);
    }
  };
  const idle = (binding: IntegrationBinding) =>
    statuses.set(
      binding.id,
      updateForgejoBindingStatusIdle(
        statuses.get(binding.id) ?? createForgejoBindingStatus(binding.id)
      )
    );
  const assertIssue = (binding: IntegrationBinding, externalId: string, issueNumber: number) => {
    const repository = target(binding);
    if (externalId !== formatForgejoIssueExternalId({ ...repository, issueNumber }))
      throw new ForgejoIdentityError("remote issue identity does not match binding");
  };
  const retryAllowed = (binding: IntegrationBinding): boolean => {
    const current = state(binding);
    if (shouldForgejoRetry(current)) return true;
    if (current.lastError) {
      const status = statuses.get(binding.id) ?? createForgejoBindingStatus(binding.id);
      const classified = classifyForgejoSyncError(current.lastError);
      statuses.set(
        binding.id,
        classified.retryable
          ? updateForgejoBindingStatusError(status, current.lastError)
          : updateForgejoBindingStatusBlocked(status, current.lastError)
      );
      // A blocked backoff skip is not a successful host cycle, including after restart.
      if (!classified.retryable) throw new Error(current.lastError);
    }
    return false;
  };
  const empty = (): SyncProviderPullResultV7 => ({
    tasks: [],
    taskUpdates: [],
    cancelledTaskExclusions: [],
    checkpoint: null,
  });

  async function discover(
    binding: IntegrationBinding,
    project: Project
  ): Promise<ForgejoV7Pending> {
    const { issueClient, linkStore, commentLinkStore } = resources();
    const repository = target(binding);
    const current = state(binding);
    const staged = stageForgejoPullLinks(binding.id, linkStore, commentLinkStore);
    const cursor = new Date(Math.floor(Date.now() / 1000) * 1000 - 1000).toISOString();
    const imported = await bootstrapForgejoIssuesToTasks({
      binding,
      ...repository,
      issueClient,
      linkStore: staged.itemStore,
      since: current.issuePullCursor ?? undefined,
      importClosedOnBootstrap: getImportClosedOnBootstrap(binding),
      previouslyDiscoveredIssueNumbers: current.pendingCommentIssueNumbers,
    });
    const retry = new Set([
      ...fields(binding, project).retryIssueNumbers,
      ...linkStore
        .list(binding.id)
        .filter((link) =>
          SYNC_TASK_FIELD_GROUPS.some((group) => link.fieldSnapshots?.[group] === undefined)
        )
        .map((link) => link.issueNumber),
    ]);
    for (const number of retry) {
      if (imported.touchedIssueNumbers.includes(number)) continue;
      const issue = await issueClient.getIssue(repository, number);
      if (!issue)
        throw new ForgejoIdentityError(
          `linked issue #${number} is unavailable; retain identity and unresolved work`
        );
      assertIssue(binding, issue.externalId, number);
      imported.tasks.push(mapForgejoIssueToImportedTask(issue));
    }
    const numbers = [
      ...new Set([
        ...current.pendingCommentIssueNumbers,
        ...imported.touchedIssueNumbers,
        ...staged.itemStore.list(binding.id).map((link) => link.issueNumber),
      ]),
    ];
    let comments;
    try {
      comments = await pullComments({
        binding,
        issueClient,
        target: repository,
        itemLinkStore: staged.itemStore,
        commentLinkStore: staged.commentStore,
        issueNumbers: numbers,
        since: current.commentPullCursor ?? undefined,
        onIssueError: ({ itemLink, error }) => {
          throw new ForgejoIdentityError(
            `comments for linked issue #${itemLink.issueNumber} are unavailable; links retained`,
            { cause: error }
          );
        },
      });
    } catch (error) {
      resources().runtimeStore.save({ ...state(binding), pendingCommentIssueNumbers: numbers });
      throw new ForgejoPhaseError("pull:comments", error, cursor);
    }
    return {
      original: {
        checkpoint: createForgejoPullCheckpoint(scope(binding, project)),
        issueCursor: cursor,
        commentCursor: cursor,
        result: { tasks: imported.tasks, comments: comments.comments },
        ...staged.changes(),
      },
      attempt: null,
    };
  }

  async function attempt(
    binding: IntegrationBinding,
    project: Project,
    context: SyncProviderPullContextV7,
    pending: ForgejoV7Pending
  ): Promise<SyncProviderPullResultV7> {
    if (pending.original.checkpoint.scope !== scope(binding, project))
      throw new ForgejoIdentityError("pending v7 checkpoint scope mismatch");
    const { issueClient, linkStore } = resources();
    const repository = target(binding);
    const payload: ForgejoV7Payload = {
      tasks: [],
      taskUpdates: [],
      comments: structuredClone(pending.original.result.comments ?? []),
    };
    const updates: SyncTaskFieldGroupUpdateV7[] = [];
    for (const candidate of pending.original.result.tasks) {
      const parsed = parseForgejoIssueExternalId(candidate.externalId);
      assertIssue(binding, candidate.externalId, parsed.issueNumber);
      // The token precedes the authoritative remote read, including on replay.
      const local = await context.observeTaskGroups({
        externalId: candidate.externalId,
        ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}),
      });
      const issue = await issueClient.getIssue(repository, parsed.issueNumber);
      if (!issue)
        throw new ForgejoIdentityError(
          `issue #${parsed.issueNumber} unavailable during fresh observation; pending work retained`
        );
      assertIssue(binding, issue.externalId, parsed.issueNumber);
      if (issue.isPullRequest) throw new ForgejoIdentityError("issue became a pull request");
      const remote = remoteForgejoGroups(issue, binding);
      if (local.state === "found") {
        const link = linkStore.getByIssueNumber(binding.id, parsed.issueNumber);
        if (
          link &&
          link.taskId !== createImportedTaskId(candidate.externalId) &&
          link.taskId !== local.task.localTaskId
        )
          throw new ForgejoIdentityError("local task and saved issue link disagree");
        const groups: SyncTaskFieldGroupUpdateV7["groups"] = {};
        for (const group of SYNC_TASK_FIELD_GROUPS) {
          if (remote[group] === undefined) continue;
          const base = link?.fieldSnapshots?.[group];
          Object.assign(groups, {
            [group]: {
              base: base === undefined ? { state: "unknown" } : { state: "known", value: base },
              remote: remote[group],
              ...(issue.updatedAt ? { sourceTimestamp: issue.updatedAt } : {}),
            },
          });
        }
        const update = {
          externalId: candidate.externalId,
          localTaskId: local.task.localTaskId,
          observationToken: local.task.observationToken,
          groups,
        };
        updates.push(update);
        payload.taskUpdates.push({
          externalId: update.externalId,
          localTaskId: update.localTaskId,
          groups: update.groups,
        });
      } else if (local.state === "missing") {
        const linked = linkStore.getByIssueNumber(binding.id, parsed.issueNumber);
        if (linked && linked.taskId !== createImportedTaskId(candidate.externalId))
          throw new ForgejoIdentityError(
            "linked local task is missing; do not recreate it during adoption"
          );
        payload.tasks.push({
          ...mapForgejoIssueToImportedTask(issue),
          title: remote.content!.title,
          description: remote.content!.description,
          assignees: remote.assignment?.assignees,
        });
      } else
        throw new ForgejoIdentityError(`cannot observe ${candidate.externalId}: ${local.state}`);
    }
    const checkpoint = { ...pending.original.checkpoint, attemptId: randomUUID() };
    save(binding, project, {
      ...fields(binding, project),
      pending: { original: pending.original, attempt: { checkpoint, payload } },
    });
    return {
      ...structuredClone(payload),
      taskUpdates: updates,
      cancelledTaskExclusions: [],
      checkpoint,
    };
  }

  return {
    name: lifecycle.name,
    version: lifecycle.version,
    initialize: (config) => lifecycle.initialize(config),
    async shutdown() {
      await lifecycle.shutdown();
      statuses.clear();
    },
    getState: () => ({ ...lifecycle.getState(), bindingStatuses: new Map(statuses) }),
    async recoveryState(binding, project) {
      try {
        const current = state(binding);
        if (current.pendingPull)
          return { state: "legacy-pending", batchIds: [current.pendingPull.checkpoint.id] };
        fields(binding, project);
        return { state: "ready" };
      } catch (error) {
        return { state: "unknown", reason: String(error) };
      }
    },
    async pull(binding, project, context) {
      if (!binding.enabled || binding.strategy === "none" || binding.strategy === "push")
        return empty();
      ready(binding, project);
      if (!retryAllowed(binding)) return empty();
      return run(binding, "pull:issues", async () => {
        let pending = fields(binding, project).pending;
        if (!pending) {
          pending = await discover(binding, project);
          save(binding, project, { ...fields(binding, project), pending });
        }
        return attempt(binding, project, context, pending);
      });
    },
    async acknowledgePull(binding, checkpoint, project, acknowledgment) {
      if (checkpoint === null) return;
      ready(binding, project);
      return run(binding, "pull:acknowledgment", async () => {
        const ledger = fields(binding, project);
        if (!isForgejoV7Checkpoint(checkpoint) || checkpoint.scope !== scope(binding, project))
          throw new Error("Invalid Forgejo v7 checkpoint");
        if (!ledger.pending) {
          if (
            JSON.stringify(state(binding).lastAcknowledgedPull) === JSON.stringify(checkpoint) &&
            ledger.lastReceipt === JSON.stringify(acknowledgment)
          ) {
            idle(binding);
            return;
          }
          throw new Error("Unknown or stale Forgejo v7 checkpoint");
        }
        const issued = ledger.pending.attempt;
        if (!issued || JSON.stringify(issued.checkpoint) !== JSON.stringify(checkpoint))
          throw new Error("Stale Forgejo v7 attempt");
        const outcomes = validateForgejoV7Receipts(issued.payload, acknowledgment);
        const { linkStore, commentLinkStore } = resources();
        const queued = structuredClone(ledger.remoteWrites);
        const retries = new Set(ledger.retryIssueNumbers);
        for (const result of outcomes) {
          const parsed = parseForgejoIssueExternalId(result.externalId);
          const existing = linkStore.getByIssueNumber(binding.id, parsed.issueNumber);
          if (
            existing &&
            existing.taskId !== result.localTaskId &&
            existing.taskId !== createImportedTaskId(result.externalId)
          )
            throw new ForgejoIdentityError("receipt local identity conflicts with saved link");
          const groups = { ...queued[result.externalId]?.groups, ...result.writes };
          for (const group of Object.keys(result.mirrored))
            delete groups[group as keyof typeof groups];
          if (Object.keys(groups).length)
            queued[result.externalId] = {
              issueNumber: parsed.issueNumber,
              localTaskId: result.localTaskId,
              groups,
            };
          else delete queued[result.externalId];
          const supplied = issued.payload.taskUpdates.find(
            (row) => row.externalId === result.externalId
          );
          if (
            result.unresolved ||
            (supplied && Object.keys(supplied.groups).length !== SYNC_TASK_FIELD_GROUPS.length)
          )
            retries.add(parsed.issueNumber);
          else retries.delete(parsed.issueNumber);
        }
        // Retain unresolved/remote-write work BEFORE committing any links or read progress.
        save(binding, project, {
          ...ledger,
          remoteWrites: queued,
          retryIssueNumbers: [...retries],
        });
        // Persist actual host IDs first so staged comment links never inherit a provisional task ID.
        for (const result of outcomes) {
          const parsed = parseForgejoIssueExternalId(result.externalId);
          linkStore.save({
            ...createLinkFromTask({
              binding,
              taskId: result.localTaskId,
              ...target(binding),
              issueNumber: parsed.issueNumber,
            }),
            ...linkStore.getByIssueNumber(binding.id, parsed.issueNumber),
            taskId: result.localTaskId,
          });
        }
        commitForgejoPullLinks(ledger.pending.original, linkStore, commentLinkStore);
        for (const result of outcomes) {
          const parsed = parseForgejoIssueExternalId(result.externalId);
          for (const comment of commentLinkStore.listByIssue(binding.id, parsed.issueNumber)) {
            if (comment.taskId !== result.localTaskId)
              commentLinkStore.save({ ...comment, taskId: result.localTaskId });
          }
          updateForgejoItemFieldSnapshots(
            linkStore,
            binding.id,
            result.localTaskId,
            result.mirrored
          );
          if (result.unresolved)
            resources().logger.warn(
              `unresolved field initialization or remote write for ${result.externalId}`,
              {
                bindingId: binding.id,
                projectId: project.id,
                repo: binding.targetRef,
                direction: "pull",
              }
            );
        }
        const current = state(binding);
        resources().runtimeStore.save({
          ...recordForgejoPullSuccess(current, ledger.pending.original.issueCursor),
          commentPullCursor: ledger.pending.original.commentCursor,
          lastAcknowledgedPull: checkpoint,
          fieldSync: {
            ...current.fieldSync!,
            pending: null,
            lastReceipt: JSON.stringify(acknowledgment),
          },
        });
        idle(binding);
      });
    },
    async push(binding, tasks, project) {
      if (!binding.enabled || binding.strategy === "none" || binding.strategy === "pull")
        return { taskLinks: [], commentLinks: [] };
      ready(binding, project);
      if (!retryAllowed(binding)) return { taskLinks: [], commentLinks: [] };
      return run(binding, "push:issues", async () => {
        const result: Awaited<ReturnType<SyncProviderV7["push"]>> = {
          taskLinks: [],
          commentLinks: [],
        };
        const { issueClient, linkStore, commentLinkStore } = resources();
        const repository = target(binding);
        const commentTasks: ExportedTaskInputV7[] = [];
        for (const task of tasks) {
          const local = exportedForgejoGroups(task);
          let link = linkStore.getByTaskId(binding.id, task.localTaskId);
          if (link && task.externalId && task.externalId !== link.externalId)
            throw new ForgejoIdentityError("export contradicts durable issue link");
          const creation = fields(binding, project).creations?.[task.localTaskId];
          let sourceIdentity: string | undefined;
          if (task.sourceUrl) {
            const prefix = `${repository.baseUrl}/${repository.owner}/${repository.repo}/issues/`;
            const number = task.sourceUrl.startsWith(prefix)
              ? task.sourceUrl.slice(prefix.length)
              : "";
            if (!/^[1-9]\d*$/.test(number))
              throw new ForgejoIdentityError("source URL is not a canonical issue in this binding");
            sourceIdentity = formatForgejoIssueExternalId({
              ...repository,
              issueNumber: Number(number),
            });
            if (
              (task.externalId ?? link?.externalId) &&
              (task.externalId ?? link?.externalId) !== sourceIdentity
            )
              throw new ForgejoIdentityError("source URL contradicts durable external identity");
          }
          const externalId =
            task.externalId ??
            link?.externalId ??
            sourceIdentity ??
            (creation?.state === "created" ? creation.externalId : undefined);
          if (!link && externalId) {
            const parsed = parseForgejoIssueExternalId(externalId);
            assertIssue(binding, externalId, parsed.issueNumber);
            link = createLinkFromTask({
              binding,
              taskId: task.localTaskId,
              ...repository,
              issueNumber: parsed.issueNumber,
            });
          }
          if (!link && task.sourceUrl)
            throw new ForgejoIdentityError(
              "unlinked source URL requires explicit identity recovery before issue creation"
            );
          if (!link) {
            if (
              !local.workflow ||
              !["active", "inprogress", "waiting"].includes(local.workflow.status)
            )
              continue;
            if (!local.content || !local.classification || !local.assignment) continue;
            if (creation?.state === "uncertain")
              throw new ForgejoIdentityError(
                `ambiguous issue creation for ${task.localTaskId}; repair the durable identity before retry`
              );
            const logins = forgejoAssignmentLogins(local.assignment, binding);
            if (logins === null) continue;
            const ledger = fields(binding, project);
            save(binding, project, {
              ...ledger,
              creations: { ...ledger.creations, [task.localTaskId]: { state: "uncertain" } },
            });
            const flat = {
              ...task,
              ...local.content,
              ...local.workflow,
              ...local.classification,
              assignees: local.assignment.assignees,
            };
            const created = await issueClient.createIssue(repository, {
              ...createForgejoIssueCreateFromTask(flat),
              assignees: logins,
            });
            assertIssue(binding, created.externalId, created.number);
            save(binding, project, {
              ...fields(binding, project),
              creations: {
                ...fields(binding, project).creations,
                [task.localTaskId]: {
                  state: "created",
                  externalId: created.externalId,
                  issueNumber: created.number,
                  sourceUrl: created.sourceUrl,
                },
              },
            });
            link = createLinkFromTask({
              binding,
              taskId: task.localTaskId,
              ...repository,
              issueNumber: created.number,
            });
          }
          assertIssue(binding, link.externalId, link.issueNumber);
          const previous = linkStore.getByIssueNumber(binding.id, link.issueNumber);
          if (
            previous &&
            previous.taskId !== task.localTaskId &&
            previous.taskId !== createImportedTaskId(link.externalId)
          )
            throw new ForgejoIdentityError("remote issue is linked to another local task");
          linkStore.save(link);
          link = linkStore.getByTaskId(binding.id, task.localTaskId)!;
          let issue;
          try {
            issue = await issueClient.getIssue(repository, link.issueNumber);
          } catch (error) {
            if (local.workflow?.status !== "canceled" || getForgejoHttpStatus(error) !== 404)
              throw error;
            issue = null;
          }
          if (!issue) {
            if (local.workflow?.status === "canceled") continue;
            throw new ForgejoIdentityError(
              `linked issue #${link.issueNumber} unavailable; no recreation authorized`
            );
          }
          assertIssue(binding, issue.externalId, link.issueNumber);
          if (task.sourceUrl && issue.sourceUrl !== task.sourceUrl)
            throw new ForgejoIdentityError("export source URL contradicts current remote issue");
          linkStore.save(link);
          result.taskLinks.push({
            localTaskId: task.localTaskId,
            externalId: link.externalId,
            sourceUrl: issue.sourceUrl,
          });
          const decision = selectForgejoPushGroups({
            base: link.fieldSnapshots ?? {},
            local,
            remote: remoteForgejoGroups(issue, binding),
            localTimestamp: task.updatedAt,
            remoteTimestamp: issue.updatedAt,
          });
          updateForgejoItemFieldSnapshots(
            linkStore,
            binding.id,
            task.localTaskId,
            decision.mirrored
          );
          const { patch, writable } = forgejoGroupedPatch(decision.writes, issue, binding);
          const ledger = fields(binding, project);
          const queued = { ...ledger.remoteWrites };
          // Always derive current intent from this export, never blindly replay an older winner.
          const remaining = { ...queued[link.externalId]?.groups };
          for (const group of SYNC_TASK_FIELD_GROUPS)
            if (local[group] !== undefined) delete remaining[group];
          Object.assign(remaining, writable);
          if (Object.keys(remaining).length)
            queued[link.externalId] = {
              issueNumber: link.issueNumber,
              localTaskId: task.localTaskId,
              groups: remaining,
            };
          else delete queued[link.externalId];
          const retry = new Set(ledger.retryIssueNumbers);
          if (
            decision.unresolved ||
            Object.keys(writable).length !== Object.keys(decision.writes).length
          )
            retry.add(link.issueNumber);
          else retry.delete(link.issueNumber);
          save(binding, project, {
            ...ledger,
            remoteWrites: queued,
            retryIssueNumbers: [...retry],
          });
          if (Object.keys(writable).length) {
            // Re-read immediately before the partial API write; never clobber a newer remote observation.
            const latest = await issueClient.getIssue(repository, link.issueNumber);
            if (
              !latest ||
              latest.externalId !== issue.externalId ||
              latest.sourceUrl !== issue.sourceUrl ||
              latest.updatedAt !== issue.updatedAt ||
              JSON.stringify([...latest.labels].sort()) !==
                JSON.stringify([...issue.labels].sort()) ||
              JSON.stringify(remoteForgejoGroups(latest, binding)) !==
                JSON.stringify(remoteForgejoGroups(issue, binding))
            )
              throw new Error(
                "Remote issue changed before selective write; retry fresh reconciliation"
              );
            try {
              await issueClient.updateIssue(repository, link.issueNumber, patch);
            } catch (error) {
              if (local.workflow?.status === "canceled" && getForgejoHttpStatus(error) === 404)
                continue;
              throw error;
            }
            const verified = await issueClient.getIssue(repository, link.issueNumber);
            if (!verified) throw new Error("Remote write could not be verified");
            const actual = remoteForgejoGroups(verified, binding);
            for (const group of SYNC_TASK_FIELD_GROUPS)
              if (
                writable[group] !== undefined &&
                (actual[group] === undefined ||
                  !equalForgejoFieldSnapshot(group, writable[group]!, actual[group]!))
              )
                throw new Error(`Remote ${group} write did not persist`);
            updateForgejoItemFieldSnapshots(linkStore, binding.id, task.localTaskId, writable);
            const after = fields(binding, project);
            const writes = { ...after.remoteWrites };
            const unfinished = { ...writes[link.externalId]?.groups };
            for (const group of Object.keys(writable))
              delete unfinished[group as keyof typeof unfinished];
            if (Object.keys(unfinished).length)
              writes[link.externalId] = {
                issueNumber: link.issueNumber,
                localTaskId: task.localTaskId,
                groups: unfinished,
              };
            else delete writes[link.externalId];
            save(binding, project, { ...after, remoteWrites: writes });
          }
          commentTasks.push(task);
        }
        // The supported host exports the complete project, including deferred groups.
        // Preserve legacy local-deletion closure, but never infer deletion from a
        // provisional import link or an unapplied pending import.
        if (!fields(binding, project).pending) {
          const currentIds = new Set(tasks.map((task) => task.localTaskId));
          for (const orphan of linkStore.list(binding.id)) {
            if (
              currentIds.has(orphan.taskId) ||
              orphan.taskId === createImportedTaskId(orphan.externalId)
            )
              continue;
            assertIssue(binding, orphan.externalId, orphan.issueNumber);
            const remote = await issueClient.getIssue(repository, orphan.issueNumber);
            if (!remote)
              throw new ForgejoIdentityError(
                `local task is absent but issue #${orphan.issueNumber} is unavailable; retain recovery identity`
              );
            assertIssue(binding, remote.externalId, orphan.issueNumber);
            if (remote.state !== "closed") {
              const { patch } = forgejoGroupedPatch(
                { workflow: { status: "canceled" } },
                remote,
                binding
              );
              await issueClient.updateIssue(repository, orphan.issueNumber, patch);
              const verified = await issueClient.getIssue(repository, orphan.issueNumber);
              if (
                !verified ||
                remoteForgejoGroups(verified, binding).workflow?.status !== "canceled"
              )
                throw new Error("Local-deletion closure was not verified");
            }
            linkStore.remove(binding.id, orphan.taskId);
            const ledger = fields(binding, project);
            const writes = { ...ledger.remoteWrites };
            delete writes[orphan.externalId];
            save(binding, project, {
              ...ledger,
              remoteWrites: writes,
              retryIssueNumbers: ledger.retryIssueNumbers.filter(
                (number) => number !== orphan.issueNumber
              ),
            });
          }
        }
        const comments = await pushComments({
          binding,
          issueClient,
          target: repository,
          tasks: commentTasks,
          itemLinkStore: linkStore,
          commentLinkStore,
          loadTaskNotes: options.loadTaskNotes,
        }).catch((error: unknown) => {
          throw new ForgejoPhaseError("push:comments", error);
        });
        result.commentLinks = comments.commentLinks;
        resources().runtimeStore.save(recordForgejoPushSuccess(state(binding)));
        idle(binding);
        return result;
      });
    },
  };
}
export const forgejoProvider = createForgejoSyncProvider();
export const syncProvider: SyncProviderRegistrationV7 = {
  manifest: {
    name: "forgejo",
    version: FORGEJO_PROVIDER_VERSION,
    apiVersion: SYNC_PROVIDER_API_VERSION_V7,
  },
  provider: forgejoProvider,
};
