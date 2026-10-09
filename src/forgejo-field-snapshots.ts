import {
  SYNC_TASK_FIELD_GROUPS,
  validateSyncTaskFieldGroupUpdate,
  type SyncAssigneeIdentity,
  type SyncTaskFieldGroup,
  type SyncTaskFieldGroupValues,
} from "@todu/core";

import { getNormalForgejoLabels } from "@/forgejo-fields";

// An omitted group is unknown, not an empty value or a timestamp-derived base.
export type ForgejoFieldSnapshots = Partial<SyncTaskFieldGroupValues>;

const normalizers: {
  [K in SyncTaskFieldGroup]: (value: SyncTaskFieldGroupValues[K]) => SyncTaskFieldGroupValues[K];
} = {
  content: ({ title, description }) => ({ title, description }),
  // Status uniquely determines normalized Forgejo state and status label.
  workflow: ({ status }) => ({ status }),
  classification: ({ priority, labels }) => {
    assertDenseSnapshotArray("classification", labels);
    return { priority, labels: [...new Set(getNormalForgejoLabels(labels))].sort() };
  },
  assignment: ({ assignees }) => {
    assertDenseSnapshotArray("assignment", assignees);
    const identities = new Map<string, SyncAssigneeIdentity>();
    for (const assignee of assignees) {
      // Account IDs survive login/display-name changes. Login-only identities
      // remain exact; resolving an alias to an account is the host's concern.
      const identity =
        assignee.externalAccountId !== undefined
          ? { externalAccountId: assignee.externalAccountId }
          : { externalLogin: assignee.externalLogin! };
      const key = JSON.stringify(
        assignee.externalAccountId !== undefined
          ? ["account", assignee.externalAccountId]
          : ["login", assignee.externalLogin]
      );
      identities.set(key, identity);
    }
    return { assignees: [...identities.keys()].sort().map((key) => identities.get(key)!) };
  },
};

function assertDenseSnapshotArray(group: SyncTaskFieldGroup, values: unknown[]): void {
  // Array.every (used by the core validator) skips holes. Missing observations
  // must not silently become an empty baseline or fail with an unrelated TypeError.
  for (let index = 0; index < values.length; index++) {
    if (!Object.hasOwn(values, index))
      throw new Error(
        `Invalid Forgejo field snapshot ${group}: sparse arrays are not complete values`
      );
  }
}

export function normalizeForgejoFieldSnapshot<K extends SyncTaskFieldGroup>(
  group: K,
  value: SyncTaskFieldGroupValues[K]
): SyncTaskFieldGroupValues[K] {
  // Reuse the published complete-value validator without adopting provider v5.
  const validated = validateSyncTaskFieldGroupUpdate({
    externalId: "forgejo:field-snapshot",
    groups: { [group]: { base: value, remote: value } },
  });
  if (!validated.ok)
    throw new Error(`Invalid Forgejo field snapshot ${group}: ${validated.error.message}`);
  return normalizers[group](value);
}

export function normalizeForgejoFieldSnapshots(value: unknown): ForgejoFieldSnapshots {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new Error("Invalid Forgejo field snapshot collection: expected a plain object");
  const record = value as Record<string, unknown>;
  for (const group of Object.keys(record)) {
    if (!SYNC_TASK_FIELD_GROUPS.includes(group as SyncTaskFieldGroup))
      throw new Error(`Invalid Forgejo field snapshot group: ${group}`);
  }
  return Object.fromEntries(
    SYNC_TASK_FIELD_GROUPS.filter((group) => Object.hasOwn(record, group)).map((group) => [
      group,
      normalizeForgejoFieldSnapshot(group, record[group] as SyncTaskFieldGroupValues[typeof group]),
    ])
  ) as ForgejoFieldSnapshots;
}

export function equalForgejoFieldSnapshot<K extends SyncTaskFieldGroup>(
  group: K,
  left: SyncTaskFieldGroupValues[K],
  right: SyncTaskFieldGroupValues[K]
): boolean {
  return (
    JSON.stringify(normalizeForgejoFieldSnapshot(group, left)) ===
    JSON.stringify(normalizeForgejoFieldSnapshot(group, right))
  );
}
