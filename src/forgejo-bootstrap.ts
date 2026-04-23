import type { ExportedTaskInput, ImportedTaskInput, IntegrationBinding } from "@todu/core";

import {
  createForgejoIssueCreateFromTask,
  createForgejoIssueUpdateFromTask,
  mapForgejoIssueToImportedTask,
} from "@/forgejo-fields";
import { type ForgejoIssue, type ForgejoIssueClient } from "@/forgejo-client";
import type { ForgejoCommentLinkStore } from "@/forgejo-comment-links";
import { parseForgejoIssueExternalId } from "@/forgejo-ids";
import {
  createLinkFromIssue,
  createLinkFromTask,
  type ForgejoItemLink,
  type ForgejoItemLinkStore,
} from "@/forgejo-links";

const TASK_BOOTSTRAP_EXPORT_STATUSES = new Set<ExportedTaskInput["status"]>([
  "active",
  "inprogress",
  "waiting",
]);

export interface ForgejoBootstrapImportResult {
  tasks: ImportedTaskInput[];
  createdLinks: ForgejoItemLink[];
  touchedIssueNumbers: number[];
}

export interface ForgejoBootstrapTaskUpdate {
  taskId: ExportedTaskInput["localTaskId"];
  externalId: string;
  sourceUrl?: string;
}

export interface ForgejoBootstrapExportResult {
  createdIssues: ForgejoIssue[];
  updatedIssues: ForgejoIssue[];
  closedIssues: ForgejoIssue[];
  createdLinks: ForgejoItemLink[];
  taskUpdates: ForgejoBootstrapTaskUpdate[];
  hydratedLinkedTasks: number;
  issueReadCount: number;
  skippedLinkedTasks: number;
}

export async function bootstrapForgejoIssuesToTasks(input: {
  binding: IntegrationBinding;
  baseUrl: string;
  apiBaseUrl: string;
  owner: string;
  repo: string;
  issueClient: ForgejoIssueClient;
  linkStore: ForgejoItemLinkStore;
  since?: string;
  importClosedOnBootstrap?: boolean;
}): Promise<ForgejoBootstrapImportResult> {
  const issues = await input.issueClient.listIssues(
    {
      baseUrl: input.baseUrl,
      apiBaseUrl: input.apiBaseUrl,
      owner: input.owner,
      repo: input.repo,
    },
    input.since ? { since: input.since } : undefined
  );

  const tasks: ImportedTaskInput[] = [];
  const createdLinks: ForgejoItemLink[] = [];
  const touchedIssueNumbers: number[] = [];
  const shouldImportClosedIssuesOnBootstrap =
    input.importClosedOnBootstrap === true && !input.since;

  for (const issue of issues) {
    if (issue.isPullRequest) {
      continue;
    }

    const existingLink = input.linkStore.getByIssueNumber(input.binding.id, issue.number);
    if (!existingLink && issue.state !== "open" && !shouldImportClosedIssuesOnBootstrap) {
      continue;
    }

    const lastMirroredAt = issue.updatedAt ?? issue.createdAt;

    if (!existingLink) {
      const createdLink = createLinkFromIssue({
        binding: input.binding,
        issue,
        baseUrl: input.baseUrl,
        owner: input.owner,
        repo: input.repo,
      });
      input.linkStore.save(createdLink);
      createdLinks.push(createdLink);
    } else if (lastMirroredAt && existingLink.lastMirroredAt !== lastMirroredAt) {
      input.linkStore.save({
        ...existingLink,
        lastMirroredAt,
      });
    }

    tasks.push(mapForgejoIssueToImportedTask(issue));
    touchedIssueNumbers.push(issue.number);
  }

  return {
    tasks,
    createdLinks,
    touchedIssueNumbers,
  };
}

