import {
  SYNC_TASK_FIELD_GROUPS,
  validateSyncTaskFieldGroupUpdateV7,
  type IntegrationBinding,
  type SyncProviderPullResultV7,
  type SyncTaskFieldGroupUpdateV7,
  type TaskId,
} from "@todu/core";
import type { ForgejoFieldSnapshots } from "@/forgejo-field-snapshots";
import { validateForgejoV7FieldSnapshots } from "@/forgejo-v7-fields";
import {
  isForgejoPullCheckpoint,
  validateForgejoPendingPull,
  type ForgejoPendingPull,
  type ForgejoPullCheckpoint,
} from "@/forgejo-pull-checkpoint";

export interface ForgejoV7Checkpoint extends ForgejoPullCheckpoint {
  attemptId: string;
}
export type ForgejoV7Payload = Omit<
  SyncProviderPullResultV7,
  "taskUpdates" | "cancelledTaskExclusions" | "checkpoint"
> & {
  taskUpdates: Omit<SyncTaskFieldGroupUpdateV7, "observationToken">[];
};
export interface ForgejoV7Pending {
  /** Immutable captured discovery/comments/checkpoint; never converted from a legacy queue. */
  original: ForgejoPendingPull;
  /** Token-free actual issued attempt; fresh tokens are invocation-local only. */
  attempt: { checkpoint: ForgejoV7Checkpoint; payload: ForgejoV7Payload } | null;
}
export interface ForgejoRemoteWrite {
  localTaskId: TaskId;
  issueNumber: number;
  groups: ForgejoFieldSnapshots;
}
export interface ForgejoFieldSyncState {
  version: 7;
  scope?: string;
  lastReceipt?: string;
  /** An ambiguous create must be repaired explicitly, never repeated blindly. */
  creations?: Record<
    string,
    | { state: "uncertain" }
    | { state: "created"; externalId: string; issueNumber: number; sourceUrl?: string }
  >;
  pending: ForgejoV7Pending | null;
  retryIssueNumbers: number[];
  /** Re-fetch these comments without a cursor if a missing local task returns. */
  deferredCommentIssueNumbers?: number[];
  /** Native host assignment deferral survives push and restart until a fresh receipt. */
  deferredAssignments?: number[];
  remoteWrites: Record<string, ForgejoRemoteWrite>;
}
export function createInitialForgejoFieldSync(): ForgejoFieldSyncState {
  return { version: 7, pending: null, retryIssueNumbers: [], remoteWrites: {} };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function dense(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean)
  );
}
export function isForgejoV7Checkpoint(value: unknown): value is ForgejoV7Checkpoint {
  return (
    isForgejoPullCheckpoint(value) &&
    "attemptId" in value &&
    typeof value.attemptId === "string" &&
    value.attemptId.length > 0
  );
}
export function validateForgejoFieldSync(
  value: unknown,
  bindingId: IntegrationBinding["id"]
): asserts value is ForgejoFieldSyncState {
  try {
    if (
      !record(value) ||
      value.version !== 7 ||
      !dense(value.retryIssueNumbers) ||
      !value.retryIssueNumbers.every((n) => Number.isInteger(n) && Number(n) > 0) ||
      !record(value.remoteWrites)
    )
      throw new Error("invalid ledger shape");
    for (const key of ["deferredCommentIssueNumbers", "deferredAssignments"]) {
      const list = value[key];
      if (
        list !== undefined &&
        (!dense(list) || !list.every((number) => Number.isInteger(number) && Number(number) > 0))
      )
        throw new Error(`invalid ${key}`);
    }
    if (
      (value.scope !== undefined && (typeof value.scope !== "string" || !value.scope)) ||
      (value.lastReceipt !== undefined && typeof value.lastReceipt !== "string")
    )
      throw new Error("invalid scope/receipt");
    if (
      !value.scope &&
      (value.pending !== null ||
        value.retryIssueNumbers.length > 0 ||
        Object.keys(value.remoteWrites).length > 0 ||
        (Array.isArray(value.deferredAssignments) && value.deferredAssignments.length > 0) ||
        (Array.isArray(value.deferredCommentIssueNumbers) &&
          value.deferredCommentIssueNumbers.length > 0) ||
        (record(value.creations) && Object.keys(value.creations).length > 0))
    )
      throw new Error("nonempty work has no binding/project scope");
    if (value.creations !== undefined) {
      if (!record(value.creations)) throw new Error("invalid creation journal");
      for (const [id, creation] of Object.entries(value.creations)) {
        if (!id || !record(creation) || !["uncertain", "created"].includes(String(creation.state)))
          throw new Error("invalid creation intent");
        if (
          creation.state === "created" &&
          (typeof creation.externalId !== "string" ||
            !creation.externalId ||
            !Number.isInteger(creation.issueNumber) ||
            Number(creation.issueNumber) <= 0 ||
            (creation.sourceUrl !== undefined && typeof creation.sourceUrl !== "string"))
        )
          throw new Error("invalid created identity");
      }
    }
    for (const [externalId, write] of Object.entries(value.remoteWrites)) {
      if (
        !externalId ||
        !record(write) ||
        typeof write.localTaskId !== "string" ||
        !write.localTaskId ||
        !Number.isInteger(write.issueNumber) ||
        Number(write.issueNumber) <= 0
      )
        throw new Error("invalid remote write");
      const groups = validateForgejoV7FieldSnapshots(write.groups);
      if (!groups || Object.keys(groups).length === 0) throw new Error("empty remote-write groups");
    }
    if (value.pending === null) return;
    if (!record(value.pending)) throw new Error("invalid pending work");
    validateForgejoPendingPull(value.pending.original, bindingId);
    const attempt = value.pending.attempt;
    if (attempt === null) return;
    if (
      !record(attempt) ||
      !isForgejoV7Checkpoint(attempt.checkpoint) ||
      attempt.checkpoint.id !== value.pending.original.checkpoint.id ||
      attempt.checkpoint.scope !== value.pending.original.checkpoint.scope ||
      !record(attempt.payload) ||
      !dense(attempt.payload.tasks) ||
      !dense(attempt.payload.taskUpdates)
    )
      throw new Error("invalid attempt");
    for (const task of attempt.payload.tasks) {
      if (!record(task) || typeof task.externalId !== "string" || typeof task.title !== "string")
        throw new Error("invalid bootstrap row");
    }
    for (const update of attempt.payload.taskUpdates) {
      if (!record(update) || Object.hasOwn(update, "observationToken") || !record(update.groups))
        throw new Error("persisted invocation token or invalid groups");
      for (const group of SYNC_TASK_FIELD_GROUPS) {
        const input = update.groups[group];
        if (record(input)) {
          validateForgejoV7FieldSnapshots({ [group]: input.remote });
          if (record(input.base) && input.base.state === "known")
            validateForgejoV7FieldSnapshots({ [group]: input.base.value });
        }
      }
      const valid = validateSyncTaskFieldGroupUpdateV7({
        ...update,
        observationToken: "schema-validation-only",
      });
      if (!valid.ok) throw new Error(valid.error.message);
    }
  } catch (error) {
    throw new Error(`Invalid Forgejo field-sync ledger: ${String(error)}`, { cause: error });
  }
}
