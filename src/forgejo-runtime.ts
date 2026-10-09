import fs from "node:fs";
import type { IntegrationBinding } from "@todu/core";

import {
  isForgejoPullCheckpoint,
  validateForgejoPendingPull,
  type ForgejoPendingPull,
  type ForgejoPullCheckpoint,
} from "@/forgejo-pull-checkpoint";
import { writeForgejoStateFile } from "@/forgejo-storage";

export type ForgejoRuntimeFailurePhase =
  | "pull:issues"
  | "pull:comments"
  | "pull:acknowledgment"
  | "push:issues"
  | "push:comments";

export interface ForgejoPullFailureContext {
  lastError: string | null;
  lastFailurePhase: "pull:issues" | "pull:comments" | "pull:acknowledgment" | null;
  lastFailureCursor: string | null;
  lastProgressAt: string | null;
}

export interface ForgejoBindingRuntimeState {
  bindingId: IntegrationBinding["id"];
  checkpointVersion: 2;
  pendingPull: ForgejoPendingPull | null;
  lastAcknowledgedPull: ForgejoPullCheckpoint | null;
  preAcknowledgmentCheckpoint: {
    issuePullCursor: string | null;
    commentPullCursor: string | null;
  } | null;
  issuePullCursor: string | null;
  commentPullCursor: string | null;
  lastPushSuccessAt: string | null;
  legacyCheckpoint: { cursor: string | null; lastSuccessAt: string | null } | null;
  unresolvedPullFailure: ForgejoPullFailureContext | null;
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
    checkpointVersion: 2,
    pendingPull: null,
    lastAcknowledgedPull: null,
    preAcknowledgmentCheckpoint: null,
    issuePullCursor: null,
    commentPullCursor: null,
    lastPushSuccessAt: null,
    legacyCheckpoint: null,
    unresolvedPullFailure: null,
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

function getUnresolvedPullFailure(
  state: Omit<Partial<ForgejoBindingRuntimeState>, "checkpointVersion">
): ForgejoPullFailureContext | null {
  if (state.unresolvedPullFailure) {
    return state.unresolvedPullFailure;
  }
  const phase = state.lastFailurePhase ?? null;
  const isPullPhase =
    phase === "pull:issues" || phase === "pull:comments" || phase === "pull:acknowledgment";
  // Old issue-discovery failures had no phase. Unknown errors require a pull to
  // prove recovery, rather than guessing that a successful write repaired them.
  const unknownError = phase === null && state.lastError != null;
  if (!isPullPhase && !unknownError && !state.pendingCommentIssueNumbers?.length) {
    return null;
  }
  return {
    lastError: state.lastError ?? null,
    lastFailurePhase: isPullPhase ? phase : null,
    lastFailureCursor: state.lastFailureCursor ?? null,
    lastProgressAt: state.lastProgressAt ?? null,
  };
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
    unresolvedPullFailure: null,
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
  // A write cannot repair a failed read. Restore its diagnostics after intervening
  // push failures, while retaining the binding's current retry/backoff state.
  const unresolvedPullFailure = getUnresolvedPullFailure(state);
  if (unresolvedPullFailure) {
    return { ...successState, ...unresolvedPullFailure, unresolvedPullFailure };
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

  const failedState: ForgejoBindingRuntimeState = {
    ...state,
    // Discovery is diagnostic progress, not proof of host application.
    retryAttempt: nextAttempt,
    nextRetryAt: nextRetryAt.toISOString(),
    lastError: error,
    lastAttemptAt: now.toISOString(),
    lastProgressAt: progress?.progressAt ?? state.lastProgressAt ?? null,
    lastFailurePhase: progress?.phase ?? null,
    lastFailureCursor: isPullFailure ? cursor : null,
    pendingCommentIssueNumbers: [...new Set(pendingCommentIssueNumbers)],
  };
  return {
    ...failedState,
    unresolvedPullFailure: isPullFailure
      ? getUnresolvedPullFailure({ ...failedState, unresolvedPullFailure: null })
      : getUnresolvedPullFailure(state),
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
      return state ? structuredClone(state) : null;
    },
    save(state): void {
      states.set(state.bindingId, structuredClone(state));
    },
    remove(bindingId): void {
      states.delete(bindingId);
    },
    listAll(): ForgejoBindingRuntimeState[] {
      return [...states.values()].map((state) => structuredClone(state));
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

      const { cursor, ...state } = entry as Omit<
        Partial<ForgejoBindingRuntimeState>,
        "checkpointVersion"
      > & {
        bindingId: IntegrationBinding["id"];
        checkpointVersion?: number;
        cursor?: string | null;
      };
      if (
        state.checkpointVersion !== undefined &&
        state.checkpointVersion !== 1 &&
        state.checkpointVersion !== 2
      ) {
        throw new Error(
          `Invalid Forgejo runtime store at ${storagePath}: unsupported checkpoint version`
        );
      }
      if (state.unresolvedPullFailure != null) {
        const failure = state.unresolvedPullFailure;
        const validPhase =
          failure.lastFailurePhase === null ||
          failure.lastFailurePhase === "pull:issues" ||
          failure.lastFailurePhase === "pull:comments" ||
          failure.lastFailurePhase === "pull:acknowledgment";
        const validTimestamp = (value: unknown) =>
          value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
        if (
          typeof failure !== "object" ||
          !validPhase ||
          (failure.lastError !== null && typeof failure.lastError !== "string") ||
          !validTimestamp(failure.lastFailureCursor) ||
          !validTimestamp(failure.lastProgressAt)
        ) {
          throw new Error(
            `Invalid Forgejo runtime store at ${storagePath}: invalid unresolvedPullFailure`
          );
        }
      }
      const isLegacy = state.checkpointVersion === undefined;
      const isAcknowledged = state.checkpointVersion === 2;
      if (isAcknowledged) {
        try {
          if (state.pendingPull === undefined || state.lastAcknowledgedPull === undefined)
            throw new Error("missing acknowledgment state");
          if (state.pendingPull !== null)
            validateForgejoPendingPull(state.pendingPull, state.bindingId);
          if (
            state.lastAcknowledgedPull !== null &&
            !isForgejoPullCheckpoint(state.lastAcknowledgedPull)
          )
            throw new Error("invalid lastAcknowledgedPull");
        } catch (error) {
          throw new Error(`Invalid Forgejo runtime store at ${storagePath}: ${String(error)}`, {
            cause: error,
          });
        }
      }
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
        checkpointVersion: 2,
        pendingPull: isAcknowledged ? state.pendingPull! : null,
        lastAcknowledgedPull: isAcknowledged ? state.lastAcknowledgedPull! : null,
        preAcknowledgmentCheckpoint:
          state.checkpointVersion === 1
            ? {
                issuePullCursor: state.issuePullCursor!,
                commentPullCursor: state.commentPullCursor!,
              }
            : (state.preAcknowledgmentCheckpoint ?? null),
        // Neither old shared progress nor v1 read progress proved host persistence.
        issuePullCursor: isAcknowledged ? state.issuePullCursor! : null,
        commentPullCursor: isAcknowledged ? state.commentPullCursor! : null,
        lastPushSuccessAt: isLegacy ? null : state.lastPushSuccessAt!,
        legacyCheckpoint: isLegacy
          ? { cursor: cursor ?? null, lastSuccessAt: state.lastSuccessAt ?? null }
          : (state.legacyCheckpoint ?? null),
        lastProgressAt: state.lastProgressAt ?? null,
        lastFailurePhase: state.lastFailurePhase ?? null,
        lastFailureCursor: state.lastFailureCursor ?? null,
        pendingCommentIssueNumbers: state.pendingCommentIssueNumbers ?? [],
        unresolvedPullFailure: getUnresolvedPullFailure(state),
      };
    });
  };

  const writeStates = (states: ForgejoBindingRuntimeState[]): void => {
    writeForgejoStateFile(storagePath, states);
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