export async function bootstrapTasksToForgejoIssues(input: {
  binding: IntegrationBinding;
  baseUrl: string;
  apiBaseUrl: string;
  owner: string;
  repo: string;
  tasks: ExportedTaskInput[];
  issueClient: ForgejoIssueClient;
  linkStore: ForgejoItemLinkStore;
  commentLinkStore?: ForgejoCommentLinkStore;
  shouldSkipIssueUpdate?: (issue: ForgejoIssue) => boolean;
}): Promise<ForgejoBootstrapExportResult> {
  const createdIssues: ForgejoIssue[] = [];
  const updatedIssues: ForgejoIssue[] = [];
  const closedIssues: ForgejoIssue[] = [];
  const createdLinks: ForgejoItemLink[] = [];
  const taskUpdates: ForgejoBootstrapTaskUpdate[] = [];
  let hydratedLinkedTasks = 0;
  let issueReadCount = 0;
  let skippedLinkedTasks = 0;

  const target = {
    baseUrl: input.baseUrl,
    apiBaseUrl: input.apiBaseUrl,
    owner: input.owner,
    repo: input.repo,
  };

  const existingLabels = new Set(await input.issueClient.listLabels(target));

  const ensureLabelsExist = async (labels: string[]): Promise<void> => {
    for (const label of labels) {
      if (!existingLabels.has(label)) {
        await input.issueClient.createLabel(target, label);
        existingLabels.add(label);
      }
    }
  };

  const clearStaleTaskReferences = (taskId: ExportedTaskInput["localTaskId"]): void => {
    input.linkStore.remove(input.binding.id, taskId as ForgejoItemLink["taskId"]);

    if (!input.commentLinkStore) {
      return;
    }

    for (const commentLink of input.commentLinkStore.listByTask(
      input.binding.id,
      taskId as ForgejoItemLink["taskId"]
    )) {
      input.commentLinkStore.remove(input.binding.id, commentLink.noteId);
    }
  };

  const createIssueForTask = async (task: ExportedTaskInput): Promise<boolean> => {
    if (!TASK_BOOTSTRAP_EXPORT_STATUSES.has(task.status)) {
      return false;
    }

    const issueCreate = createForgejoIssueCreateFromTask(task);
    await ensureLabelsExist(issueCreate.labels ?? []);
    const createdIssue = await input.issueClient.createIssue(target, issueCreate);

    createdIssues.push(createdIssue);

    const createdLink = createLinkFromTask({
      binding: input.binding,
      taskId: task.localTaskId as ForgejoItemLink["taskId"],
      baseUrl: input.baseUrl,
      owner: input.owner,
      repo: input.repo,
      issueNumber: createdIssue.number,
      lastMirroredAt: createdIssue.updatedAt ?? createdIssue.createdAt,
    });
    input.linkStore.save(createdLink);
    createdLinks.push(createdLink);
    taskUpdates.push({
      taskId: task.localTaskId,
      externalId: createdLink.externalId,
      sourceUrl: createdIssue.sourceUrl,
    });

    return true;
  };

  for (const task of input.tasks) {
    const localTaskId = task.localTaskId;
    const existingLink = input.linkStore.getByTaskId(
      input.binding.id,
      localTaskId as ForgejoItemLink["taskId"]
    );
    if (existingLink) {
      if (!existingLink.lastMirroredAt) {
        issueReadCount += 1;
        const existingIssue = await input.issueClient.getIssue(target, existingLink.issueNumber);
        hydratedLinkedTasks += 1;

        if (!existingIssue) {
          clearStaleTaskReferences(localTaskId);
          await createIssueForTask(task);
          continue;
        }

        const hydratedLink: ForgejoItemLink = {
          ...existingLink,
          lastMirroredAt: existingIssue.updatedAt ?? existingIssue.createdAt,
        };
        input.linkStore.save(hydratedLink);

        if (!shouldPushTaskUpdate(task, existingIssue)) {
          skippedLinkedTasks += 1;
          continue;
        }

        if (input.shouldSkipIssueUpdate?.(existingIssue)) {
          continue;
        }
      } else if (!shouldPushTaskUpdateFromMirroredAt(task, existingLink.lastMirroredAt)) {
        skippedLinkedTasks += 1;
        continue;
      }

      const issueUpdate = createForgejoIssueUpdateFromTask(task);
      await ensureLabelsExist(issueUpdate.labels ?? []);

      try {
        const updatedIssue = await input.issueClient.updateIssue(
          target,
          existingLink.issueNumber,
          issueUpdate
        );
        input.linkStore.save({
          ...existingLink,
          lastMirroredAt: updatedIssue.updatedAt ?? updatedIssue.createdAt,
        });
        updatedIssues.push(updatedIssue);
      } catch (error) {
        if (!isForgejoIssueNotFoundError(error)) {
          throw error;
        }

        clearStaleTaskReferences(localTaskId);
        await createIssueForTask(task);
      }
      continue;
    }

    const matchingExternalId = getMatchingExternalId(task, input.baseUrl, input.owner, input.repo);
    if (matchingExternalId) {
      issueReadCount += 1;
      const existingIssue = await input.issueClient.getIssue(
        target,
        matchingExternalId.issueNumber
      );

      if (!existingIssue) {
        clearStaleTaskReferences(localTaskId);
        await createIssueForTask(task);
        continue;
      }

      const createdLink = createLinkFromTask({
        binding: input.binding,
        taskId: localTaskId as ForgejoItemLink["taskId"],
        baseUrl: input.baseUrl,
        owner: input.owner,
        repo: input.repo,
        issueNumber: matchingExternalId.issueNumber,
        lastMirroredAt: existingIssue.updatedAt ?? existingIssue.createdAt,
      });
      input.linkStore.save(createdLink);
      createdLinks.push(createdLink);

      if (
        shouldPushTaskUpdate(task, existingIssue) &&
        !input.shouldSkipIssueUpdate?.(existingIssue)
      ) {
        const issueUpdate = createForgejoIssueUpdateFromTask(task);
        await ensureLabelsExist(issueUpdate.labels ?? []);
        const updatedIssue = await input.issueClient.updateIssue(
          target,
          matchingExternalId.issueNumber,
          issueUpdate
        );
        input.linkStore.save({
          ...createdLink,
          lastMirroredAt: updatedIssue.updatedAt ?? updatedIssue.createdAt,
        });
        updatedIssues.push(updatedIssue);
      }
      continue;
    }

    await createIssueForTask(task);
  }

  const currentTaskIds = new Set(input.tasks.map((task) => String(task.localTaskId)));
  const orphanedLinks = input.linkStore
    .list(input.binding.id)
    .filter((link) => !currentTaskIds.has(String(link.taskId)));

  for (const orphanedLink of orphanedLinks) {
    issueReadCount += 1;
    const existingIssue = await input.issueClient.getIssue(target, orphanedLink.issueNumber);

    if (!existingIssue) {
      input.linkStore.remove(input.binding.id, orphanedLink.taskId);
      continue;
    }

    if (input.shouldSkipIssueUpdate?.(existingIssue)) {
      continue;
    }

    if (existingIssue.state === "closed") {
      input.linkStore.remove(input.binding.id, orphanedLink.taskId);
      continue;
    }

    const issueClose = createForgejoIssueCloseFromDeletion(existingIssue);
    await ensureLabelsExist(issueClose.labels ?? []);
    const closedIssue = await input.issueClient.updateIssue(
      target,
      orphanedLink.issueNumber,
      issueClose
    );
    closedIssues.push(closedIssue);
    input.linkStore.remove(input.binding.id, orphanedLink.taskId);
  }

  return {
    createdIssues,
    updatedIssues,
    closedIssues,
    createdLinks,
    taskUpdates,
    hydratedLinkedTasks,
    issueReadCount,
    skippedLinkedTasks,
  };
}

function isForgejoIssueNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b/.test(message) || /issue not found/i.test(message);
}

function createForgejoIssueCloseFromDeletion(issue: ForgejoIssue): {
  state: "closed";
  labels: string[];
} {
  return {
    state: "closed",
    labels: [
      ...new Set([
        ...issue.labels.filter((label) => !label.startsWith("status:")),
        "status:canceled",
      ]),
    ],
  };
}

function shouldPushTaskUpdate(task: ExportedTaskInput, issue: ForgejoIssue | null): boolean {
  if (!issue) {
    return true;
  }

  if (issueMatchesTask(task, issue)) {
    return false;
  }

  return shouldPushTaskUpdateFromMirroredAt(task, issue.updatedAt ?? issue.createdAt);
}

function shouldPushTaskUpdateFromMirroredAt(
  task: ExportedTaskInput,
  lastMirroredAt: string | undefined
): boolean {
  if (!lastMirroredAt) {
    return true;
  }

  const taskUpdatedAt = task.updatedAt;
  if (!taskUpdatedAt) {
    return true;
  }

  return taskUpdatedAt > lastMirroredAt;
}

function issueMatchesTask(task: ExportedTaskInput, issue: ForgejoIssue): boolean {
  const expected = createForgejoIssueCreateFromTask(task);

  if (expected.title !== issue.title) {
    return false;
  }

  if ((expected.body ?? "") !== (issue.body ?? "")) {
    return false;
  }

  const expectedState = expected.state ?? "open";
  if (expectedState !== issue.state) {
    return false;
  }

  const expectedLabels = [...(expected.labels ?? [])].sort();
  const issueLabels = [...issue.labels].sort();
  if (
    expectedLabels.length !== issueLabels.length ||
    expectedLabels.some((label, index) => label !== issueLabels[index])
  ) {
    return false;
  }

  const expectedAssignees = [...(expected.assignees ?? [])].sort();
  const issueAssignees = issue.assignees
    .flatMap((assignee) => {
      if (typeof assignee === "string") {
        return assignee ? [assignee] : [];
      }

      return assignee.externalLogin ?? assignee.displayName ?? assignee.externalAccountId ?? [];
    })
    .sort();
  if (
    expectedAssignees.length !== issueAssignees.length ||
    expectedAssignees.some((assignee, index) => assignee !== issueAssignees[index])
  ) {
    return false;
  }

  return true;
}

function getMatchingExternalId(
  task: ExportedTaskInput,
  baseUrl: string,
  owner: string,
  repo: string
): { issueNumber: number } | null {
  const externalId = task.externalId;
  if (!externalId) {
    return null;
  }

  try {
    const parsedExternalId = parseForgejoIssueExternalId(externalId);
    if (
      parsedExternalId.baseUrl !== baseUrl ||
      parsedExternalId.owner !== owner ||
      parsedExternalId.repo !== repo
    ) {
      return null;
    }

    return {
      issueNumber: parsedExternalId.issueNumber,
    };
  } catch {
    return null;
  }
}
