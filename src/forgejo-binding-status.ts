import type { IntegrationBinding } from "@todu/core";

export type ForgejoBindingStatusState = "running" | "idle" | "blocked" | "error";

export interface ForgejoBindingStatus {
  bindingId: IntegrationBinding["id"];
  state: ForgejoBindingStatusState;
  authorityId: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastErrorSummary: string | null;
  updatedAt: string;
}

export function createForgejoBindingStatus(
  bindingId: IntegrationBinding["id"],
  authorityId: string | null = null,
  now: Date = new Date()
): ForgejoBindingStatus {
  return {
    bindingId,
    state: "idle",
    authorityId,
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastErrorSummary: null,
    updatedAt: now.toISOString(),
  };
}

export function updateForgejoBindingStatusRunning(
  status: ForgejoBindingStatus,
  now: Date = new Date()
): ForgejoBindingStatus {
  return {
    ...status,
    state: "running",
    lastAttemptAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function updateForgejoBindingStatusIdle(
  status: ForgejoBindingStatus,
  now: Date = new Date()
): ForgejoBindingStatus {
  return {
    ...status,
    state: "idle",
    lastSuccessAt: now.toISOString(),
    lastAttemptAt: now.toISOString(),
    lastErrorSummary: null,
    updatedAt: now.toISOString(),
  };
}

export function updateForgejoBindingStatusError(
  status: ForgejoBindingStatus,
  errorSummary: string,
  now: Date = new Date()
): ForgejoBindingStatus {
  return {
    ...status,
    state: "error",
    lastAttemptAt: now.toISOString(),
    lastErrorSummary: errorSummary,
    updatedAt: now.toISOString(),
  };
}

export function updateForgejoBindingStatusBlocked(
  status: ForgejoBindingStatus,
  reason: string,
  now: Date = new Date()
): ForgejoBindingStatus {
  return {
    ...status,
    state: "blocked",
    lastAttemptAt: now.toISOString(),
    lastErrorSummary: reason,
    updatedAt: now.toISOString(),
  };
}
