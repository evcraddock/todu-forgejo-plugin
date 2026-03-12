import path from "node:path";

import {
  SYNC_PROVIDER_API_VERSION,
  type ExternalTask,
  type Project,
  type SyncProvider,
  type SyncProviderConfig,
  type SyncProviderPullResult,
  type SyncProviderPushResult,
  type SyncProviderRegistration,
  type Task,
  type TaskPushPayload,
} from "@todu/core";

import {
  FORGEJO_PROVIDER_NAME,
  parseForgejoBinding,
  type ForgejoRepositoryBinding,
} from "@/forgejo-binding";
import {
  bootstrapForgejoIssuesToTasks,
  bootstrapTasksToForgejoIssues,
  type ForgejoBootstrapExportResult,
  type ForgejoBootstrapImportResult,
} from "@/forgejo-bootstrap";
import {
  createFileForgejoCommentLinkStore,
  createInMemoryForgejoCommentLinkStore,
  type ForgejoCommentLink,
  type ForgejoCommentLinkStore,
} from "@/forgejo-comment-links";
import { pullComments, pushComments } from "@/forgejo-comments";
import {
  createInMemoryForgejoIssueClient,
  type ForgejoIssueClient,
  type ForgejoRepositoryTarget,
} from "@/forgejo-client";
import { loadForgejoProviderSettings, type ForgejoProviderSettings } from "@/forgejo-config";
import { createHttpForgejoIssueClient } from "@/forgejo-http-client";
import {
  createFileForgejoItemLinkStore,
  createInMemoryForgejoItemLinkStore,
  type ForgejoItemLink,
  type ForgejoItemLinkStore,
} from "@/forgejo-links";
import { createImportedTaskId } from "@/forgejo-ids";

export const FORGEJO_PROVIDER_VERSION = "0.1.0";

const DEFAULT_TIMESTAMP = new Date(0).toISOString();
const DEFAULT_PRIORITY: Task["priority"] = "medium";
const OPEN_STATUSES = new Set<Task["status"]>(["active", "inprogress", "waiting"]);

export interface ForgejoProviderState {
  initialized: boolean;
  settings: ForgejoProviderSettings | null;
  itemLinks: ForgejoItemLink[];
  commentLinks: ForgejoCommentLink[];
  lastPullResult: ForgejoBootstrapImportResult | null;
  lastPushResult: ForgejoBootstrapExportResult | null;
}

export interface ForgejoSyncProvider extends SyncProvider {
  getState(): ForgejoProviderState;
}

export interface CreateForgejoSyncProviderOptions {
  issueClient?: ForgejoIssueClient;
  linkStore?: ForgejoItemLinkStore;
  commentLinkStore?: ForgejoCommentLinkStore;
  initialConfig?: SyncProviderConfig | null;
}

export function createForgejoRepositoryTarget(
  parsedBinding: ForgejoRepositoryBinding,
  settings: ForgejoProviderSettings
): ForgejoRepositoryTarget {
  return {
    owner: parsedBinding.owner,
    repo: parsedBinding.repo,
    baseUrl: settings.baseUrl,
    apiBaseUrl: settings.apiBaseUrl,
  };
}

