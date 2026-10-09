import fs from "node:fs";
import path from "node:path";

import type { IntegrationBinding } from "@todu/core";

export type ForgejoRuntimeFailurePhase =
  | "pull:issues"
  | "pull:comments"
  | "push:issues"
  | "push:comments";

export interface ForgejoBindingRuntimeState {
  bindingId: IntegrationBinding["id"];
  checkpointVersion: 1;
  issuePullCursor: string | null;
  commentPullCursor: string | null;
  lastPushSuccessAt: string | null;
  legacyCheckpoint: { cursor: string | null; lastSuccessAt: string | null } | null;
  retryAttempt: number;
  nextRetryAt: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastProgressAt: string | null;
  lastFailurePhase: ForgejoRuntimeFailurePhase | null;
  lastFailureCursor: string | null;
  pendingCommentIssueNumbers: number[];
}

export interface ForgejoRuntimeFailureProgress {
  phase: ForgejoRuntimeFailurePhase;
  cursor?: string | null;
  progressAt?: string | null;
  pendingCommentIssueNumbers?: number[];
}

export interface ForgejoBindingRuntimeStore {
  get(bindingId: IntegrationBinding["id"]): ForgejoBindingRuntimeState | null;
  save(state: ForgejoBindingRuntimeState): void;
  remove(bindingId: IntegrationBinding["id"]): void;
  listAll(): ForgejoBindingRuntimeState[];
}

export interface ForgejoRetryConfig {
  initialSeconds: number;
  maxSeconds: number;
}

const DEFAULT_RETRY_CONFIG: ForgejoRetryConfig = {
  initialSeconds: 5,
  maxSeconds: 300,
};

const DEFAULT_BLOCKED_RETRY_CONFIG: ForgejoRetryConfig = {
  initialSeconds: 3600,
  maxSeconds: 3600,
};

export function createInitialForgejoRuntimeState(
  bindingId: IntegrationBinding["id"]
): ForgejoBindingRuntimeState {
  return {
    bindingId,
    checkpointVersion: 1,
    issuePullCursor: null,
    commentPullCursor: null,
    lastPushSuccessAt: null,
    legacyCheckpoint: null,
    retryAttempt: 0,
    nextRetryAt: null,
    lastError: null,
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastProgressAt: null,
    lastFailurePhase: null,
    lastFailureCursor: null,
    pendingCommentIssueNumbers: [],
  };
}

export function computeNextForgejoRetryDelay(
  attempt: number,
  config: ForgejoRetryConfig = DEFAULT_RETRY_CONFIG
): number {
  if (attempt <= 0) {
    return 0;
  }

  return Math.min(config.initialSeconds * Math.pow(2, attempt - 1), config.maxSeconds);
}

export function recordForgejoPullSuccess(
  state: ForgejoBindingRuntimeState,
  cursor: string,
  now: Date = new Date()
): ForgejoBindingRuntimeState {
  return {
    ...state,
    issuePullCursor: cursor,
    commentPullCursor: cursor,
    retryAttempt: 0,
    nextRetryAt: null,
    lastError: null,
    lastSuccessAt: now.toISOString(),
    lastAttemptAt: now.toISOString(),
    lastProgressAt: now.toISOString(),
    lastFailurePhase: null,
    lastFailureCursor: null,
    pendingCommentIssueNumbers: [],
  };
}

export function recordForgejoPushSuccess(
  state: ForgejoBindingRuntimeState,
  now: Date = new Date()
): ForgejoBindingRuntimeState {
  const successState = {
    ...state,
    lastPushSuccessAt: now.toISOString(),
    lastSuccessAt: now.toISOString(),
    lastAttemptAt: now.toISOString(),
  };
  // A write cannot repair a failed read or discharge pending comment work.
  if (state.lastFailurePhase?.startsWith("pull:") || state.pendingCommentIssueNumbers.length > 0) {
    return successState;
  }

  return {
    ...successState,
    retryAttempt: 0,
    nextRetryAt: null,
    lastError: null,
    lastProgressAt: now.toISOString(),
    lastFailurePhase: null,
    lastFailureCursor: null,
  };
}

export function recordForgejoFailure(
  state: ForgejoBindingRuntimeState,
  error: string,
  config: ForgejoRetryConfig = DEFAULT_RETRY_CONFIG,
  now: Date = new Date(),
  progress?: ForgejoRuntimeFailureProgress
): ForgejoBindingRuntimeState {
  const nextAttempt = state.retryAttempt + 1;
  const delaySeconds = computeNextForgejoRetryDelay(nextAttempt, config);
  const nextRetryAt = new Date(now.getTime() + delaySeconds * 1000);
  const isPullFailure = progress?.phase.startsWith("pull:") ?? true;
  const cursor =
    isPullFailure && progress && "cursor" in progress
      ? (progress.cursor ?? null)
      : state.issuePullCursor;
  const pendingCommentIssueNumbers =
    progress?.pendingCommentIssueNumbers ?? state.pendingCommentIssueNumbers ?? [];

  return {
    ...state,
    issuePullCursor: cursor,
    retryAttempt: nextAttempt,
    nextRetryAt: nextRetryAt.toISOString(),
    lastError: error,
    lastAttemptAt: now.toISOString(),
    lastProgressAt: progress?.progressAt ?? state.lastProgressAt ?? null,
    lastFailurePhase: progress?.phase ?? null,
    lastFailureCursor: isPullFailure ? cursor : null,
    pendingCommentIssueNumbers: [...new Set(pendingCommentIssueNumbers)],
  };
}

