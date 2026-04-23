import type { ExportedTaskInput, ImportedTaskInput, Task, TaskStatus } from "@todu/core";

import {
  createForgejoActorRef,
  type CreateForgejoIssueInput,
  type ForgejoIssue,
  type UpdateForgejoIssueInput,
} from "@/forgejo-client";

const OPEN_STATUS_PRECEDENCE: TaskStatus[] = ["active", "inprogress", "waiting"];
const CLOSED_STATUS_PRECEDENCE: TaskStatus[] = ["done", "canceled"];
const PRIORITY_PRECEDENCE: Task["priority"][] = ["high", "medium", "low"];

export const STATUS_LABEL_PREFIX = "status:";
export const PRIORITY_LABEL_PREFIX = "priority:";

export interface NormalizedForgejoStatus {
  status: TaskStatus;
  state: ForgejoIssue["state"];
  statusLabel: string;
}

export interface NormalizedForgejoPriority {
  priority: Task["priority"];
  priorityLabel: string;
}

export interface ForgejoFieldMapping {
  title: string;
  description?: string;
  status: TaskStatus;
  priority: Task["priority"];
  labels: string[];
}

export function mapForgejoIssueToImportedTask(issue: ForgejoIssue): ImportedTaskInput {
  const normalizedStatus = normalizeForgejoIssueStatus(issue.state, issue.labels);
  const normalizedPriority = normalizeForgejoIssuePriority(issue.labels);

  return {
    externalId: issue.externalId,
    title: issue.title,
    description: issue.body,
    status: normalizedStatus.status,
    priority: normalizedPriority.priority,
    labels: getNormalForgejoLabels(issue.labels),
    assignees: issue.assignees.flatMap((assignee) => {
      const normalized = createForgejoActorRef(assignee);
      return normalized ? [{ ...normalized }] : [];
    }),
    sourceUrl: issue.sourceUrl,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    raw: issue,
  };
}

export function createForgejoIssueCreateFromTask(task: ExportedTaskInput): CreateForgejoIssueInput {
  const normalizedStatus = createForgejoStatusFromTask(task.status);
  const normalizedPriority = createForgejoPriorityFromTask(task.priority);

  return {
    title: task.title,
    body: task.description,
    state: normalizedStatus.state,
    labels: mergeForgejoLabels(
      task.labels,
      normalizedStatus.statusLabel,
      normalizedPriority.priorityLabel
    ),
    assignees: getOutboundForgejoAssignees(task),
  };
}

export function createForgejoIssueUpdateFromTask(task: ExportedTaskInput): UpdateForgejoIssueInput {
  return createForgejoIssueCreateFromTask(task);
}

export function normalizeForgejoIssueStatus(
  state: ForgejoIssue["state"],
  labels: string[]
): NormalizedForgejoStatus {
  const statusLabels = labels.filter((label) => label.startsWith(STATUS_LABEL_PREFIX));

  if (state === "closed") {
    const closedStatusLabel = pickPreferredStatusLabel(statusLabels, CLOSED_STATUS_PRECEDENCE);
    const closedStatus = closedStatusLabel ? parseTaskStatusFromLabel(closedStatusLabel) : "done";

    return {
      state,
      status: closedStatus === "canceled" ? "canceled" : "done",
      statusLabel: createStatusLabel(closedStatus === "canceled" ? "canceled" : "done"),
    };
  }

  const openStatusLabel = pickPreferredStatusLabel(statusLabels, OPEN_STATUS_PRECEDENCE);
  const openStatus = openStatusLabel ? parseTaskStatusFromLabel(openStatusLabel) : "active";

  return {
    state,
    status:
      openStatus === "active" || openStatus === "inprogress" || openStatus === "waiting"
        ? openStatus
        : "active",
    statusLabel: createStatusLabel(
      openStatus === "active" || openStatus === "inprogress" || openStatus === "waiting"
        ? openStatus
        : "active"
    ),
  };
}

export function normalizeForgejoIssuePriority(labels: string[]): NormalizedForgejoPriority {
  const priorityLabels = labels.filter((label) => label.startsWith(PRIORITY_LABEL_PREFIX));
  const matchedPriorityLabel = PRIORITY_PRECEDENCE.map(createPriorityLabel).find((label) =>
    priorityLabels.includes(label)
  );
  const priority = matchedPriorityLabel
    ? parseTaskPriorityFromLabel(matchedPriorityLabel)
    : "medium";

  return {
    priority,
    priorityLabel: createPriorityLabel(priority),
  };
}

export function getNormalForgejoLabels(labels: string[]): string[] {
  return labels.filter(
    (label) => !label.startsWith(STATUS_LABEL_PREFIX) && !label.startsWith(PRIORITY_LABEL_PREFIX)
  );
}

export function mergeForgejoLabels(
  normalLabels: string[],
  statusLabel: string,
  priorityLabel: string
): string[] {
  const dedupedNormalLabels = [...new Set(getNormalForgejoLabels(normalLabels))];
  return [...dedupedNormalLabels, statusLabel, priorityLabel];
}

export function createForgejoStatusFromTask(status: TaskStatus): NormalizedForgejoStatus {
  if (status === "done" || status === "canceled") {
    return {
      state: "closed",
      status,
      statusLabel: createStatusLabel(status),
    };
  }

  return {
    state: "open",
    status,
    statusLabel: createStatusLabel(status),
  };
}

export function createForgejoPriorityFromTask(
  priority: Task["priority"]
): NormalizedForgejoPriority {
  return {
    priority,
    priorityLabel: createPriorityLabel(priority),
  };
}

function createStatusLabel(status: TaskStatus): string {
  return `${STATUS_LABEL_PREFIX}${status}`;
}

function createPriorityLabel(priority: Task["priority"]): string {
  return `${PRIORITY_LABEL_PREFIX}${priority}`;
}

function pickPreferredStatusLabel(labels: string[], precedence: TaskStatus[]): string | null {
  for (const status of precedence) {
    const candidate = createStatusLabel(status);
    if (labels.includes(candidate)) {
      return candidate;
    }
  }

  return null;
}

function parseTaskStatusFromLabel(label: string): TaskStatus {
  return label.slice(STATUS_LABEL_PREFIX.length) as TaskStatus;
}

function parseTaskPriorityFromLabel(label: string): Task["priority"] {
  return label.slice(PRIORITY_LABEL_PREFIX.length) as Task["priority"];
}

function getOutboundForgejoAssignees(task: ExportedTaskInput): string[] | undefined {
  const assignees = task.assignees.flatMap((assignee) => {
    const normalized =
      assignee.externalLogin?.trim() ||
      assignee.displayName?.trim() ||
      assignee.externalAccountId?.trim();
    return normalized ? [normalized] : [];
  });

  return assignees.length > 0 ? assignees : undefined;
}
