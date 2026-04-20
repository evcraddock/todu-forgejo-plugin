import type {
  ExportedCommentInput,
  ExportedTaskInput,
  ImportedCommentInput,
  IntegrationBinding,
  Note,
  NoteId,
  SyncProviderPushCommentLink,
  TaskPriority,
  TaskPushPayload,
  TaskStatus,
} from "@todu/core";

import {
  createForgejoActorRef,
  getForgejoActorDisplayName,
  type ForgejoComment,
  type ForgejoIssueClient,
} from "@/forgejo-client";
import type { ForgejoCommentLink, ForgejoCommentLinkStore } from "@/forgejo-comment-links";
import type { ForgejoItemLink, ForgejoItemLinkStore } from "@/forgejo-links";

const FORGEJO_ATTRIBUTION_PREFIX = "_Synced from Forgejo comment by @";
const TODU_ATTRIBUTION_PREFIX = "_Synced from todu comment by @";
const ATTRIBUTION_SUFFIX_PATTERN = / on \d{4}-\d{2}-\d{2}T[\d:.]+Z_$/;
const IMPORTED_COMMENT_LINK_PREFIX = "external:";
const SYNC_EXTERNAL_ID_TAG_PREFIX = "sync:externalId:";
const TODU_COMMENT_AUTHOR = "todu";

interface ForgejoLegacyPushTask {
  id: string;
  comments: Note[];
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
}

type ForgejoPushTask = ExportedTaskInput | TaskPushPayload | ForgejoLegacyPushTask;
type ForgejoPushComment = ExportedCommentInput | Note;

export function formatForgejoAttribution(author: string, timestamp: string): string {
  return `_Synced from Forgejo comment by @${author} on ${timestamp}_`;
}

export function formatToduAttribution(author: string, timestamp: string): string {
  return `_Synced from todu comment by @${author} on ${timestamp}_`;
}

export function formatAttributedBody(attribution: string, body: string): string {
  return `${attribution}\n\n${body}`;
}

export function stripAttribution(body: string): string {
  const lines = body.split("\n");
  if (lines.length < 1) {
    return body;
  }

  const firstLine = lines[0];
  if (
    (firstLine.startsWith(FORGEJO_ATTRIBUTION_PREFIX) ||
      firstLine.startsWith(TODU_ATTRIBUTION_PREFIX)) &&
    ATTRIBUTION_SUFFIX_PATTERN.test(firstLine)
  ) {
    const remaining = lines.slice(1).join("\n");
    return remaining.startsWith("\n") ? remaining.slice(1) : remaining;
  }

  return body;
}

export function hasForgejoAttribution(body: string): boolean {
  const firstLine = body.split("\n")[0];
  return (
    firstLine.startsWith(FORGEJO_ATTRIBUTION_PREFIX) && ATTRIBUTION_SUFFIX_PATTERN.test(firstLine)
  );
}

function hasImportedForgejoSyncTag(note: Pick<Note, "tags">): boolean {
  return note.tags.some((tag) => tag.startsWith(SYNC_EXTERNAL_ID_TAG_PREFIX));
}

function isLegacyImportedCommentLinkNoteId(noteId: NoteId): boolean {
  return String(noteId).startsWith(IMPORTED_COMMENT_LINK_PREFIX);
}

function getImportedForgejoSyncExternalId(note: Pick<Note, "tags">): string | null {
  const syncTag = note.tags.find((tag) => tag.startsWith(SYNC_EXTERNAL_ID_TAG_PREFIX));
  return syncTag ? syncTag.slice(SYNC_EXTERNAL_ID_TAG_PREFIX.length) : null;
}

export interface PullCommentsResult {
  comments: ImportedCommentInput[];
  createdLinks: ForgejoCommentLink[];
}

export interface PullCommentsIssueErrorContext {
  itemLink: ForgejoItemLink;
  error: unknown;
}

