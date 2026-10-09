import type { ExportedTaskInput, ImportedTaskInput, IntegrationBinding } from "@todu/core";

import {
  createForgejoIssueCreateFromTask,
  createForgejoIssueUpdateFromTask,
  mapForgejoIssueToImportedTask,
} from "@/forgejo-fields";
import { type ForgejoIssue, type ForgejoIssueClient } from "@/forgejo-client";
import type { ForgejoAuthType } from "@/forgejo-config";
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

export type ForgejoBootstrapTaskActionKind = "link" | "update" | "skip" | "create";

export interface ForgejoBootstrapTaskAction {
  taskId: ExportedTaskInput["localTaskId"];
  title: string;
  action: ForgejoBootstrapTaskActionKind;
  issueNumber?: number;
  externalId?: string;
  reason?: string;
}

export interface ForgejoBootstrapExportResult {
  createdIssues: ForgejoIssue[];
  updatedIssues: ForgejoIssue[];
  closedIssues: ForgejoIssue[];
  createdLinks: ForgejoItemLink[];
  taskUpdates: ForgejoBootstrapTaskUpdate[];
  taskActions: ForgejoBootstrapTaskAction[];
  hydratedLinkedTasks: number;
  issueReadCount: number;
  skippedLinkedTasks: number;
  skippedIssueCreates: number;
}

