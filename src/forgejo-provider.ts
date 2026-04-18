import path from "node:path";

import {
  SYNC_PROVIDER_API_VERSION,
  type ExportedTaskInput,
  type IntegrationBinding,
  type SyncProviderConfig,
  type SyncProviderPullResultV3,
  type SyncProviderPushResult,
  type SyncProviderRegistration,
  type SyncProviderV3,
  type TaskPushPayload,
} from "@todu/core";

import {
  FORGEJO_PROVIDER_NAME,
  parseForgejoBinding,
  type ForgejoRepositoryBinding,
} from "@/forgejo-binding";
import {
  createForgejoBindingStatus,
  updateForgejoBindingStatusBlocked,
  updateForgejoBindingStatusError,
  updateForgejoBindingStatusIdle,
  updateForgejoBindingStatusRunning,
  type ForgejoBindingStatus,
} from "@/forgejo-binding-status";
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
import {
  createForgejoSyncLogger,
  type ForgejoSyncLogContext,
  type ForgejoSyncLogger,
} from "@/forgejo-logger";
import {
  createForgejoLoopPreventionStore,
  createForgejoWriteKey,
  type ForgejoLoopPreventionStore,
  type ForgejoWriteRecord,
} from "@/forgejo-loop-prevention";
import {
  createFileForgejoBindingRuntimeStore,
  createInitialForgejoRuntimeState,
  createInMemoryForgejoBindingRuntimeStore,
  recordForgejoBlocked,
  recordForgejoFailure,
  recordForgejoSuccess,
  shouldForgejoRetry,
  type ForgejoBindingRuntimeState,
  type ForgejoBindingRuntimeStore,
  type ForgejoRetryConfig,
} from "@/forgejo-runtime";

export const FORGEJO_PROVIDER_VERSION = "0.1.0";
const DEFAULT_LOOP_PREVENTION_MAX_AGE_MS = 10 * 60 * 1000;

export interface ForgejoProviderState {
  initialized: boolean;
  settings: ForgejoProviderSettings | null;
  itemLinks: ForgejoItemLink[];
  commentLinks: ForgejoCommentLink[];
  runtimeStates: ForgejoBindingRuntimeState[];
  loopPreventionWrites: ForgejoWriteRecord[];
  logEntries: ReturnType<ForgejoSyncLogger["getEntries"]>;
  lastPullResult: ForgejoBootstrapImportResult | null;
  lastPushResult: ForgejoBootstrapExportResult | null;
  bindingStatuses: Map<IntegrationBinding["id"], ForgejoBindingStatus>;
}

export interface ForgejoSyncProvider extends SyncProviderV3 {
  push(
    binding: IntegrationBinding,
    tasks: ExportedTaskInput[] | TaskPushPayload[],
    project: Parameters<SyncProviderV3["push"]>[2]
  ): Promise<SyncProviderPushResult>;
  getState(): ForgejoProviderState;
}

export interface CreateForgejoSyncProviderOptions {
  issueClient?: ForgejoIssueClient;
  linkStore?: ForgejoItemLinkStore;
  commentLinkStore?: ForgejoCommentLinkStore;
  runtimeStore?: ForgejoBindingRuntimeStore;
  loopPreventionStore?: ForgejoLoopPreventionStore;
  logger?: ForgejoSyncLogger;
  retryConfig?: ForgejoRetryConfig;
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
  let runtimeStore = options.runtimeStore ?? createInMemoryForgejoBindingRuntimeStore();
  let loopPreventionStore = options.loopPreventionStore ?? createForgejoLoopPreventionStore();
  const logger = options.logger ?? createForgejoSyncLogger();
  const retryConfig = options.retryConfig;
  const bindingStatuses = new Map<IntegrationBinding["id"], ForgejoBindingStatus>();

  const getOrCreateBindingStatus = (bindingId: IntegrationBinding["id"]): ForgejoBindingStatus => {
    let status = bindingStatuses.get(bindingId);
    if (!status) {
      status = createForgejoBindingStatus(bindingId);
      bindingStatuses.set(bindingId, status);
    }

    return status;
  };

  const getOrCreateRuntimeState = (
    bindingId: IntegrationBinding["id"]
  ): ForgejoBindingRuntimeState => {
    let state = runtimeStore.get(bindingId);
    if (!state) {
      state = createInitialForgejoRuntimeState(bindingId);
      runtimeStore.save(state);
    }

    return state;
  };

