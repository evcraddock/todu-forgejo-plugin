import type { IntegrationBinding } from "@todu/core";

export type ForgejoSyncDirection = "pull" | "push";
export type ForgejoSyncEntityType = "issue" | "comment" | "label" | "status";
export type ForgejoLogLevel = "debug" | "info" | "warn" | "error";

export interface ForgejoSyncLogContext {
  bindingId: IntegrationBinding["id"];
  projectId?: string;
  repo?: string;
  direction?: ForgejoSyncDirection;
  entityType?: ForgejoSyncEntityType;
  itemId?: string;
}

export interface ForgejoSyncLogEntry {
  level: ForgejoLogLevel;
  message: string;
  context: ForgejoSyncLogContext;
  error?: string;
  timestamp: string;
}

export interface ForgejoSyncLogger {
  debug(message: string, context: ForgejoSyncLogContext): void;
  info(message: string, context: ForgejoSyncLogContext): void;
  warn(message: string, context: ForgejoSyncLogContext): void;
  error(message: string, context: ForgejoSyncLogContext, error?: string): void;
  getEntries(): ForgejoSyncLogEntry[];
}

export function createForgejoSyncLogger(): ForgejoSyncLogger {
  const entries: ForgejoSyncLogEntry[] = [];

  const log = (
    level: ForgejoLogLevel,
    message: string,
    context: ForgejoSyncLogContext,
    error?: string
  ): void => {
    entries.push({
      level,
      message,
      context: { ...context },
      error,
      timestamp: new Date().toISOString(),
    });
  };

  return {
    debug(message, context): void {
      log("debug", message, context);
    },
    info(message, context): void {
      log("info", message, context);
    },
    warn(message, context): void {
      log("warn", message, context);
    },
    error(message, context, error): void {
      log("error", message, context, error);
    },
    getEntries(): ForgejoSyncLogEntry[] {
      return entries.map((entry) => ({ ...entry, context: { ...entry.context } }));
    },
  };
}

export function formatForgejoLogEntry(entry: ForgejoSyncLogEntry): string {
  const parts = [
    `[${entry.timestamp}]`,
    `[${entry.level.toUpperCase()}]`,
    `[binding:${entry.context.bindingId}]`,
  ];

  if (entry.context.repo) {
    parts.push(`[repo:${entry.context.repo}]`);
  }

  if (entry.context.direction) {
    parts.push(`[${entry.context.direction}]`);
  }

  if (entry.context.entityType) {
    parts.push(`[${entry.context.entityType}]`);
  }

  if (entry.context.itemId) {
    parts.push(`[item:${entry.context.itemId}]`);
  }

  parts.push(entry.message);

  if (entry.error) {
    parts.push(`| error: ${entry.error}`);
  }

  return parts.join(" ");
}