export async function bootstrapForgejoIssuesToTasks(input: {
  binding: IntegrationBinding;
  baseUrl: string;
  apiBaseUrl: string;
  token?: string;
  authType?: ForgejoAuthType;
  owner: string;
  repo: string;
  issueClient: ForgejoIssueClient;
  linkStore: ForgejoItemLinkStore;
  since?: string;
  importClosedOnBootstrap?: boolean;
  previouslyDiscoveredIssueNumbers?: readonly number[];
}): Promise<ForgejoBootstrapImportResult> {
  const issues = await input.issueClient.listIssues(
    {
      baseUrl: input.baseUrl,
      apiBaseUrl: input.apiBaseUrl,
      token: input.token,
      authType: input.authType,
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
    if (
      !existingLink &&
      issue.state !== "open" &&
      !shouldImportClosedIssuesOnBootstrap &&
      !input.previouslyDiscoveredIssueNumbers?.includes(issue.number)
    ) {
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
  token?: string;
  authType?: ForgejoAuthType;
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
  const taskActions: ForgejoBootstrapTaskAction[] = [];
  let hydratedLinkedTasks = 0;
  let issueReadCount = 0;
  let skippedLinkedTasks = 0;
  let skippedIssueCreates = 0;

  const target = {
    baseUrl: input.baseUrl,
    apiBaseUrl: input.apiBaseUrl,
    token: input.token,
    authType: input.authType,
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

  const recordTaskAction = (action: ForgejoBootstrapTaskAction): void => {
    taskActions.push(action);
  };

  const linkTaskToIssue = (task: ExportedTaskInput, issue: ForgejoIssue): ForgejoItemLink => {
    const createdLink = createLinkFromTask({
      binding: input.binding,
      taskId: task.localTaskId as ForgejoItemLink["taskId"],
      baseUrl: input.baseUrl,
      owner: input.owner,
      repo: input.repo,
      issueNumber: issue.number,
      lastMirroredAt: issue.updatedAt ?? issue.createdAt,
    });
    input.linkStore.save(createdLink);
    createdLinks.push(createdLink);
    taskUpdates.push({
      taskId: task.localTaskId,
      externalId: createdLink.externalId,
      sourceUrl: issue.sourceUrl,
    });
    return createdLink;
  };

  let reconciliationIssues: ForgejoIssue[] | null = null;
  const listReconciliationIssues = async (): Promise<ForgejoIssue[]> => {
    if (!reconciliationIssues) {
      issueReadCount += 1;
      reconciliationIssues = await input.issueClient.listIssues(target);
    }

    return reconciliationIssues;
  };

  const createIssueForTask = async (task: ExportedTaskInput): Promise<boolean> => {
    if (!TASK_BOOTSTRAP_EXPORT_STATUSES.has(task.status)) {
      recordTaskAction({
        taskId: task.localTaskId,
        title: task.title,
        action: "skip",
        reason: `status ${task.status} is not exported`,
      });
      return false;
    }

    const reconciledIssue = await reconcileUnlinkedTaskToIssue(task, {
      baseUrl: input.baseUrl,
      owner: input.owner,
      repo: input.repo,
      listIssues: listReconciliationIssues,
    });

    if (reconciledIssue.kind === "ambiguous") {
      skippedIssueCreates += 1;
      recordTaskAction({
        taskId: task.localTaskId,
        title: task.title,
        action: "skip",
        reason: reconciledIssue.reason,
      });
      return false;
    }

    if (reconciledIssue.kind === "matched") {
      const createdLink = linkTaskToIssue(task, reconciledIssue.issue);
      recordTaskAction({
        taskId: task.localTaskId,
        title: task.title,
        action: "link",
        issueNumber: reconciledIssue.issue.number,
        externalId: createdLink.externalId,
        reason: reconciledIssue.reason,
      });

      if (
        shouldPushTaskUpdate(task, reconciledIssue.issue) &&
        !input.shouldSkipIssueUpdate?.(reconciledIssue.issue)
      ) {
        const issueUpdate = createForgejoIssueUpdateFromTask(task);
        await ensureLabelsExist(issueUpdate.labels ?? []);
        const updatedIssue = await input.issueClient.updateIssue(
          target,
          reconciledIssue.issue.number,
          issueUpdate
        );
        input.linkStore.save({
          ...createdLink,
          lastMirroredAt: updatedIssue.updatedAt ?? updatedIssue.createdAt,
        });
        updatedIssues.push(updatedIssue);
        recordTaskAction({
          taskId: task.localTaskId,
          title: task.title,
          action: "update",
          issueNumber: updatedIssue.number,
          externalId: createdLink.externalId,
          reason: "reconciled unlinked task before updating issue",
        });
      } else {
        skippedLinkedTasks += 1;
      }
      return true;
    }

    const issueCreate = createForgejoIssueCreateFromTask(task);
    await ensureLabelsExist(issueCreate.labels ?? []);

    let createdIssue: ForgejoIssue;
    try {
      createdIssue = await input.issueClient.createIssue(target, issueCreate);
    } catch (error) {
      if (!isForgejoIssueCreateConflictError(error)) {
        throw new Error(
          `Forgejo issue create failed for task ${String(task.localTaskId)} (${JSON.stringify(
            task.title
          )}) in ${input.owner}/${input.repo}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }

      skippedIssueCreates += 1;
      recordTaskAction({
        taskId: task.localTaskId,
        title: task.title,
        action: "skip",
        reason: `remote issue create conflict: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }

    createdIssues.push(createdIssue);
    const createdLink = linkTaskToIssue(task, createdIssue);
    recordTaskAction({
      taskId: task.localTaskId,
      title: task.title,
      action: "create",
      issueNumber: createdIssue.number,
      externalId: createdLink.externalId,
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
          recordTaskAction({
            taskId: localTaskId,
            title: task.title,
            action: "skip",
            issueNumber: existingIssue.number,
            externalId: existingLink.externalId,
            reason: "linked issue is already current",
          });
          continue;
        }

        if (input.shouldSkipIssueUpdate?.(existingIssue)) {
          recordTaskAction({
            taskId: localTaskId,
            title: task.title,
            action: "skip",
            issueNumber: existingIssue.number,
            externalId: existingLink.externalId,
            reason: "issue update skipped by loop prevention",
          });
          continue;
        }
      } else if (!shouldPushTaskUpdateFromMirroredAt(task, existingLink.lastMirroredAt)) {
        skippedLinkedTasks += 1;
        recordTaskAction({
          taskId: localTaskId,
          title: task.title,
          action: "skip",
          issueNumber: existingLink.issueNumber,
          externalId: existingLink.externalId,
          reason: "task is not newer than last mirror",
        });
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
        recordTaskAction({
          taskId: localTaskId,
          title: task.title,
          action: "update",
          issueNumber: updatedIssue.number,
          externalId: existingLink.externalId,
        });
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

      const createdLink = linkTaskToIssue(task, existingIssue);
      recordTaskAction({
        taskId: localTaskId,
        title: task.title,
        action: "link",
        issueNumber: existingIssue.number,
        externalId: createdLink.externalId,
        reason: "matched task externalId",
      });

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
        recordTaskAction({
          taskId: localTaskId,
          title: task.title,
          action: "update",
          issueNumber: updatedIssue.number,
          externalId: createdLink.externalId,
          reason: "linked task externalId before updating issue",
        });
      } else {
        skippedLinkedTasks += 1;
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
    taskActions,
    hydratedLinkedTasks,
    issueReadCount,
    skippedLinkedTasks,
    skippedIssueCreates,
  };
}

function isForgejoIssueNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b/.test(message) || /issue not found/i.test(message);
}

function isForgejoIssueCreateConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /duplicate key value violates unique constraint/i.test(message) ||
    /UQE_issue_repo_index/i.test(message) ||
    /issue.*already exists/i.test(message) ||
    /already.*issue/i.test(message)
  );
}

type ForgejoIssueReconciliationResult =
  | { kind: "none" }
  | { kind: "matched"; issue: ForgejoIssue; reason: string }
  | { kind: "ambiguous"; reason: string };

async function reconcileUnlinkedTaskToIssue(
  task: ExportedTaskInput,
  input: {
    baseUrl: string;
    owner: string;
    repo: string;
    listIssues: () => Promise<ForgejoIssue[]>;
  }
): Promise<ForgejoIssueReconciliationResult> {
  const explicitRef = getMatchingIssueReference(task, input.baseUrl, input.owner, input.repo);
  if (explicitRef) {
    const issues = await input.listIssues();
    const issue = issues.find((candidate) => candidate.number === explicitRef.issueNumber);
    if (issue) {
      return { kind: "matched", issue, reason: `matched task ${explicitRef.source}` };
    }
  }

  const issues = await input.listIssues();
  const metadataMatches = issues.filter((issue) => issueMatchesTaskCreateMetadata(task, issue));
  if (metadataMatches.length === 1) {
    return {
      kind: "matched",
      issue: metadataMatches[0],
      reason: "matched unique remote issue metadata",
    };
  }

  if (metadataMatches.length > 1) {
    return {
      kind: "ambiguous",
      reason: `found ${metadataMatches.length} remote issues with matching metadata; skipped create to avoid a duplicate`,
    };
  }

  return { kind: "none" };
}

function getMatchingIssueReference(
  task: ExportedTaskInput,
  baseUrl: string,
  owner: string,
  repo: string
): { issueNumber: number; source: "externalId" | "sourceUrl" | "localTaskId" } | null {
  const externalIdMatch = getMatchingExternalId(task, baseUrl, owner, repo);
  if (externalIdMatch) {
    return { ...externalIdMatch, source: "externalId" };
  }

  const sourceUrlMatch = getMatchingSourceUrl(task.sourceUrl, baseUrl, owner, repo);
  if (sourceUrlMatch) {
    return { ...sourceUrlMatch, source: "sourceUrl" };
  }

  const localTaskId = String(task.localTaskId);
  const importedTaskPrefix = "forgejo:";
  if (localTaskId.startsWith(importedTaskPrefix)) {
    const importedExternalId = localTaskId.slice(importedTaskPrefix.length);
    const parsed = getMatchingExternalId(
      { ...task, externalId: importedExternalId },
      baseUrl,
      owner,
      repo
    );
    if (parsed) {
      return { ...parsed, source: "localTaskId" };
    }
  }

  return null;
}

function getMatchingSourceUrl(
  sourceUrl: string | undefined,
  baseUrl: string,
  owner: string,
  repo: string
): { issueNumber: number } | null {
  if (!sourceUrl) {
    return null;
  }

  const escapedBaseUrl = escapeRegExp(baseUrl.replace(/\/+$/, ""));
  const escapedOwner = escapeRegExp(owner);
  const escapedRepo = escapeRegExp(repo);
  const match = sourceUrl.match(
    new RegExp(`^${escapedBaseUrl}/${escapedOwner}/${escapedRepo}/issues/(\\d+)(?:[#/?].*)?$`)
  );
  if (!match) {
    return null;
  }

  const issueNumber = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(issueNumber) && issueNumber > 0 ? { issueNumber } : null;
}

function issueMatchesTaskCreateMetadata(task: ExportedTaskInput, issue: ForgejoIssue): boolean {
  const expected = createForgejoIssueCreateFromTask(task);
  if (issue.isPullRequest || expected.title !== issue.title) {
    return false;
  }

  if ((expected.body ?? "") !== (issue.body ?? "")) {
    return false;
  }

  if ((expected.state ?? "open") !== issue.state) {
    return false;
  }

  return stringSetsEqual(expected.labels ?? [], issue.labels);
}

function stringSetsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
