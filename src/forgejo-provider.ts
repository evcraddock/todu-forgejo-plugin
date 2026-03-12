import {
  SYNC_PROVIDER_API_VERSION,
  createTaskId,
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
import { type ForgejoIssueClient } from "@/forgejo-client";
import { createInMemoryForgejoIssueClient, type ForgejoRepositoryTarget } from "@/forgejo-client";
import { loadForgejoProviderSettings, type ForgejoProviderSettings } from "@/forgejo-config";
import { createHttpForgejoIssueClient } from "@/forgejo-http-client";

export const FORGEJO_PROVIDER_VERSION = "0.1.0";

const DEFAULT_TIMESTAMP = new Date(0).toISOString();
const DEFAULT_PRIORITY: Task["priority"] = "medium";
const OPEN_STATUSES = new Set<Task["status"]>(["active", "inprogress", "waiting"]);

export interface ForgejoProviderState {
  initialized: boolean;
  settings: ForgejoProviderSettings | null;
}

export interface ForgejoSyncProvider extends SyncProvider {
  getState(): ForgejoProviderState;
}

export interface CreateForgejoSyncProviderOptions {
  issueClient?: ForgejoIssueClient;
  initialConfig?: SyncProviderConfig | null;
}

export function createImportedTaskId(externalId: string): Task["id"] {
  return createTaskId(`forgejo:${externalId}`);
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
  let issueClient: ForgejoIssueClient = options.issueClient ?? createInMemoryForgejoIssueClient();

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
    },
    async shutdown(): Promise<void> {
      settings = null;
      if (!options.issueClient) {
        issueClient = createInMemoryForgejoIssueClient();
      }
    },
    async pull(binding, _project): Promise<SyncProviderPullResult> {
      const parsedBinding = validateBinding(binding);
      void createForgejoRepositoryTarget(parsedBinding, requireInitializedSettings());
      void issueClient;
      return { tasks: [] };
    },
    async push(binding, _tasks, _project): Promise<SyncProviderPushResult> {
      const parsedBinding = validateBinding(binding);
      void createForgejoRepositoryTarget(parsedBinding, requireInitializedSettings());
      void issueClient;
      return { commentLinks: [], taskLinks: [] };
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