export function createForgejoSyncProvider(
  options: CreateForgejoSyncProviderOptions = {}
): ForgejoSyncProvider {
  let settings = options.initialConfig ? loadForgejoProviderSettings(options.initialConfig) : null;
  let lastPullResult: ForgejoBootstrapImportResult | null = null;
  let lastPushResult: ForgejoBootstrapExportResult | null = null;
  let issueClient: ForgejoIssueClient = options.issueClient ?? createInMemoryForgejoIssueClient();
  let linkStore = options.linkStore ?? createInMemoryForgejoItemLinkStore();
  let commentLinkStore = options.commentLinkStore ?? createInMemoryForgejoCommentLinkStore();

  const requireInitializedSettings = (): ForgejoProviderSettings => {
    if (!settings) {
      throw new Error(
        "Forgejo sync provider is not initialized; call initialize() before sync operations"
      );
    }

    return settings;
  };

  const validateBinding = (
    binding: Parameters<SyncProvider["pull"]>[0]
  ): ForgejoRepositoryBinding => {
    requireInitializedSettings();
    return parseForgejoBinding(binding);
  };

  return {
    name: FORGEJO_PROVIDER_NAME,
    version: FORGEJO_PROVIDER_VERSION,
    async initialize(config: SyncProviderConfig): Promise<void> {
      settings = loadForgejoProviderSettings(config);
      if (!options.issueClient) {
        issueClient = createHttpForgejoIssueClient(settings.token, {
          authType: settings.authType,
        });
      }
      if (!options.linkStore) {
        linkStore = createFileForgejoItemLinkStore(
          path.join(settings.storageDir, "item-links.json")
        );
      }
      if (!options.commentLinkStore) {
        commentLinkStore = createFileForgejoCommentLinkStore(
          path.join(settings.storageDir, "comment-links.json")
        );
      }
    },
    async shutdown(): Promise<void> {
      settings = null;
      lastPullResult = null;
      lastPushResult = null;
      if (!options.issueClient) {
        issueClient = createInMemoryForgejoIssueClient();
      }
      if (!options.linkStore) {
        linkStore = createInMemoryForgejoItemLinkStore();
      }
      if (!options.commentLinkStore) {
        commentLinkStore = createInMemoryForgejoCommentLinkStore();
      }
    },
    async pull(binding, _project): Promise<SyncProviderPullResult> {
      const parsedBinding = validateBinding(binding);
      const currentSettings = requireInitializedSettings();
      const target = createForgejoRepositoryTarget(parsedBinding, currentSettings);

      if (binding.strategy === "none" || binding.strategy === "push") {
        lastPullResult = { tasks: [], createdLinks: [] };
        return { tasks: [] };
      }

      lastPullResult = await bootstrapForgejoIssuesToTasks({
        binding,
        baseUrl: target.baseUrl,
        apiBaseUrl: target.apiBaseUrl,
        owner: target.owner,
        repo: target.repo,
        issueClient,
        linkStore,
      });

      const pullCommentsResult = await pullComments({
        binding,
        issueClient,
        target,
        itemLinkStore: linkStore,
        commentLinkStore,
      });

      return { tasks: lastPullResult.tasks, comments: pullCommentsResult.comments };
    },
    async push(binding, tasks, _project): Promise<SyncProviderPushResult> {
      const parsedBinding = validateBinding(binding);
      const currentSettings = requireInitializedSettings();
      const target = createForgejoRepositoryTarget(parsedBinding, currentSettings);

      if (binding.strategy === "none" || binding.strategy === "pull") {
        lastPushResult = {
          createdIssues: [],
          updatedIssues: [],
          createdLinks: [],
          taskUpdates: [],
        };
        return { commentLinks: [], taskLinks: [] };
      }

      lastPushResult = await bootstrapTasksToForgejoIssues({
        binding,
        baseUrl: target.baseUrl,
        apiBaseUrl: target.apiBaseUrl,
        owner: target.owner,
        repo: target.repo,
        tasks,
        issueClient,
        linkStore,
      });

      const pushCommentsResult = await pushComments({
        binding,
        issueClient,
        target,
        tasks,
        itemLinkStore: linkStore,
        commentLinkStore,
      });

      const pushResult = lastPushResult;

      return {
        commentLinks: pushCommentsResult.commentLinks,
        taskLinks: pushResult.createdLinks.map((link) => ({
          localTaskId: link.taskId,
          externalId: link.externalId,
          sourceUrl: pushResult.taskUpdates.find((update) => update.taskId === link.taskId)
            ?.sourceUrl,
        })),
      };
    },
    mapToTask(external: ExternalTask, project: Project): Task {
      return {
        id: createImportedTaskId(external.externalId),
        title: external.title,
        status: normalizeTaskStatus(external.status),
        priority: normalizeTaskPriority(external.priority),
        projectId: project.id,
        labels: [...(external.labels ?? [])],
        assignees: [...(external.assignees ?? [])],
        externalId: external.externalId,
        sourceUrl: external.sourceUrl,
        createdAt: external.createdAt ?? external.updatedAt ?? DEFAULT_TIMESTAMP,
        updatedAt: external.updatedAt ?? external.createdAt ?? DEFAULT_TIMESTAMP,
      };
    },
    mapFromTask(task: TaskPushPayload): ExternalTask {
      return {
        externalId: task.externalId ?? String(task.id),
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        labels: [...task.labels],
        assignees: [...task.assignees],
        sourceUrl: task.sourceUrl,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };
    },
    getState(): ForgejoProviderState {
      return {
        initialized: settings !== null,
        settings,
        itemLinks: linkStore.listAll(),
        commentLinks: commentLinkStore.listAll(),
        lastPullResult,
        lastPushResult,
      };
    },
  };
}

export const forgejoProvider = createForgejoSyncProvider();

export const syncProvider: SyncProviderRegistration = {
  manifest: {
    name: FORGEJO_PROVIDER_NAME,
    version: FORGEJO_PROVIDER_VERSION,
    apiVersion: SYNC_PROVIDER_API_VERSION,
  },
  provider: forgejoProvider,
};

function normalizeTaskStatus(status: string | undefined): Task["status"] {
  if (status === "done" || status === "canceled") {
    return status;
  }

  if (status && OPEN_STATUSES.has(status as Task["status"])) {
    return status as Task["status"];
  }

  return "active";
}

function normalizeTaskPriority(priority: string | undefined): Task["priority"] {
  if (priority === "low" || priority === "medium" || priority === "high") {
    return priority;
  }

  return DEFAULT_PRIORITY;
}
