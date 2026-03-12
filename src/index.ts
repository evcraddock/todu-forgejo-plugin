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

export const FORGEJO_PROVIDER_NAME = "forgejo";
export const FORGEJO_PROVIDER_VERSION = "0.1.0";

const DEFAULT_TIMESTAMP = new Date(0).toISOString();
const DEFAULT_PRIORITY: Task["priority"] = "medium";
const OPEN_STATUSES = new Set<Task["status"]>(["active", "inprogress", "waiting"]);

export interface ForgejoProviderState {
  initialized: boolean;
  config: SyncProviderConfig | null;
}

export interface ForgejoSyncProvider extends SyncProvider {
  getState(): ForgejoProviderState;
}

export interface CreateForgejoSyncProviderOptions {
  initialConfig?: SyncProviderConfig | null;
}

export function createForgejoSyncProvider(
  options: CreateForgejoSyncProviderOptions = {}
): ForgejoSyncProvider {
  let config = options.initialConfig ?? null;

  return {
    name: FORGEJO_PROVIDER_NAME,
    version: FORGEJO_PROVIDER_VERSION,
    async initialize(nextConfig: SyncProviderConfig): Promise<void> {
      config = nextConfig;
    },
    async shutdown(): Promise<void> {
      config = null;
    },
    async pull(_binding, _project): Promise<SyncProviderPullResult> {
      return { tasks: [] };
    },
    async push(_binding, _tasks, _project): Promise<SyncProviderPushResult> {
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
        initialized: config !== null,
        config,
      };
    },
  };
}

export function createImportedTaskId(externalId: string): Task["id"] {
  return createTaskId(`forgejo:${externalId}`);
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
