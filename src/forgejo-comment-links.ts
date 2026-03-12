import fs from "node:fs";
import path from "node:path";

import type { IntegrationBinding, NoteId, Task } from "@todu/core";

export interface ForgejoCommentLink {
  bindingId: IntegrationBinding["id"];
  taskId: Task["id"];
  noteId: NoteId;
  issueNumber: number;
  forgejoCommentId: number;
  lastMirroredAt: string;
  lastMirroredBody?: string;
}

export interface ForgejoCommentLinkStore {
  getByNoteId(bindingId: IntegrationBinding["id"], noteId: NoteId): ForgejoCommentLink | null;
  getByForgejoCommentId(
    bindingId: IntegrationBinding["id"],
    forgejoCommentId: number
  ): ForgejoCommentLink | null;
  listByIssue(bindingId: IntegrationBinding["id"], issueNumber: number): ForgejoCommentLink[];
  listByTask(bindingId: IntegrationBinding["id"], taskId: Task["id"]): ForgejoCommentLink[];
  listAll(): ForgejoCommentLink[];
  save(link: ForgejoCommentLink): void;
  remove(bindingId: IntegrationBinding["id"], noteId: NoteId): void;
  removeByForgejoCommentId(bindingId: IntegrationBinding["id"], forgejoCommentId: number): void;
}

export function createInMemoryForgejoCommentLinkStore(): ForgejoCommentLinkStore {
  const links = new Map<string, ForgejoCommentLink>();

  const getNoteKey = (bindingId: IntegrationBinding["id"], noteId: NoteId): string =>
    `note:${bindingId}:${noteId}`;
  const getForgejoKey = (bindingId: IntegrationBinding["id"], forgejoCommentId: number): string =>
    `forgejo:${bindingId}:${forgejoCommentId}`;

  return {
    getByNoteId(bindingId, noteId): ForgejoCommentLink | null {
      return links.get(getNoteKey(bindingId, noteId)) ?? null;
    },
    getByForgejoCommentId(bindingId, forgejoCommentId): ForgejoCommentLink | null {
      return links.get(getForgejoKey(bindingId, forgejoCommentId)) ?? null;
    },
    listByIssue(bindingId, issueNumber): ForgejoCommentLink[] {
      const result: ForgejoCommentLink[] = [];
      const seen = new Set<string>();

      for (const link of links.values()) {
        if (
          link.bindingId === bindingId &&
          link.issueNumber === issueNumber &&
          !seen.has(link.noteId)
        ) {
          seen.add(link.noteId);
          result.push(link);
        }
      }

      return result;
    },
    listByTask(bindingId, taskId): ForgejoCommentLink[] {
      const result: ForgejoCommentLink[] = [];
      const seen = new Set<string>();

      for (const link of links.values()) {
        if (link.bindingId === bindingId && link.taskId === taskId && !seen.has(link.noteId)) {
          seen.add(link.noteId);
          result.push(link);
        }
      }

      return result;
    },
    listAll(): ForgejoCommentLink[] {
      const allLinks = new Map<string, ForgejoCommentLink>();
      for (const link of links.values()) {
        allLinks.set(`${link.bindingId}:${link.noteId}`, link);
      }

      return [...allLinks.values()];
    },
    save(link): void {
      const existingByNote = links.get(getNoteKey(link.bindingId, link.noteId));
      if (existingByNote) {
        links.delete(getForgejoKey(link.bindingId, existingByNote.forgejoCommentId));
      }

      const existingByForgejoComment = links.get(
        getForgejoKey(link.bindingId, link.forgejoCommentId)
      );
      if (existingByForgejoComment) {
        links.delete(getNoteKey(link.bindingId, existingByForgejoComment.noteId));
      }

      links.set(getNoteKey(link.bindingId, link.noteId), link);
      links.set(getForgejoKey(link.bindingId, link.forgejoCommentId), link);
    },
    remove(bindingId, noteId): void {
      const link = links.get(getNoteKey(bindingId, noteId));
      if (link) {
        links.delete(getNoteKey(bindingId, noteId));
        links.delete(getForgejoKey(bindingId, link.forgejoCommentId));
      }
    },
    removeByForgejoCommentId(bindingId, forgejoCommentId): void {
      const link = links.get(getForgejoKey(bindingId, forgejoCommentId));
      if (link) {
        links.delete(getNoteKey(bindingId, link.noteId));
        links.delete(getForgejoKey(bindingId, forgejoCommentId));
      }
    },
  };
}

export function createFileForgejoCommentLinkStore(storagePath: string): ForgejoCommentLinkStore {
  const readLinks = (): ForgejoCommentLink[] => {
    if (!fs.existsSync(storagePath)) {
      return [];
    }

    const rawContent = fs.readFileSync(storagePath, "utf8");
    if (!rawContent.trim()) {
      return [];
    }

    const parsedContent = JSON.parse(rawContent) as unknown;
    if (!Array.isArray(parsedContent)) {
      throw new Error(`Invalid Forgejo comment link store at ${storagePath}: expected JSON array`);
    }

    return parsedContent.map((link) => {
      if (!link || typeof link !== "object") {
        throw new Error(
          `Invalid Forgejo comment link store at ${storagePath}: invalid link record`
        );
      }

      return link as ForgejoCommentLink;
    });
  };

  const writeLinks = (links: ForgejoCommentLink[]): void => {
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, `${JSON.stringify(links, null, 2)}\n`, "utf8");
  };

  return {
    getByNoteId(bindingId, noteId): ForgejoCommentLink | null {
      return (
        readLinks().find((link) => link.bindingId === bindingId && link.noteId === noteId) ?? null
      );
    },
    getByForgejoCommentId(bindingId, forgejoCommentId): ForgejoCommentLink | null {
      return (
        readLinks().find(
          (link) => link.bindingId === bindingId && link.forgejoCommentId === forgejoCommentId
        ) ?? null
      );
    },
    listByIssue(bindingId, issueNumber): ForgejoCommentLink[] {
      return readLinks().filter(
        (link) => link.bindingId === bindingId && link.issueNumber === issueNumber
      );
    },
    listByTask(bindingId, taskId): ForgejoCommentLink[] {
      return readLinks().filter((link) => link.bindingId === bindingId && link.taskId === taskId);
    },
    listAll(): ForgejoCommentLink[] {
      return readLinks();
    },
    save(link): void {
      const existing = readLinks().filter(
        (existingLink) =>
          !(
            existingLink.bindingId === link.bindingId &&
            (existingLink.noteId === link.noteId ||
              existingLink.forgejoCommentId === link.forgejoCommentId)
          )
      );

      existing.push(link);
      writeLinks(existing);
    },
    remove(bindingId, noteId): void {
      const existing = readLinks().filter(
        (link) => !(link.bindingId === bindingId && link.noteId === noteId)
      );

      writeLinks(existing);
    },
    removeByForgejoCommentId(bindingId, forgejoCommentId): void {
      const existing = readLinks().filter(
        (link) => !(link.bindingId === bindingId && link.forgejoCommentId === forgejoCommentId)
      );

      writeLinks(existing);
    },
  };
}
