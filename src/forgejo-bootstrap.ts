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
import { getNormalForgejoLabels } from "@/forgejo-fields";
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

  for (const issue of issues) {
    if (issue.isPullRequest) {
      continue;
    }

    const existingLink = input.linkStore.getByIssueNumber(input.binding.id, issue.number);
    if (!existingLink && issue.state !== "open") {
      continue;
    }

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
}): Promise<ForgejoBootstrapExportResult> {
  const createdIssues: ForgejoIssue[] = [];
  const updatedIssues: ForgejoIssue[] = [];
  const createdLinks: ForgejoItemLink[] = [];
  const taskUpdates: ForgejoBootstrapTaskUpdate[] = [];

  const target = {
    baseUrl: input.baseUrl,
    apiBaseUrl: input.apiBaseUrl,
    owner: input.owner,
    repo: input.repo,
  };

  const ensureLabelsExist = async (labels: string[]): Promise<void> => {
    const normalLabels = getNormalForgejoLabels(labels);
    const existingLabels = new Set(await input.issueClient.listLabels(target));

    for (const label of normalLabels) {
      if (!existingLabels.has(label)) {
        await input.issueClient.createLabel(target, label);
        existingLabels.add(label);
      }
    }
  };

  for (const task of input.tasks) {
    const existingLink = input.linkStore.getByTaskId(input.binding.id, task.id);
    if (existingLink) {
      const existingIssue = await input.issueClient.getIssue(target, existingLink.issueNumber);
      task.externalId = existingLink.externalId;
      task.sourceUrl = existingIssue?.sourceUrl ?? task.sourceUrl;

      if (shouldPushTaskUpdate(task, existingIssue)) {
        const issueUpdate = createForgejoIssueUpdateFromTask(task);
        await ensureLabelsExist(issueUpdate.labels ?? []);
        const updatedIssue = await input.issueClient.updateIssue(
          target,
          existingLink.issueNumber,
          issueUpdate
        );
        task.sourceUrl = updatedIssue.sourceUrl;
        updatedIssues.push(updatedIssue);
      }
      continue;
    }

    const matchingExternalId = getMatchingExternalId(task, input.baseUrl, input.owner, input.repo);
    if (matchingExternalId) {
      const createdLink = createLinkFromTask({
        binding: input.binding,
        taskId: task.id,
        baseUrl: input.baseUrl,
        owner: input.owner,
        repo: input.repo,
        issueNumber: matchingExternalId.issueNumber,
      });
      task.externalId = createdLink.externalId;
      task.sourceUrl ??= createForgejoIssueSourceUrl(target, matchingExternalId.issueNumber);
      input.linkStore.save(createdLink);
      createdLinks.push(createdLink);

      const existingIssue = await input.issueClient.getIssue(
        target,
        matchingExternalId.issueNumber
      );
      if (shouldPushTaskUpdate(task, existingIssue)) {
        const issueUpdate = createForgejoIssueUpdateFromTask(task);
        await ensureLabelsExist(issueUpdate.labels ?? []);
        const updatedIssue = await input.issueClient.updateIssue(
          target,
          matchingExternalId.issueNumber,
          issueUpdate
        );
        task.sourceUrl = updatedIssue.sourceUrl;
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
  };
}

function shouldPushTaskUpdate(task: TaskPushPayload, issue: ForgejoIssue | null): boolean {
  if (!issue?.updatedAt) {
    return true;
  }

  const taskUpdatedAt = Date.parse(task.updatedAt);
  const issueUpdatedAt = Date.parse(issue.updatedAt);

  if (Number.isNaN(taskUpdatedAt) || Number.isNaN(issueUpdatedAt)) {
    return true;
  }

  return taskUpdatedAt >= issueUpdatedAt;
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
