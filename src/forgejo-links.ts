import fs from "node:fs";
import path from "node:path";

import type { IntegrationBinding, Task } from "@todu/core";

import type { ForgejoIssue } from "@/forgejo-client";
import { createImportedTaskId } from "@/forgejo-ids";
import { formatForgejoIssueExternalId } from "@/forgejo-ids";

export interface ForgejoItemLink {
  bindingId: IntegrationBinding["id"];
  taskId: Task["id"];
  issueNumber: number;
  externalId: string;
  lastMirroredAt?: string;
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
}

export function createInMemoryForgejoItemLinkStore(): ForgejoItemLinkStore {
  const links = new Map<string, ForgejoItemLink>();

  const getTaskKey = (bindingId: IntegrationBinding["id"], taskId: Task["id"]): string =>
    `task:${bindingId}:${taskId}`;
  const getIssueKey = (bindingId: IntegrationBinding["id"], issueNumber: number): string =>
    `issue:${bindingId}:${issueNumber}`;

  return {
    getByTaskId(bindingId, taskId): ForgejoItemLink | null {
      return links.get(getTaskKey(bindingId, taskId)) ?? null;
    },
    getByIssueNumber(bindingId, issueNumber): ForgejoItemLink | null {
      return links.get(getIssueKey(bindingId, issueNumber)) ?? null;
    },
    list(bindingId): ForgejoItemLink[] {
      const bindingLinks = new Map<string, ForgejoItemLink>();

      for (const link of links.values()) {
        if (link.bindingId === bindingId) {
          bindingLinks.set(link.externalId, link);
        }
      }

      return [...bindingLinks.values()];
    },
    listAll(): ForgejoItemLink[] {
      const allLinks = new Map<string, ForgejoItemLink>();

      for (const link of links.values()) {
        allLinks.set(link.externalId, link);
      }

      return [...allLinks.values()];
    },
    save(link): void {
      links.set(getTaskKey(link.bindingId, link.taskId), link);
      links.set(getIssueKey(link.bindingId, link.issueNumber), link);
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

      return link as ForgejoItemLink;
    });
  };

  const writeLinks = (links: ForgejoItemLink[]): void => {
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, `${JSON.stringify(links, null, 2)}\n`, "utf8");
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
      const existingLinks = readLinks().filter(
        (existingLink) =>
          !(
            existingLink.bindingId === link.bindingId &&
            (existingLink.taskId === link.taskId || existingLink.issueNumber === link.issueNumber)
          )
      );
      existingLinks.push(link);
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