export async function pullComments(input: {
  binding: IntegrationBinding;
  issueClient: ForgejoIssueClient;
  target: {
    baseUrl: string;
    apiBaseUrl: string;
    owner: string;
    repo: string;
  };
  itemLinkStore: ForgejoItemLinkStore;
  commentLinkStore: ForgejoCommentLinkStore;
  issueNumbers?: readonly number[];
  since?: string;
  onIssueError?: (
    context: PullCommentsIssueErrorContext
  ) => "continue" | "throw" | Promise<"continue" | "throw">;
}): Promise<PullCommentsResult> {
  const comments: ImportedCommentInput[] = [];
  const createdLinks: ForgejoCommentLink[] = [];

  const issueNumbers = input.issueNumbers ? new Set(input.issueNumbers) : null;
  const itemLinks = input.itemLinkStore
    .list(input.binding.id)
    .filter((itemLink) => issueNumbers?.has(itemLink.issueNumber) ?? true);

  for (const itemLink of itemLinks) {
    let forgejoComments: ForgejoComment[];

    try {
      forgejoComments = await input.issueClient.listComments(
        input.target,
        itemLink.issueNumber,
        input.since ? { since: input.since } : undefined
      );
    } catch (error) {
      const resolution = await input.onIssueError?.({ itemLink, error });
      if (resolution === "continue") {
        continue;
      }

      throw error;
    }

    for (const forgejoComment of forgejoComments) {
      const strippedBody = stripAttribution(forgejoComment.body);
      const authorDisplayName = getForgejoActorDisplayName(forgejoComment.author);
      const normalizedAuthor = createForgejoActorRef(forgejoComment.author);

      comments.push({
        externalId: String(forgejoComment.id),
        externalTaskId: itemLink.externalId,
        body: formatAttributedBody(
          formatForgejoAttribution(authorDisplayName, forgejoComment.createdAt),
          strippedBody
        ),
        author: normalizedAuthor ? { ...normalizedAuthor } : undefined,
        createdAt: forgejoComment.createdAt,
        updatedAt: forgejoComment.updatedAt,
        raw: forgejoComment,
      });

      const existingLink = input.commentLinkStore.getByForgejoCommentId(
        input.binding.id,
        forgejoComment.id
      );

      if (!existingLink) {
        const newLink: ForgejoCommentLink = {
          bindingId: input.binding.id,
          taskId: itemLink.taskId,
          noteId: `${IMPORTED_COMMENT_LINK_PREFIX}${forgejoComment.id}` as NoteId,
          issueNumber: itemLink.issueNumber,
          forgejoCommentId: forgejoComment.id,
          lastMirroredAt: forgejoComment.updatedAt ?? forgejoComment.createdAt,
          lastMirroredBody: strippedBody,
        };

        input.commentLinkStore.save(newLink);
        createdLinks.push(newLink);
        continue;
      }

      input.commentLinkStore.save({
        ...existingLink,
        lastMirroredAt: forgejoComment.updatedAt ?? forgejoComment.createdAt,
        lastMirroredBody: strippedBody,
      });
    }
  }

  return { comments, createdLinks };
}

export interface PushCommentsResult {
  commentLinks: SyncProviderPushCommentLink[];
  createdComments: ForgejoComment[];
  updatedComments: ForgejoComment[];
}

export interface PushCommentsStaleLinkContext {
  itemLink: ForgejoItemLink;
  commentLink: ForgejoCommentLink;
}

