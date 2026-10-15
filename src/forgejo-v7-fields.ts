import {
  SYNC_TASK_FIELD_GROUPS,
  validateSyncTaskFieldGroupUpdateV7,
  type Project,
  type ExportedTaskInputV7,
  type IntegrationBinding,
  type SyncTaskFieldGroupValues,
} from "@todu/core";
import {
  createForgejoActorRef,
  type ForgejoIssue,
  type UpdateForgejoIssueInput,
} from "@/forgejo-client";
import {
  createForgejoPriorityFromTask,
  createForgejoStatusFromTask,
  getNormalForgejoLabels,
  normalizeForgejoIssuePriority,
  normalizeForgejoIssueStatus,
} from "@/forgejo-fields";
import {
  equalForgejoFieldSnapshot,
  normalizeForgejoFieldSnapshots,
  type ForgejoFieldSnapshots,
} from "@/forgejo-field-snapshots";

/** Validate new v7 values without rewriting historical/verbatim snapshot storage. */
export function validateForgejoV7FieldSnapshots(value: unknown): ForgejoFieldSnapshots {
  const groups = normalizeForgejoFieldSnapshots(value);
  if (Object.keys(groups).length) {
    const result = validateSyncTaskFieldGroupUpdateV7({
      externalId: "forgejo:schema-validation",
      observationToken: "schema-validation-only",
      groups: Object.fromEntries(
        Object.entries(groups).map(([group, remote]) => [
          group,
          { base: { state: "unknown" }, remote },
        ])
      ),
    });
    if (!result.ok) throw new Error(`Invalid Forgejo v7 field value: ${result.error.message}`);
  }
  return groups;
}

/** Raw identity completeness is not proof that replacing the remote set is safe. */
export function forgejoRemoteAssignmentMapped(
  groups: ForgejoFieldSnapshots,
  binding: IntegrationBinding,
  project: Project
): boolean {
  if (!groups.assignment) return false;
  const authorized = new Set(project.authorizedAssigneeActorIds ?? []);
  return groups.assignment.assignees.every((identity) => {
    const matches = (binding.options?.actorMappings ?? []).filter((row) =>
      identity.externalAccountId
        ? row.externalAccountId === identity.externalAccountId
        : row.externalLogin === identity.externalLogin
    );
    return matches.length === 1 && authorized.has(matches[0].actorId);
  });
}

