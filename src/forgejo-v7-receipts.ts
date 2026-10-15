import {
  SYNC_TASK_FIELD_GROUPS,
  type ImportedTaskInput,
  type SyncProviderPullAcknowledgmentV7,
  type SyncTaskFieldGroup,
  type SyncTaskPersistedReceipt,
} from "@todu/core";
import {
  equalForgejoFieldSnapshot,
  normalizeForgejoFieldSnapshots,
  type ForgejoFieldSnapshots,
} from "@/forgejo-field-snapshots";
import type { ForgejoV7Payload } from "@/forgejo-v7-ledger";
import { validateForgejoV7FieldSnapshots } from "@/forgejo-v7-fields";

function bootstrapRemote(task: ImportedTaskInput): ForgejoFieldSnapshots {
  return normalizeForgejoFieldSnapshots({
    ...(task.description !== undefined
      ? { content: { title: task.title, description: task.description } }
      : {}),
    ...(task.status !== undefined ? { workflow: { status: task.status } } : {}),
    ...(task.priority !== undefined && task.labels !== undefined
      ? { classification: { priority: task.priority, labels: task.labels } }
      : {}),
    ...(task.assignees !== undefined ? { assignment: { assignees: task.assignees } } : {}),
  });
}
export interface ForgejoValidatedReceipt {
  externalId: string;
  localTaskId: SyncTaskPersistedReceipt["localTaskId"];
  mirrored: ForgejoFieldSnapshots;
  writes: ForgejoFieldSnapshots;
  unresolved: boolean;
  assignmentDeferred: boolean;
}
export function validateForgejoV7Receipts(
  payload: ForgejoV7Payload,
  acknowledgment: SyncProviderPullAcknowledgmentV7
): ForgejoValidatedReceipt[] {
  function fail(reason: string): never {
    throw new Error(`Invalid Forgejo v7 acknowledgment: ${reason}`);
  }
  if (
    !acknowledgment ||
    !Array.isArray(acknowledgment.bootstrapResults) ||
    !Array.isArray(acknowledgment.taskResults) ||
    acknowledgment.bootstrapResults.length !== payload.tasks.length ||
    acknowledgment.taskResults.length !== payload.taskUpdates.length
  )
    fail("receipt count");
  const seen = new Set<string>();
  const validate = (
    receipt: SyncTaskPersistedReceipt,
    externalId: string,
    remote: ForgejoFieldSnapshots,
    groups: SyncTaskFieldGroup[],
    localTaskId?: string,
    knownGroups: SyncTaskFieldGroup[] = []
  ): ForgejoValidatedReceipt => {
    if (
      !receipt ||
      receipt.externalId !== externalId ||
      typeof receipt.localTaskId !== "string" ||
      !receipt.localTaskId ||
      (localTaskId && receipt.localTaskId !== localTaskId) ||
      seen.has(receipt.localTaskId) ||
      !receipt.groups ||
      typeof receipt.groups !== "object" ||
      Array.isArray(receipt.groups)
    )
      fail("receipt identity/order");
    seen.add(receipt.localTaskId);
    const keys = Object.keys(receipt.groups);
    if (
      keys.length !== groups.length ||
      keys.some((key) => !groups.includes(key as SyncTaskFieldGroup))
    )
      fail("receipt group membership");
    const result: ForgejoValidatedReceipt = {
      externalId,
      localTaskId: receipt.localTaskId,
      mirrored: {},
      writes: {},
      unresolved: false,
      assignmentDeferred: false,
    };
    for (const group of groups) {
      const outcome = receipt.groups[group];
      if (!outcome || typeof outcome !== "object") fail("missing group outcome");
      if (outcome!.state === "deferred") {
        if (
          (group !== "content" || outcome!.reason !== "pending-content-approval") &&
          (group !== "assignment" || outcome!.reason !== "incomplete-assignment-mapping")
        )
          fail("invalid deferral");
        if (Object.keys(outcome!).some((key) => !["state", "reason"].includes(key)))
          fail("deferred outcome carries a value");
        result.unresolved = true;
        if (group === "assignment") result.assignmentDeferred = true;
        continue;
      }
      if (outcome.state !== "persisted") fail("unknown outcome state");
      validateForgejoV7FieldSnapshots({ [group]: outcome.value });
      if (
        Object.keys(outcome).some(
          (key) => !["state", "value", "baseline", "remoteWriteRequired", "reason"].includes(key)
        )
      )
        fail("unknown outcome property");
      if (outcome.baseline === "mirrored") {
        if (
          outcome.remoteWriteRequired !== false ||
          "reason" in outcome ||
          remote[group] === undefined ||
          !equalForgejoFieldSnapshot(group, outcome.value, remote[group]!)
        )
          fail("unverified mirrored value");
        Object.assign(result.mirrored, { [group]: outcome.value });
      } else if (outcome.baseline === "unproven") {
        result.unresolved = true;
        if (
          outcome.remoteWriteRequired === true &&
          outcome.reason === "remote-write-required" &&
          knownGroups.includes(group)
        )
          Object.assign(result.writes, { [group]: outcome.value });
        else if (
          outcome.remoteWriteRequired !== false ||
          knownGroups.includes(group) ||
          (outcome.reason === "initialization-disagreement"
            ? remote[group] === undefined
            : outcome.reason !== "remote-value-unknown" || remote[group] !== undefined)
        )
          fail("invalid unproven outcome");
      } else fail("unknown baseline state");
    }
    return result;
  };
  return [
    ...payload.tasks.map((task, i) =>
      validate(acknowledgment.bootstrapResults[i], task.externalId, bootstrapRemote(task), [
        ...SYNC_TASK_FIELD_GROUPS,
      ])
    ),
    ...payload.taskUpdates.map((update, i) =>
      validate(
        acknowledgment.taskResults[i],
        update.externalId,
        Object.fromEntries(
          Object.entries(update.groups).map(([group, input]) => [group, input!.remote])
        ),
        Object.keys(update.groups) as SyncTaskFieldGroup[],
        update.localTaskId,
        Object.entries(update.groups)
          .filter(([, input]) => input!.base.state === "known")
          .map(([group]) => group as SyncTaskFieldGroup)
      )
    ),
  ];
}