export async function pushComments(input: {
  binding: IntegrationBinding;
  issueClient: ForgejoIssueClient;
  target: {
    baseUrl: string;
    apiBaseUrl: string;
    owner: string;
    repo: string;
  };
  tasks: ForgejoPushTask[];
  itemLinkStore: ForgejoItemLinkStore;
  commentLinkStore: ForgejoCommentLinkStore;
  onStaleLink?: (context: PushCommentsStaleLinkContext) => void | Promise<void>;
}): Promise<PushCommentsResult> {
  const commentLinks: SyncProviderPushCommentLink[] = [];
  const createdComments: ForgejoComment[] = [];
  const updatedComments: ForgejoComment[] = [];

  for (const task of input.tasks) {
    const localTaskId = getLocalTaskId(task);
    const itemLink = input.itemLinkStore.getByTaskId(input.binding.id, localTaskId as never);
    if (!itemLink) {
      continue;
    }

    const notes = (task.comments as ForgejoPushComment[]).map((comment) => toPushNote(comment));
    reconcileLegacyCommentLinks(input.binding.id, itemLink, notes, input.commentLinkStore);

    const currentNoteIds = new Set(notes.map((note) => String(note.id)));

    for (const existingCommentLink of input.commentLinkStore.listByIssue(
      input.binding.id,
      itemLink.issueNumber
    )) {
      if (currentNoteIds.has(String(existingCommentLink.noteId))) {
        continue;
      }

      input.commentLinkStore.remove(input.binding.id, existingCommentLink.noteId);
      await input.onStaleLink?.({
        itemLink,
        commentLink: existingCommentLink,
      });
    }

    for (const note of notes) {
      const existingLink = input.commentLinkStore.getByNoteId(input.binding.id, note.id);

      if (
        !existingLink &&
        (hasForgejoAttribution(note.content) || hasImportedForgejoSyncTag(note))
      ) {
        continue;
      }

      if (existingLink) {
        const updated = await updateForgejoCommentIfNeeded(
          input,
          note,
          existingLink,
          updatedComments
        );
        commentLinks.push(
          createPushCommentLink(note.id, itemLink.taskId, existingLink.forgejoCommentId, updated)
        );
      } else {
        const created = await createForgejoCommentFromNote(input, note, itemLink, createdComments);
        commentLinks.push(createPushCommentLink(note.id, itemLink.taskId, created.id, created));
      }
    }
  }

  return { commentLinks, createdComments, updatedComments };
}

function getLocalTaskId(task: ForgejoPushTask): string {
  return "localTaskId" in task ? String(task.localTaskId) : String(task.id);
}

function toPushNote(
  comment: ForgejoPushComment
): Pick<Note, "id" | "content" | "tags" | "author" | "createdAt"> {
  if ("localNoteId" in comment) {
    return {
      id: comment.localNoteId,
      content: comment.body,
      tags: [],
      author: TODU_COMMENT_AUTHOR,
      createdAt: comment.createdAt,
    };
  }

  return {
    id: comment.id,
    content: comment.content,
    tags: comment.tags,
    author: comment.author,
    createdAt: comment.createdAt,
  };
}

function reconcileLegacyCommentLinks(
  bindingId: IntegrationBinding["id"],
  itemLink: ForgejoItemLink,
  notes: Array<Pick<Note, "id" | "content" | "tags">>,
  commentLinkStore: ForgejoCommentLinkStore
): void {
  for (const existingLink of commentLinkStore.listByIssue(bindingId, itemLink.issueNumber)) {
    const noteWithMatchingSyncTag = notes.find(
      (note) => getImportedForgejoSyncExternalId(note) === String(existingLink.forgejoCommentId)
    );
    const noteWithSameId = notes.find((note) => note.id === existingLink.noteId);
    const taggedForgejoCommentId = noteWithSameId
      ? getImportedForgejoSyncExternalId(noteWithSameId)
      : null;
    const resolvedNoteId = isLegacyImportedCommentLinkNoteId(existingLink.noteId)
      ? resolveLegacyCommentLinkNoteId(existingLink, notes)
      : existingLink.noteId;
    const resolvedForgejoCommentId = taggedForgejoCommentId
      ? Number(taggedForgejoCommentId)
      : existingLink.forgejoCommentId;

    if (resolvedNoteId === null) {
      continue;
    }

    const nextNoteId = noteWithMatchingSyncTag?.id ?? resolvedNoteId;

    if (
      existingLink.taskId === itemLink.taskId &&
      existingLink.noteId === nextNoteId &&
      existingLink.forgejoCommentId === resolvedForgejoCommentId
    ) {
      continue;
    }

    commentLinkStore.save({
      ...existingLink,
      taskId: itemLink.taskId,
      noteId: nextNoteId,
      forgejoCommentId: resolvedForgejoCommentId,
    });
  }
}