export function remoteForgejoGroups(
  issue: ForgejoIssue,
  binding: IntegrationBinding
): ForgejoFieldSnapshots {
  const identities = issue.assignees.map(createForgejoActorRef);
  const complete = identities.every((actor) => actor?.externalAccountId || actor?.externalLogin);
  const assignment = complete
    ? {
        assignment: {
          assignees: identities.map((actor) => {
            if (actor!.externalAccountId) return { externalAccountId: actor!.externalAccountId };
            const matches = (binding.options?.actorMappings ?? []).filter(
              (row) => row.externalLogin === actor!.externalLogin
            );
            const account = matches.length === 1 ? matches[0].externalAccountId : undefined;
            return account
              ? { externalAccountId: account }
              : { externalLogin: actor!.externalLogin! };
          }),
        },
      }
    : {};
  return validateForgejoV7FieldSnapshots({
    content: { title: issue.title.trim(), description: (issue.body ?? "").trim() },
    workflow: { status: normalizeForgejoIssueStatus(issue.state, issue.labels).status },
    classification: {
      priority: normalizeForgejoIssuePriority(issue.labels).priority,
      labels: getNormalForgejoLabels(issue.labels),
    },
    ...assignment,
  });
}
export function exportedForgejoGroups(task: ExportedTaskInputV7): ForgejoFieldSnapshots {
  return validateForgejoV7FieldSnapshots(
    Object.fromEntries(
      SYNC_TASK_FIELD_GROUPS.flatMap((group) => {
        const observed = task.groups[group];
        return observed.state === "known" ? [[group, observed.value]] : [];
      })
    )
  );
}
/** Same three-way selection as the host; unknown history never authorizes a write. */
export function selectForgejoPushGroups(params: {
  base: ForgejoFieldSnapshots;
  local: ForgejoFieldSnapshots;
  remote: ForgejoFieldSnapshots;
  localTimestamp: string;
  remoteTimestamp?: string;
}): { mirrored: ForgejoFieldSnapshots; writes: ForgejoFieldSnapshots; unresolved: boolean } {
  const mirrored: ForgejoFieldSnapshots = {};
  const writes: ForgejoFieldSnapshots = {};
  let unresolved = false;
  for (const group of SYNC_TASK_FIELD_GROUPS) {
    const local = params.local[group];
    const remote = params.remote[group];
    const base = params.base[group];
    if (local === undefined || remote === undefined) {
      unresolved = true;
      continue;
    }
    if (equalForgejoFieldSnapshot(group, local, remote)) {
      Object.assign(mirrored, { [group]: local });
    } else if (base === undefined) {
      unresolved = true;
    } else {
      const localChanged = !equalForgejoFieldSnapshot(group, local, base);
      const remoteChanged = !equalForgejoFieldSnapshot(group, remote, base);
      const localWins =
        localChanged &&
        (!remoteChanged ||
          (Number.isFinite(Date.parse(params.localTimestamp)) &&
            params.remoteTimestamp !== undefined &&
            Number.isFinite(Date.parse(params.remoteTimestamp)) &&
            Date.parse(params.localTimestamp) > Date.parse(params.remoteTimestamp)));
      if (localWins) Object.assign(writes, { [group]: local });
      else unresolved = true;
    }
  }
  return { mirrored, writes, unresolved };
}
export function forgejoAssignmentLogins(
  value: SyncTaskFieldGroupValues["assignment"],
  binding: IntegrationBinding,
  issue?: ForgejoIssue
): string[] | null {
  const result: string[] = [];
  for (const identity of value.assignees) {
    if (!identity.externalAccountId && identity.externalLogin) {
      result.push(identity.externalLogin);
      continue;
    }
    const rows = (binding.options?.actorMappings ?? []).filter(
      (row) => row.externalAccountId === identity.externalAccountId
    );
    const existing =
      issue?.assignees
        .map(createForgejoActorRef)
        .filter((actor) => actor?.externalAccountId === identity.externalAccountId) ?? [];
    const login =
      rows.length === 1
        ? rows[0].externalLogin
        : existing.length === 1
          ? existing[0]?.externalLogin
          : undefined;
    if (!login) return null;
    result.push(login);
  }
  return [...new Set(result)].sort();
}
/** Workflow and classification share labels; merge only supplied groups into a fresh issue. */
export function forgejoGroupedPatch(
  groups: ForgejoFieldSnapshots,
  issue: ForgejoIssue,
  binding: IntegrationBinding
): { patch: UpdateForgejoIssueInput; writable: ForgejoFieldSnapshots } {
  const patch: UpdateForgejoIssueInput = {};
  const writable = structuredClone(groups);
  if (groups.content) {
    patch.title = groups.content.title;
    patch.body = groups.content.description;
  }
  let labels = [...issue.labels];
  if (groups.workflow) {
    const status = createForgejoStatusFromTask(groups.workflow.status);
    patch.state = status.state;
    labels = [...labels.filter((label) => !label.startsWith("status:")), status.statusLabel];
  }
  if (groups.classification) {
    const priority = createForgejoPriorityFromTask(groups.classification.priority);
    labels = [
      ...labels.filter((label) => label.startsWith("status:")),
      priority.priorityLabel,
      ...groups.classification.labels,
    ];
  }
  if (groups.workflow || groups.classification) patch.labels = [...new Set(labels)].sort();
  if (groups.assignment) {
    const logins = forgejoAssignmentLogins(groups.assignment, binding, issue);
    if (logins === null) delete writable.assignment;
    else patch.assignees = logins;
  }
  return { patch, writable };
}
