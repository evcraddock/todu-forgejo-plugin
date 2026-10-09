import fs from "node:fs";

import type { IntegrationBinding, Task } from "@todu/core";

import { writeForgejoStateFile } from "@/forgejo-storage";
import {
  normalizeForgejoFieldSnapshots,
  type ForgejoFieldSnapshots,
} from "@/forgejo-field-snapshots";
import type { ForgejoIssue } from "@/forgejo-client";
import { createImportedTaskId } from "@/forgejo-ids";
import { formatForgejoIssueExternalId } from "@/forgejo-ids";

export interface ForgejoItemLink {
  bindingId: IntegrationBinding["id"];
  taskId: Task["id"];
  issueNumber: number;
  externalId: string;
  lastMirroredAt?: string;
  fieldSnapshots?: ForgejoFieldSnapshots;
}

export interface ForgejoItemLinkStore {
  getByTaskId(bindingId: IntegrationBinding["id"], taskId: Task["id"]): ForgejoItemLink | null;
  getByIssueNumber(
    bindingId: IntegrationBinding["id"],
    issueNumber: number
  ): ForgejoItemLink | null;
  list(bindingId: IntegrationBinding["id"]): ForgejoItemLink[];
  listAll(): ForgejoItemLink[];
  save(link: ForgejoItemLink): void;
  remove(bindingId: IntegrationBinding["id"], taskId: Task["id"]): void;
}

function prepareForgejoItemLink(
  link: ForgejoItemLink,
  existing?: ForgejoItemLink
): ForgejoItemLink {
  const stored = structuredClone(link);
  const sameIdentity =
    existing !== undefined &&
    existing.issueNumber === link.issueNumber &&
    existing.externalId === link.externalId;
  const snapshots =
    link.fieldSnapshots !== undefined
      ? link.fieldSnapshots
      : sameIdentity
        ? existing.fieldSnapshots
        : undefined;
  delete stored.fieldSnapshots;
  if (snapshots !== undefined) stored.fieldSnapshots = normalizeForgejoFieldSnapshots(snapshots);
  return stored;
}

// Future reconciliation calls this only once the complete group is proven mirrored.
// This storage operation deliberately does not infer baselines or choose a winner.
export function updateForgejoItemFieldSnapshots(
  store: ForgejoItemLinkStore,
  bindingId: IntegrationBinding["id"],
  taskId: Task["id"],
  updates: ForgejoFieldSnapshots
): void {
  const link = store.getByTaskId(bindingId, taskId);
  if (!link)
    throw new Error(
      `Cannot update Forgejo field snapshots: task ${taskId} is not linked in binding ${bindingId}`
    );
  const normalized = normalizeForgejoFieldSnapshots(updates);
  if (Object.keys(normalized).length === 0) return;
  store.save({ ...link, fieldSnapshots: { ...link.fieldSnapshots, ...normalized } });
}

export function createInMemoryForgejoItemLinkStore(): ForgejoItemLinkStore {
  const links = new Map<string, ForgejoItemLink>();

  const getTaskKey = (bindingId: IntegrationBinding["id"], taskId: Task["id"]): string =>
    `task:${bindingId}:${taskId}`;
  const getIssueKey = (bindingId: IntegrationBinding["id"], issueNumber: number): string =>
    `issue:${bindingId}:${issueNumber}`;

  return {
    getByTaskId(bindingId, taskId): ForgejoItemLink | null {
      return structuredClone(links.get(getTaskKey(bindingId, taskId)) ?? null);
    },
    getByIssueNumber(bindingId, issueNumber): ForgejoItemLink | null {
      return structuredClone(links.get(getIssueKey(bindingId, issueNumber)) ?? null);
    },
    list(bindingId): ForgejoItemLink[] {
      const bindingLinks = new Map<string, ForgejoItemLink>();

      for (const link of links.values()) {
        if (link.bindingId === bindingId) {
          bindingLinks.set(link.externalId, link);
        }
      }

      return structuredClone([...bindingLinks.values()]);
    },
    listAll(): ForgejoItemLink[] {
      const allLinks = new Map<string, ForgejoItemLink>();

      for (const link of links.values()) {
        allLinks.set(`${link.bindingId}:${link.externalId}`, link);
      }

      return structuredClone([...allLinks.values()]);
    },
    save(link): void {
      const stored = prepareForgejoItemLink(
        link,
        links.get(getIssueKey(link.bindingId, link.issueNumber))
      );
      const existingByTask = links.get(getTaskKey(link.bindingId, link.taskId));
      if (existingByTask) {
        links.delete(getTaskKey(link.bindingId, existingByTask.taskId));
        links.delete(getIssueKey(link.bindingId, existingByTask.issueNumber));
      }

      const existingByIssue = links.get(getIssueKey(link.bindingId, link.issueNumber));
      if (existingByIssue) {
        links.delete(getTaskKey(link.bindingId, existingByIssue.taskId));
        links.delete(getIssueKey(link.bindingId, existingByIssue.issueNumber));
      }

      links.set(getTaskKey(stored.bindingId, stored.taskId), stored);
      links.set(getIssueKey(stored.bindingId, stored.issueNumber), stored);
    },
    remove(bindingId, taskId): void {
      const link = links.get(getTaskKey(bindingId, taskId));
      if (link) {
        links.delete(getTaskKey(bindingId, taskId));
        links.delete(getIssueKey(bindingId, link.issueNumber));
      }
    },
  };
}