function resolveLegacyCommentLinkNoteId(
  existingLink: ForgejoCommentLink,
  notes: Array<Pick<Note, "id" | "content" | "tags">>
): NoteId | null {
  const matchingNotes = notes.filter((note) => {
    const importedExternalId = getImportedForgejoSyncExternalId(note);
    if (importedExternalId === String(existingLink.forgejoCommentId)) {
      return true;
    }

    if (!hasForgejoAttribution(note.content)) {
      return false;
    }

    if (existingLink.lastMirroredBody === undefined) {
      return false;
    }

    return stripAttribution(note.content) === existingLink.lastMirroredBody;
  });

  if (matchingNotes.length !== 1) {
    return null;
  }

  return matchingNotes[0].id;
}

async function updateForgejoCommentIfNeeded(
  input: {
    issueClient: ForgejoIssueClient;
    target: {
      baseUrl: string;
      apiBaseUrl: string;
      owner: string;
      repo: string;
    };
    commentLinkStore: ForgejoCommentLinkStore;
  },
  note: Pick<Note, "id" | "content" | "author" | "createdAt">,
  existingLink: ForgejoCommentLink,
  updatedComments: ForgejoComment[]
): Promise<ForgejoComment | null> {
  const localBody = stripAttribution(note.content);
  const mirroredBody = existingLink.lastMirroredBody ?? localBody;
  const noteUpdatedAt = Date.parse(note.createdAt);
  const lastMirroredAt = Date.parse(existingLink.lastMirroredAt);

  if (
    localBody === mirroredBody &&
    !Number.isNaN(noteUpdatedAt) &&
    !Number.isNaN(lastMirroredAt) &&
    noteUpdatedAt <= lastMirroredAt
  ) {
    return null;
  }

  if (localBody === mirroredBody) {
    return null;
  }

  const attributedBody = formatAttributedBody(
    formatToduAttribution(note.author, note.createdAt),
    localBody
  );

  const updatedComment = await input.issueClient.updateComment(
    input.target,
    existingLink.forgejoCommentId,
    attributedBody
  );

  updatedComments.push(updatedComment);
  input.commentLinkStore.save({
    ...existingLink,
    lastMirroredAt: updatedComment.updatedAt ?? updatedComment.createdAt,
    lastMirroredBody: localBody,
  });

  return updatedComment;
}

async function createForgejoCommentFromNote(
  input: {
    binding: IntegrationBinding;
    issueClient: ForgejoIssueClient;
    target: {
      baseUrl: string;
      apiBaseUrl: string;
      owner: string;
      repo: string;
    };
    commentLinkStore: ForgejoCommentLinkStore;
  },
  note: Pick<Note, "id" | "content" | "author" | "createdAt">,
  itemLink: ForgejoItemLink,
  createdComments: ForgejoComment[]
): Promise<ForgejoComment> {
  const localBody = stripAttribution(note.content);
  const attributedBody = formatAttributedBody(
    formatToduAttribution(note.author, note.createdAt),
    localBody
  );

  const createdComment = await input.issueClient.createComment(
    input.target,
    itemLink.issueNumber,
    attributedBody
  );

  createdComments.push(createdComment);

  input.commentLinkStore.save({
    bindingId: input.binding.id,
    taskId: itemLink.taskId,
    noteId: note.id,
    issueNumber: itemLink.issueNumber,
    forgejoCommentId: createdComment.id,
    lastMirroredAt: createdComment.updatedAt ?? createdComment.createdAt,
    lastMirroredBody: localBody,
  });

  return createdComment;
}

function createPushCommentLink(
  noteId: NoteId,
  taskId: ForgejoItemLink["taskId"],
  forgejoCommentId: number,
  comment: ForgejoComment | null
): SyncProviderPushCommentLink {
  return {
    localNoteId: noteId,
    externalCommentId: String(forgejoCommentId),
    externalTaskId: String(taskId),
    sourceUrl: comment?.sourceUrl,
    createdAt: comment?.createdAt,
    updatedAt: comment?.updatedAt,
    raw: comment,
  };
}
