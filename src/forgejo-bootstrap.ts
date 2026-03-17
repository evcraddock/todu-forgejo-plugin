import type { ExternalTask, IntegrationBinding, TaskPushPayload } from "@todu/core";

import {
  createForgejoIssueSourceUrl,
  type ForgejoIssue,
  type ForgejoIssueClient,
} from "@/forgejo-client";
import {
  createForgejoIssueCreateFromTask,
  createForgejoIssueUpdateFromTask,
  mapForgejoIssueToExternalTask,
} from "@/forgejo-fields";
import { parseForgejoIssueExternalId } from "@/forgejo-ids";
import {
  createLinkFromIssue,
  createLinkFromTask,
  type ForgejoItemLink,
  type ForgejoItemLinkStore,
} from "@/forgejo-links";

const TASK_BOOTSTRAP_EXPORT_STATUSES = new Set<TaskPushPayload["status"]>([
  "active",
  "inprogress",
  "waiting",
]);

export interface ForgejoBootstrapImportResult {
  tasks: ExternalTask[];
  createdLinks: ForgejoItemLink[];
}

export interface ForgejoBootstrapTaskUpdate {
  taskId: TaskPushPayload["id"];
  externalId: string;
  sourceUrl?: string;
}

export interface ForgejoBootstrapExportResult {
  createdIssues: ForgejoIssue[];
  updatedIssues: ForgejoIssue[];
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

  const tasks: ExternalTask[] = [];
  const createdLinks: ForgejoItemLink[] = [];
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

    tasks.push(mapForgejoIssueToExternalTask(issue));
  }

  return {
    tasks,
    createdLinks,
  };
}

