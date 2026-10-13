import fs from "node:fs";

import type { IntegrationBinding, Task } from "@todu/core";

import { formatForgejoIssueExternalId, parseForgejoIssueExternalId } from "@/forgejo-ids";
import { writeForgejoStateFile } from "@/forgejo-storage";

// Only confirmed deletion is recorded here. Detection and sync policy are separate.
export interface ForgejoIssueTombstone {
  bindingId: IntegrationBinding["id"];
  taskId: Task["id"];
  externalId: string;
  issueNumber: number;
  deletedAt: string;
  reason: string;
  source: string;
}

export interface ForgejoIssueTombstoneStore {
  getByTaskId(
    bindingId: IntegrationBinding["id"],
    taskId: Task["id"]
  ): ForgejoIssueTombstone | null;
  getByIssueNumber(
    bindingId: IntegrationBinding["id"],
    issueNumber: number
  ): ForgejoIssueTombstone | null;
  getByExternalId(
    bindingId: IntegrationBinding["id"],
    externalId: string
  ): ForgejoIssueTombstone | null;
  list(bindingId: IntegrationBinding["id"]): ForgejoIssueTombstone[];
  listAll(): ForgejoIssueTombstone[];
  save(tombstone: ForgejoIssueTombstone): void;
  remove(bindingId: IntegrationBinding["id"], taskId: Task["id"]): void;
}

function prepareTombstone(value: unknown): ForgejoIssueTombstone {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid Forgejo issue tombstone: expected a record");
  }
  const record = value as Record<string, unknown>;
  for (const key of ["bindingId", "taskId", "externalId", "deletedAt", "reason", "source"]) {
    if (typeof record[key] !== "string" || !record[key].trim()) {
      throw new Error(`Invalid Forgejo issue tombstone: ${key} must be a non-empty string`);
    }
  }
  if (!Number.isSafeInteger(record.issueNumber) || (record.issueNumber as number) <= 0) {
    throw new Error("Invalid Forgejo issue tombstone: issueNumber must be a positive safe integer");
  }
  const tombstone = value as ForgejoIssueTombstone;
  if (!Number.isFinite(Date.parse(tombstone.deletedAt))) {
    throw new Error("Invalid Forgejo issue tombstone: deletedAt must be a valid timestamp");
  }
  try {
    const identity = parseForgejoIssueExternalId(tombstone.externalId);
    if (
      identity.issueNumber !== tombstone.issueNumber ||
      formatForgejoIssueExternalId(identity) !== tombstone.externalId
    ) {
      throw new Error("externalId must be canonical and match issueNumber");
    }
  } catch (error) {
    throw new Error("Invalid Forgejo issue tombstone: invalid external identity", { cause: error });
  }
  return {
    bindingId: tombstone.bindingId,
    taskId: tombstone.taskId,
    externalId: tombstone.externalId,
    issueNumber: tombstone.issueNumber,
    deletedAt: tombstone.deletedAt,
    reason: tombstone.reason,
    source: tombstone.source,
  };
}

// Tombstones are immutable. An identical save is safe to retry; replacing any
// deletion evidence requires explicit removal rather than silently clearing it.
function addTombstone(records: ForgejoIssueTombstone[], tombstone: ForgejoIssueTombstone): boolean {
  const existing = records.find(
    (record) =>
      record.bindingId === tombstone.bindingId &&
      (record.taskId === tombstone.taskId ||
        record.issueNumber === tombstone.issueNumber ||
        record.externalId === tombstone.externalId)
  );
  if (existing) {
    if (
      existing.taskId === tombstone.taskId &&
      existing.issueNumber === tombstone.issueNumber &&
      existing.externalId === tombstone.externalId &&
      existing.deletedAt === tombstone.deletedAt &&
      existing.reason === tombstone.reason &&
      existing.source === tombstone.source
    )
      return false;
    throw new Error(
      `Conflicting Forgejo issue tombstone in binding ${tombstone.bindingId} for task ${tombstone.taskId}, issue ${tombstone.issueNumber}; explicitly remove the existing tombstone before replacement`
    );
  }
  records.push(tombstone);
  return true;
}

function createTombstoneStore(
  read: () => ForgejoIssueTombstone[],
  write: (records: ForgejoIssueTombstone[]) => void
): ForgejoIssueTombstoneStore {
  return {
    getByTaskId(bindingId, taskId) {
      return (
        read().find((record) => record.bindingId === bindingId && record.taskId === taskId) ?? null
      );
    },
    getByIssueNumber(bindingId, issueNumber) {
      return (
        read().find(
          (record) => record.bindingId === bindingId && record.issueNumber === issueNumber
        ) ?? null
      );
    },
    getByExternalId(bindingId, externalId) {
      return (
        read().find(
          (record) => record.bindingId === bindingId && record.externalId === externalId
        ) ?? null
      );
    },
    list(bindingId) {
      return read().filter((record) => record.bindingId === bindingId);
    },
    listAll: read,
    save(value) {
      const tombstone = prepareTombstone(value);
      const records = read();
      if (addTombstone(records, tombstone)) write(records);
    },
    remove(bindingId, taskId) {
      const records = read();
      const remaining = records.filter(
        (record) => !(record.bindingId === bindingId && record.taskId === taskId)
      );
      if (remaining.length !== records.length) write(remaining);
    },
  };
}

export function createInMemoryForgejoIssueTombstoneStore(): ForgejoIssueTombstoneStore {
  let records: ForgejoIssueTombstone[] = [];
  return createTombstoneStore(
    () => structuredClone(records),
    (value) => {
      records = structuredClone(value);
    }
  );
}

export function createFileForgejoIssueTombstoneStore(
  storagePath: string
): ForgejoIssueTombstoneStore {
  const read = (): ForgejoIssueTombstone[] => {
    if (!fs.existsSync(storagePath)) return [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(storagePath, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
      const records: ForgejoIssueTombstone[] = [];
      for (const value of parsed) addTombstone(records, prepareTombstone(value));
      return records;
    } catch (error) {
      throw new Error(`Invalid Forgejo issue tombstone store at ${storagePath}`, { cause: error });
    }
  };
  return createTombstoneStore(read, (records) => writeForgejoStateFile(storagePath, records));
}
