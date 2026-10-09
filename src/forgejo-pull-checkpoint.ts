import { randomUUID } from "node:crypto";

import type { IntegrationBinding, SyncProviderPullResultV4 } from "@todu/core";

import {
  createInMemoryForgejoCommentLinkStore,
  type ForgejoCommentLink,
  type ForgejoCommentLinkStore,
} from "@/forgejo-comment-links";
import {
  createInMemoryForgejoItemLinkStore,
  type ForgejoItemLink,
  type ForgejoItemLinkStore,
} from "@/forgejo-links";

export interface ForgejoPullCheckpoint {
  id: string;
  scope: string;
}

export interface ForgejoPendingPull {
  checkpoint: ForgejoPullCheckpoint;
  issueCursor: string;
  commentCursor: string;
  result: Omit<SyncProviderPullResultV4, "checkpoint">;
  itemUpserts: ForgejoItemLink[];
  itemRemovals: ForgejoItemLink[];
  commentUpserts: ForgejoCommentLink[];
  commentRemovals: ForgejoCommentLink[];
}

export function createForgejoPullCheckpoint(scope: string): ForgejoPullCheckpoint {
  return { id: randomUUID(), scope };
}

export function isForgejoPullCheckpoint(value: unknown): value is ForgejoPullCheckpoint {
  return (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    "scope" in value &&
    typeof value.scope === "string" &&
    value.scope.length > 0
  );
}

export function sameForgejoPullCheckpoint(
  left: ForgejoPullCheckpoint,
  right: ForgejoPullCheckpoint
): boolean {
  return left.id === right.id && left.scope === right.scope;
}

export function replayForgejoPendingPull(pending: ForgejoPendingPull): SyncProviderPullResultV4 {
  return structuredClone({ ...pending.result, checkpoint: pending.checkpoint });
}

// Pull bookkeeping is isolated from the durable stores until host acknowledgment.
export function stageForgejoPullLinks(
  bindingId: IntegrationBinding["id"],
  items: ForgejoItemLinkStore,
  comments: ForgejoCommentLinkStore
) {
  const originalItems = structuredClone(items.list(bindingId));
  const originalComments = structuredClone(
    comments.listAll().filter((link) => link.bindingId === bindingId)
  );
  const itemStore = createInMemoryForgejoItemLinkStore();
  const commentStore = createInMemoryForgejoCommentLinkStore();
  originalItems.forEach((link) => itemStore.save(structuredClone(link)));
  originalComments.forEach((link) => commentStore.save(structuredClone(link)));
  return {
    itemStore,
    commentStore,
    changes() {
      const nextItems = itemStore.list(bindingId);
      const nextComments = commentStore.listAll();
      return {
        itemUpserts: nextItems.filter(
          (link) =>
            !originalItems.some((original) => JSON.stringify(original) === JSON.stringify(link))
        ),
        itemRemovals: originalItems.filter(
          (original) => !nextItems.some((link) => link.taskId === original.taskId)
        ),
        commentUpserts: nextComments.filter(
          (link) =>
            !originalComments.some((original) => JSON.stringify(original) === JSON.stringify(link))
        ),
        commentRemovals: originalComments.filter(
          (original) => !nextComments.some((link) => link.noteId === original.noteId)
        ),
      };
    },
  };
}

// Idempotent writes precede the final runtime commit. A crash between files leaves
// the durable pending batch intact, so replay and acknowledgment can safely retry.
export function commitForgejoPullLinks(
  pending: ForgejoPendingPull,
  items: ForgejoItemLinkStore,
  comments: ForgejoCommentLinkStore
): void {
  for (const link of pending.commentRemovals) {
    const current = comments.getByNoteId(link.bindingId, link.noteId);
    if (JSON.stringify(current) === JSON.stringify(link))
      comments.remove(link.bindingId, link.noteId);
  }
  for (const link of pending.itemRemovals) {
    const current = items.getByTaskId(link.bindingId, link.taskId);
    if (JSON.stringify(current) === JSON.stringify(link)) items.remove(link.bindingId, link.taskId);
  }
  for (const link of pending.itemUpserts) {
    const current = items.getByIssueNumber(link.bindingId, link.issueNumber);
    if (
      current?.lastMirroredAt &&
      link.lastMirroredAt &&
      Date.parse(current.lastMirroredAt) > Date.parse(link.lastMirroredAt)
    )
      continue;
    items.save({ ...link, taskId: current?.taskId ?? link.taskId });
  }
  for (const link of pending.commentUpserts) {
    const current = comments.getByForgejoCommentId(link.bindingId, link.forgejoCommentId);
    if (current && Date.parse(current.lastMirroredAt) > Date.parse(link.lastMirroredAt)) continue;
    const item = items.getByIssueNumber(link.bindingId, link.issueNumber);
    comments.save({
      ...link,
      taskId: item?.taskId ?? link.taskId,
      noteId: current?.noteId ?? link.noteId,
      origin: current?.origin ?? link.origin,
    });
  }
}

export function validateForgejoPendingPull(
  value: unknown,
  bindingId: IntegrationBinding["id"]
): asserts value is ForgejoPendingPull {
  const timestamp = (entry: unknown) =>
    typeof entry === "string" && Number.isFinite(Date.parse(entry));
  const record = (entry: unknown): entry is Record<string, unknown> =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry);
  const arrayOf = (entry: unknown, valid: (item: unknown) => boolean) =>
    Array.isArray(entry) && entry.every(valid);
  const validItem = (entry: unknown) =>
    record(entry) &&
    entry.bindingId === bindingId &&
    typeof entry.taskId === "string" &&
    typeof entry.externalId === "string" &&
    Number.isInteger(entry.issueNumber) &&
    (entry.lastMirroredAt === undefined || timestamp(entry.lastMirroredAt));
  const validComment = (entry: unknown) =>
    record(entry) &&
    entry.bindingId === bindingId &&
    typeof entry.taskId === "string" &&
    typeof entry.noteId === "string" &&
    Number.isInteger(entry.issueNumber) &&
    Number.isInteger(entry.forgejoCommentId) &&
    timestamp(entry.lastMirroredAt) &&
    (entry.lastMirroredBody === undefined || typeof entry.lastMirroredBody === "string") &&
    (entry.origin === undefined || entry.origin === "forgejo" || entry.origin === "todu");
  if (
    !record(value) ||
    !isForgejoPullCheckpoint(value.checkpoint) ||
    !timestamp(value.issueCursor) ||
    !timestamp(value.commentCursor) ||
    !record(value.result) ||
    !arrayOf(
      value.result.tasks,
      (task) =>
        record(task) && typeof task.externalId === "string" && typeof task.title === "string"
    ) ||
    !arrayOf(
      value.result.comments,
      (comment) =>
        record(comment) &&
        typeof comment.externalId === "string" &&
        typeof comment.externalTaskId === "string" &&
        typeof comment.body === "string" &&
        timestamp(comment.createdAt)
    ) ||
    !arrayOf(value.itemUpserts, validItem) ||
    !arrayOf(value.itemRemovals, validItem) ||
    !arrayOf(value.commentUpserts, validComment) ||
    !arrayOf(value.commentRemovals, validComment)
  ) {
    throw new Error("invalid pendingPull checkpoint or replay batch");
  }
}