export function recordForgejoBlocked(
  state: ForgejoBindingRuntimeState,
  error: string,
  config: ForgejoRetryConfig = DEFAULT_BLOCKED_RETRY_CONFIG,
  now: Date = new Date(),
  progress?: ForgejoRuntimeFailureProgress
): ForgejoBindingRuntimeState {
  return recordForgejoFailure(state, error, config, now, progress);
}

export function shouldForgejoRetry(
  state: ForgejoBindingRuntimeState,
  now: Date = new Date()
): boolean {
  if (state.retryAttempt === 0) {
    return true;
  }

  if (!state.nextRetryAt) {
    return true;
  }

  const nextRetryTime = Date.parse(state.nextRetryAt);
  if (Number.isNaN(nextRetryTime)) {
    return true;
  }

  return now.getTime() >= nextRetryTime;
}

export function createInMemoryForgejoBindingRuntimeStore(): ForgejoBindingRuntimeStore {
  const states = new Map<IntegrationBinding["id"], ForgejoBindingRuntimeState>();

  return {
    get(bindingId): ForgejoBindingRuntimeState | null {
      const state = states.get(bindingId);
      return state ? { ...state } : null;
    },
    save(state): void {
      states.set(state.bindingId, { ...state });
    },
    remove(bindingId): void {
      states.delete(bindingId);
    },
    listAll(): ForgejoBindingRuntimeState[] {
      return [...states.values()].map((state) => ({ ...state }));
    },
  };
}

export function createFileForgejoBindingRuntimeStore(
  storagePath: string
): ForgejoBindingRuntimeStore {
  const readStates = (): ForgejoBindingRuntimeState[] => {
    if (!fs.existsSync(storagePath)) {
      return [];
    }

    const rawContent = fs.readFileSync(storagePath, "utf8");
    if (!rawContent.trim()) {
      return [];
    }

    const parsedContent = JSON.parse(rawContent) as unknown;
    if (!Array.isArray(parsedContent)) {
      throw new Error(`Invalid Forgejo runtime store at ${storagePath}: expected JSON array`);
    }

    return parsedContent.map((entry) => {
      if (!entry || typeof entry !== "object") {
        throw new Error(`Invalid Forgejo runtime store at ${storagePath}: invalid state record`);
      }

      const { cursor, ...state } = entry as Partial<ForgejoBindingRuntimeState> & {
        bindingId: IntegrationBinding["id"];
        cursor?: string | null;
      };
      if (state.checkpointVersion !== undefined && state.checkpointVersion !== 1) {
        throw new Error(
          `Invalid Forgejo runtime store at ${storagePath}: unsupported checkpoint version`
        );
      }
      const isLegacy = state.checkpointVersion === undefined;
      if (!isLegacy) {
        for (const field of [
          "issuePullCursor",
          "commentPullCursor",
          "lastPushSuccessAt",
        ] as const) {
          const value = state[field];
          if (
            value !== null &&
            (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
          ) {
            throw new Error(`Invalid Forgejo runtime store at ${storagePath}: invalid ${field}`);
          }
        }
      }

      return {
        ...createInitialForgejoRuntimeState(state.bindingId),
        ...state,
        checkpointVersion: 1,
        // Legacy success could have been a push. Archive it, but reread remote data
        // rather than promoting an ambiguous write timestamp to read progress.
        issuePullCursor: isLegacy ? null : state.issuePullCursor!,
        commentPullCursor: isLegacy ? null : state.commentPullCursor!,
        lastPushSuccessAt: isLegacy ? null : state.lastPushSuccessAt!,
        legacyCheckpoint: isLegacy
          ? { cursor: cursor ?? null, lastSuccessAt: state.lastSuccessAt ?? null }
          : (state.legacyCheckpoint ?? null),
        lastProgressAt: state.lastProgressAt ?? null,
        lastFailurePhase: state.lastFailurePhase ?? null,
        lastFailureCursor: state.lastFailureCursor ?? null,
        pendingCommentIssueNumbers: state.pendingCommentIssueNumbers ?? [],
      };
    });
  };

  const writeStates = (states: ForgejoBindingRuntimeState[]): void => {
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, `${JSON.stringify(states, null, 2)}\n`, "utf8");
  };

  return {
    get(bindingId): ForgejoBindingRuntimeState | null {
      return readStates().find((state) => state.bindingId === bindingId) ?? null;
    },
    save(state): void {
      const existing = readStates().filter((entry) => entry.bindingId !== state.bindingId);
      existing.push(state);
      writeStates(existing);
    },
    remove(bindingId): void {
      const existing = readStates().filter((entry) => entry.bindingId !== bindingId);
      writeStates(existing);
    },
    listAll(): ForgejoBindingRuntimeState[] {
      return readStates();
    },
  };
}