  const createLogContext = (
    binding: IntegrationBinding,
    parsedBinding: ForgejoRepositoryBinding,
    direction: "pull" | "push"
  ): ForgejoSyncLogContext => ({
    bindingId: binding.id,
    projectId: String(binding.projectId),
    repo: `${parsedBinding.owner}/${parsedBinding.repo}`,
    direction,
  });

  const requireInitializedSettings = (): ForgejoProviderSettings => {
    if (!settings) {
      throw new Error(
        "Forgejo sync provider is not initialized; call initialize() before sync operations"
      );
    }

    return settings;
  };

  const clearCommentLinksForIssue = (
    bindingId: IntegrationBinding["id"],
    issueNumber: number
  ): void => {
    for (const commentLink of commentLinkStore.listByIssue(bindingId, issueNumber)) {
      commentLinkStore.remove(bindingId, commentLink.noteId);
    }
  };

  const clearStaleIssueReferences = (input: {
    bindingId: IntegrationBinding["id"];
    issueNumber: number;
    taskId: ForgejoItemLink["taskId"];
  }): void => {
    clearCommentLinksForIssue(input.bindingId, input.issueNumber);
    linkStore.remove(input.bindingId, input.taskId);
  };

  const validateBinding = (
    binding: Parameters<SyncProviderV3["pull"]>[0]
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
      if (!options.linkStore && settings.storageDir) {
        linkStore = createFileForgejoItemLinkStore(
          path.join(settings.storageDir, "item-links.json")
        );
      }
      if (!options.commentLinkStore && settings.storageDir) {
        commentLinkStore = createFileForgejoCommentLinkStore(
          path.join(settings.storageDir, "comment-links.json")
        );
      }
      if (!options.runtimeStore && settings.storageDir) {
        runtimeStore = createFileForgejoBindingRuntimeStore(
          path.join(settings.storageDir, "runtime-state.json")
        );
      }
      if (!options.loopPreventionStore) {
        loopPreventionStore = createForgejoLoopPreventionStore();
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
      if (!options.runtimeStore) {
        runtimeStore = createInMemoryForgejoBindingRuntimeStore();
      }
      if (!options.loopPreventionStore) {
        loopPreventionStore = createForgejoLoopPreventionStore();
      }
    },
    async pull(binding, _project): Promise<SyncProviderPullResultV3> {
      const parsedBinding = validateBinding(binding);
      const currentSettings = requireInitializedSettings();
      const target = createForgejoRepositoryTarget(parsedBinding, currentSettings);
      const logContext = createLogContext(binding, parsedBinding, "pull");

      if (binding.strategy === "none" || binding.strategy === "push") {
        lastPullResult = { tasks: [], createdLinks: [], touchedIssueNumbers: [] };
        logger.debug("skipping pull due to binding strategy", logContext);
        return { tasks: [] };
      }

      const runtimeState = getOrCreateRuntimeState(binding.id);
      if (!shouldForgejoRetry(runtimeState)) {
        logger.info("skipping pull: retry backoff not elapsed", logContext);
        return { tasks: [] };
      }

      bindingStatuses.set(
        binding.id,
        updateForgejoBindingStatusRunning(getOrCreateBindingStatus(binding.id))
      );
      logger.info("pull started", logContext);

      try {
        loopPreventionStore.clearExpired(DEFAULT_LOOP_PREVENTION_MAX_AGE_MS);

        lastPullResult = await bootstrapForgejoIssuesToTasks({
          binding,
          baseUrl: target.baseUrl,
          apiBaseUrl: target.apiBaseUrl,
          owner: target.owner,
          repo: target.repo,
          issueClient,
          linkStore,
          since: runtimeState.cursor ?? runtimeState.lastSuccessAt ?? undefined,
          importClosedOnBootstrap: getImportClosedOnBootstrap(binding),
        });

        const pullCommentsResult = await pullComments({
          binding,
          issueClient,
          target,
          itemLinkStore: linkStore,
          commentLinkStore,
          issueNumbers: lastPullResult.touchedIssueNumbers,
          since: runtimeState.lastSuccessAt ?? undefined,
          onIssueError: ({ itemLink, error }) => {
            const classification = classifyForgejoSyncError(error);
            if (classification.kind !== "not-found") {
              return "throw";
            }

            clearStaleIssueReferences({
              bindingId: binding.id,
              issueNumber: itemLink.issueNumber,
              taskId: itemLink.taskId,
            });
            logger.warn("skipping comments for missing remote issue; stale links removed", {
              ...logContext,
              entityType: "issue",
              itemId: String(itemLink.issueNumber),
            });
            return "continue";
          },
        });

        const cursor = new Date().toISOString();
        runtimeStore.save(recordForgejoSuccess(runtimeState, cursor));
        bindingStatuses.set(
          binding.id,
          updateForgejoBindingStatusIdle(getOrCreateBindingStatus(binding.id))
        );

        logger.info("pull completed", {
          ...logContext,
          itemId: `${lastPullResult.tasks.length} tasks, ${pullCommentsResult.comments.length} comments`,
        });

        return { tasks: lastPullResult.tasks, comments: pullCommentsResult.comments };
      } catch (error) {
        const classification = classifyForgejoSyncError(error);
        applyFailureState({
          bindingId: binding.id,
          runtimeState,
          classification,
          logContext,
          direction: "pull",
        });
        throw error;
      }
    },
    async push(
      binding,
      tasks: ExportedTaskInput[] | TaskPushPayload[],
      _project
    ): Promise<SyncProviderPushResult> {
      const parsedBinding = validateBinding(binding);
      const currentSettings = requireInitializedSettings();
      const target = createForgejoRepositoryTarget(parsedBinding, currentSettings);
      const logContext = createLogContext(binding, parsedBinding, "push");

      if (binding.strategy === "none" || binding.strategy === "pull") {
        lastPushResult = {
          createdIssues: [],
          updatedIssues: [],
          closedIssues: [],
          createdLinks: [],
          taskUpdates: [],
          hydratedLinkedTasks: 0,
          issueReadCount: 0,
          skippedLinkedTasks: 0,
        };
        logger.debug("skipping push due to binding strategy", logContext);
        return { commentLinks: [], taskLinks: [] };
      }

      const runtimeState = getOrCreateRuntimeState(binding.id);
      if (!shouldForgejoRetry(runtimeState)) {
        logger.info("skipping push: retry backoff not elapsed", logContext);
        return { commentLinks: [], taskLinks: [] };
      }

      bindingStatuses.set(
        binding.id,
        updateForgejoBindingStatusRunning(getOrCreateBindingStatus(binding.id))
      );
      logger.info("push started", logContext);

      try {
        loopPreventionStore.clearExpired(DEFAULT_LOOP_PREVENTION_MAX_AGE_MS);

        lastPushResult = await bootstrapTasksToForgejoIssues({
          binding,
          baseUrl: target.baseUrl,
          apiBaseUrl: target.apiBaseUrl,
          owner: target.owner,
          repo: target.repo,
          tasks: tasks as ExportedTaskInput[],
          issueClient,
          linkStore,
          commentLinkStore,
          shouldSkipIssueUpdate: (issue) => {
            const issueTimestamp = issue.updatedAt ?? issue.createdAt;
            if (!issueTimestamp) {
              return false;
            }

            return loopPreventionStore.isOwnWrite(
              createForgejoWriteKey("issue", String(binding.id), String(issue.number)),
              issueTimestamp
            );
          },
        });

        for (const createdIssue of lastPushResult.createdIssues) {
          loopPreventionStore.recordWrite(
            createForgejoWriteKey("issue", String(binding.id), String(createdIssue.number)),
            createdIssue.updatedAt ?? new Date().toISOString()
          );
        }

        for (const updatedIssue of lastPushResult.updatedIssues) {
          loopPreventionStore.recordWrite(
            createForgejoWriteKey("issue", String(binding.id), String(updatedIssue.number)),
            updatedIssue.updatedAt ?? new Date().toISOString()
          );
        }

        for (const closedIssue of lastPushResult.closedIssues) {
          loopPreventionStore.recordWrite(
            createForgejoWriteKey("issue", String(binding.id), String(closedIssue.number)),
            closedIssue.updatedAt ?? new Date().toISOString()
          );
        }

        const pushCommentsResult = await pushComments({
          binding,
          issueClient,
          target,
          tasks: tasks as ExportedTaskInput[],
          itemLinkStore: linkStore,
          commentLinkStore,
        });

        for (const createdComment of pushCommentsResult.createdComments) {
          loopPreventionStore.recordWrite(
            createForgejoWriteKey("comment", String(binding.id), String(createdComment.id)),
            createdComment.updatedAt ?? createdComment.createdAt
          );
        }

        for (const updatedComment of pushCommentsResult.updatedComments) {
          loopPreventionStore.recordWrite(
            createForgejoWriteKey("comment", String(binding.id), String(updatedComment.id)),
            updatedComment.updatedAt ?? updatedComment.createdAt
          );
        }

        const cursor = new Date().toISOString();
        runtimeStore.save(recordForgejoSuccess(runtimeState, cursor));
        bindingStatuses.set(
          binding.id,
          updateForgejoBindingStatusIdle(getOrCreateBindingStatus(binding.id))
        );

        logger.info("push completed", {
          ...logContext,
          itemId:
            `${lastPushResult.createdIssues.length} created, ` +
            `${lastPushResult.updatedIssues.length} updated, ` +
            `${lastPushResult.closedIssues.length} closed, ` +
            `${lastPushResult.skippedLinkedTasks} skipped, ` +
            `${lastPushResult.issueReadCount} issue reads, ` +
            `${pushCommentsResult.createdComments.length} comment creates, ` +
            `${pushCommentsResult.updatedComments.length} comment updates`,
        });

        return {
          commentLinks: pushCommentsResult.commentLinks,
          taskLinks: lastPushResult.taskUpdates.map((update) => ({
            localTaskId: update.taskId as never,
            externalId: update.externalId,
            sourceUrl: update.sourceUrl,
          })),
        };
      } catch (error) {
        const classification = classifyForgejoSyncError(error);
        applyFailureState({
          bindingId: binding.id,
          runtimeState,
          classification,
          logContext,
          direction: "push",
        });
        throw error;
      }
    },
    getState(): ForgejoProviderState {
      return {
        initialized: settings !== null,
        settings,
        itemLinks: linkStore.listAll(),
        commentLinks: commentLinkStore.listAll(),
        runtimeStates: runtimeStore.listAll(),
        loopPreventionWrites: loopPreventionStore.listAll(),
        logEntries: logger.getEntries(),
        lastPullResult,
        lastPushResult,
        bindingStatuses: new Map(bindingStatuses),
      };
    },
  };