export function createFileForgejoItemLinkStore(storagePath: string): ForgejoItemLinkStore {
  const readLinks = (): ForgejoItemLink[] => {
    if (!fs.existsSync(storagePath)) {
      return [];
    }

    const rawContent = fs.readFileSync(storagePath, "utf8");
    if (!rawContent.trim()) {
      return [];
    }

    const parsedContent = JSON.parse(rawContent) as unknown;
    if (!Array.isArray(parsedContent)) {
      throw new Error(`Invalid Forgejo item link store at ${storagePath}: expected JSON array`);
    }

    return parsedContent.map((link) => {
      if (!link || typeof link !== "object") {
        throw new Error(`Invalid Forgejo item link store at ${storagePath}: invalid link record`);
      }

      return prepareForgejoItemLink(link as ForgejoItemLink);
    });
  };

  const writeLinks = (links: ForgejoItemLink[]): void => {
    writeForgejoStateFile(storagePath, links);
  };

  const getLink = (predicate: (link: ForgejoItemLink) => boolean): ForgejoItemLink | null =>
    readLinks().find(predicate) ?? null;

  return {
    getByTaskId(bindingId, taskId): ForgejoItemLink | null {
      return getLink((link) => link.bindingId === bindingId && link.taskId === taskId);
    },
    getByIssueNumber(bindingId, issueNumber): ForgejoItemLink | null {
      return getLink((link) => link.bindingId === bindingId && link.issueNumber === issueNumber);
    },
    list(bindingId): ForgejoItemLink[] {
      return readLinks().filter((link) => link.bindingId === bindingId);
    },
    listAll(): ForgejoItemLink[] {
      return readLinks();
    },
    save(link): void {
      const links = readLinks();
      const stored = prepareForgejoItemLink(
        link,
        links.find(
          (existing) =>
            existing.bindingId === link.bindingId && existing.issueNumber === link.issueNumber
        )
      );
      const existingLinks = links.filter(
        (existingLink) =>
          !(
            existingLink.bindingId === link.bindingId &&
            (existingLink.taskId === link.taskId || existingLink.issueNumber === link.issueNumber)
          )
      );
      existingLinks.push(stored);
      writeLinks(existingLinks);
    },
    remove(bindingId, taskId): void {
      const existingLinks = readLinks().filter(
        (link) => !(link.bindingId === bindingId && link.taskId === taskId)
      );
      writeLinks(existingLinks);
    },
  };
}

export function createLinkFromIssue(input: {
  binding: IntegrationBinding;
  issue: ForgejoIssue;
  baseUrl: string;
  owner: string;
  repo: string;
}): ForgejoItemLink {
  const externalId = formatForgejoIssueExternalId({
    baseUrl: input.baseUrl,
    owner: input.owner,
    repo: input.repo,
    issueNumber: input.issue.number,
  });

  return {
    bindingId: input.binding.id,
    taskId: createImportedTaskId(externalId),
    issueNumber: input.issue.number,
    externalId,
    lastMirroredAt: input.issue.updatedAt ?? input.issue.createdAt,
  };
}

export function createLinkFromTask(input: {
  binding: IntegrationBinding;
  taskId: Task["id"];
  baseUrl: string;
  owner: string;
  repo: string;
  issueNumber: number;
  lastMirroredAt?: string;
}): ForgejoItemLink {
  return {
    bindingId: input.binding.id,
    taskId: input.taskId,
    issueNumber: input.issueNumber,
    externalId: formatForgejoIssueExternalId({
      baseUrl: input.baseUrl,
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.issueNumber,
    }),
    ...(input.lastMirroredAt ? { lastMirroredAt: input.lastMirroredAt } : {}),
  };
}
