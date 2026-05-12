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
  cursor: string | null;
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
    cursor: null,
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

export function recordForgejoSuccess(
  state: ForgejoBindingRuntimeState,
  cursor: string | null,
  now: Date = new Date()
): ForgejoBindingRuntimeState {
  return {
    ...state,
    cursor,
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
  const cursor = progress && "cursor" in progress ? (progress.cursor ?? null) : state.cursor;
  const pendingCommentIssueNumbers =
    progress?.pendingCommentIssueNumbers ?? state.pendingCommentIssueNumbers ?? [];

  return {
    ...state,
    cursor,
    retryAttempt: nextAttempt,
    nextRetryAt: nextRetryAt.toISOString(),
    lastError: error,
    lastAttemptAt: now.toISOString(),
    lastProgressAt: progress?.progressAt ?? state.lastProgressAt ?? null,
    lastFailurePhase: progress?.phase ?? null,
    lastFailureCursor: progress ? cursor : state.cursor,
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

      const state = entry as Partial<ForgejoBindingRuntimeState> & {
        bindingId: IntegrationBinding["id"];
      };

      return {
        ...state,
        lastProgressAt: state.lastProgressAt ?? null,
        lastFailurePhase: state.lastFailurePhase ?? null,
        lastFailureCursor: state.lastFailureCursor ?? null,
        pendingCommentIssueNumbers: state.pendingCommentIssueNumbers ?? [],
      } as ForgejoBindingRuntimeState;
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