  function applyFailureState(input: {
    bindingId: IntegrationBinding["id"];
    runtimeState: ForgejoBindingRuntimeState;
    classification: ForgejoSyncErrorClassification;
    logContext: ForgejoSyncLogContext;
    direction: "pull" | "push";
  }): void {
    const { classification, runtimeState, bindingId, logContext } = input;
    const status = getOrCreateBindingStatus(bindingId);

    if (classification.retryable) {
      runtimeStore.save(recordForgejoFailure(runtimeState, classification.summary, retryConfig));
      bindingStatuses.set(
        bindingId,
        updateForgejoBindingStatusError(status, classification.summary)
      );
      logger.error(`${input.direction} failed`, logContext, classification.summary);
      return;
    }

    runtimeStore.save(recordForgejoBlocked(runtimeState, classification.summary));
    bindingStatuses.set(
      bindingId,
      updateForgejoBindingStatusBlocked(status, classification.summary)
    );
    logger.warn(`${input.direction} blocked`, logContext);
  }
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

export interface ForgejoSyncErrorClassification {
  kind: "auth" | "permission" | "not-found" | "rate-limit" | "server" | "transport" | "unknown";
  retryable: boolean;
  summary: string;
}

export function getImportClosedOnBootstrap(binding: IntegrationBinding): boolean {
  return binding.options?.importClosedOnBootstrap === true;
}

export function classifyForgejoSyncError(error: unknown): ForgejoSyncErrorClassification {
  const message = error instanceof Error ? error.message : String(error);

  if (/\b401\b/.test(message)) {
    return { kind: "auth", retryable: false, summary: `authentication failed: ${message}` };
  }

  if (/\b403\b/.test(message)) {
    return { kind: "permission", retryable: false, summary: `permission denied: ${message}` };
  }

  if (/\b404\b/.test(message)) {
    return { kind: "not-found", retryable: false, summary: `resource not found: ${message}` };
  }

  if (/\b429\b/.test(message) || /rate limit/i.test(message)) {
    return { kind: "rate-limit", retryable: true, summary: `rate limited: ${message}` };
  }

  if (/\b5\d\d\b/.test(message)) {
    return { kind: "server", retryable: true, summary: `server error: ${message}` };
  }

  if (/(network|fetch failed|timed out|timeout|econn|socket|enotfound|eai_again)/i.test(message)) {
    return { kind: "transport", retryable: true, summary: `transport error: ${message}` };
  }

  return { kind: "unknown", retryable: true, summary: message };
}