export async function bootstrapTasksToForgejoIssues(input: {
  binding: IntegrationBinding;
  baseUrl: string;
  apiBaseUrl: string;
  owner: string;
  repo: string;
  tasks: TaskPushPayload[];
  issueClient: ForgejoIssueClient;
  linkStore: ForgejoItemLinkStore;
  shouldSkipIssueUpdate?: (issue: ForgejoIssue) => boolean;
}): Promise<ForgejoBootstrapExportResult> {
  const createdIssues: ForgejoIssue[] = [];
  const updatedIssues: ForgejoIssue[] = [];
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

  for (const task of input.tasks) {
    const existingLink = input.linkStore.getByTaskId(input.binding.id, task.id);
    if (existingLink) {
      task.externalId = existingLink.externalId;
      task.sourceUrl ??= createForgejoIssueSourceUrl(target, existingLink.issueNumber);

      if (!existingLink.lastMirroredAt) {
        issueReadCount += 1;
        const existingIssue = await input.issueClient.getIssue(target, existingLink.issueNumber);
        hydratedLinkedTasks += 1;
        task.sourceUrl = existingIssue?.sourceUrl ?? task.sourceUrl;

        if (existingIssue) {
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
        }
      } else if (!shouldPushTaskUpdateFromMirroredAt(task, existingLink.lastMirroredAt)) {
        skippedLinkedTasks += 1;
        continue;
      }

      const issueUpdate = createForgejoIssueUpdateFromTask(task);
      await ensureLabelsExist(issueUpdate.labels ?? []);
      const updatedIssue = await input.issueClient.updateIssue(
        target,
        existingLink.issueNumber,
        issueUpdate
      );
      task.sourceUrl = updatedIssue.sourceUrl;
      input.linkStore.save({
        ...existingLink,
        lastMirroredAt: updatedIssue.updatedAt ?? updatedIssue.createdAt,
      });
      updatedIssues.push(updatedIssue);
      continue;
    }

    const matchingExternalId = getMatchingExternalId(task, input.baseUrl, input.owner, input.repo);
    if (matchingExternalId) {
      issueReadCount += 1;
      const existingIssue = await input.issueClient.getIssue(
        target,
        matchingExternalId.issueNumber
      );
      const createdLink = createLinkFromTask({
        binding: input.binding,
        taskId: task.id,
        baseUrl: input.baseUrl,
        owner: input.owner,
        repo: input.repo,
        issueNumber: matchingExternalId.issueNumber,
        lastMirroredAt: existingIssue?.updatedAt ?? existingIssue?.createdAt,
      });
      task.externalId = createdLink.externalId;
      task.sourceUrl ??=
        existingIssue?.sourceUrl ??
        createForgejoIssueSourceUrl(target, matchingExternalId.issueNumber);
      input.linkStore.save(createdLink);
      createdLinks.push(createdLink);

      if (
        shouldPushTaskUpdate(task, existingIssue) &&
        !(existingIssue && input.shouldSkipIssueUpdate?.(existingIssue))
      ) {
        const issueUpdate = createForgejoIssueUpdateFromTask(task);
        await ensureLabelsExist(issueUpdate.labels ?? []);
        const updatedIssue = await input.issueClient.updateIssue(
          target,
          matchingExternalId.issueNumber,
          issueUpdate
        );
        task.sourceUrl = updatedIssue.sourceUrl;
        input.linkStore.save({
          ...createdLink,
          lastMirroredAt: updatedIssue.updatedAt ?? updatedIssue.createdAt,
        });
        updatedIssues.push(updatedIssue);
      }
      continue;
    }

    if (!TASK_BOOTSTRAP_EXPORT_STATUSES.has(task.status)) {
      continue;
    }

    const issueCreate = createForgejoIssueCreateFromTask(task);
    await ensureLabelsExist(issueCreate.labels ?? []);
    const createdIssue = await input.issueClient.createIssue(target, issueCreate);

    createdIssues.push(createdIssue);

    const createdLink = createLinkFromTask({
      binding: input.binding,
      taskId: task.id,
      baseUrl: input.baseUrl,
      owner: input.owner,
      repo: input.repo,
      issueNumber: createdIssue.number,
      lastMirroredAt: createdIssue.updatedAt ?? createdIssue.createdAt,
    });
    task.externalId = createdLink.externalId;
    task.sourceUrl = createdIssue.sourceUrl;
    input.linkStore.save(createdLink);
    createdLinks.push(createdLink);
    taskUpdates.push({
      taskId: task.id,
      externalId: createdLink.externalId,
      sourceUrl: createdIssue.sourceUrl,
    });
  }

  return {
    createdIssues,
    updatedIssues,
    createdLinks,
    taskUpdates,
    hydratedLinkedTasks,
    issueReadCount,
    skippedLinkedTasks,
  };
}

function shouldPushTaskUpdate(task: TaskPushPayload, issue: ForgejoIssue | null): boolean {
  if (!issue) {
    return true;
  }

  if (issueMatchesTask(task, issue)) {
    return false;
  }

  return shouldPushTaskUpdateFromMirroredAt(task, issue.updatedAt ?? issue.createdAt);
}

function shouldPushTaskUpdateFromMirroredAt(
  task: TaskPushPayload,
  lastMirroredAt: string | undefined
): boolean {
  if (!lastMirroredAt) {
    return true;
  }

  const taskUpdatedAt = Date.parse(task.updatedAt);
  const issueUpdatedAt = Date.parse(lastMirroredAt);

  if (Number.isNaN(taskUpdatedAt) || Number.isNaN(issueUpdatedAt)) {
    return true;
  }

  return taskUpdatedAt > issueUpdatedAt;
}

function issueMatchesTask(task: TaskPushPayload, issue: ForgejoIssue): boolean {
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

  return true;
}

function getMatchingExternalId(
  task: TaskPushPayload,
  baseUrl: string,
  owner: string,
  repo: string
): { issueNumber: number } | null {
  if (!task.externalId) {
    return null;
  }

  try {
    const parsedExternalId = parseForgejoIssueExternalId(task.externalId);
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
