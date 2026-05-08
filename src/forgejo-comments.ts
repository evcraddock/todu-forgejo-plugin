import type {
  ExportedCommentInput,
  ExportedTaskInput,
  ImportedCommentInput,
  IntegrationBinding,
  NoteId,
  SyncProviderPushCommentLink,
} from "@todu/core";

import {
  createForgejoActorRef,
  getForgejoActorDisplayName,
  type ForgejoComment,
  type ForgejoIssueClient,
} from "@/forgejo-client";
import type {
  ForgejoCommentLink,
  ForgejoCommentLinkStore,
  ForgejoCommentOrigin,
} from "@/forgejo-comment-links";
import type { ForgejoItemLink, ForgejoItemLinkStore } from "@/forgejo-links";

const FORGEJO_ATTRIBUTION_PREFIX = "_Synced from Forgejo comment by @";
const TODU_ATTRIBUTION_PREFIX = "_Synced from todu comment by @";
const ATTRIBUTION_SUFFIX_PATTERN = / on \d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})_$/;
const IMPORTED_COMMENT_LINK_PREFIX = "external:";
const SYNC_EXTERNAL_ID_TAG_PREFIX = "sync:externalId:";
const TODU_COMMENT_AUTHOR = "todu";

interface ForgejoPushNote {
  id: ExportedCommentInput["localNoteId"];
  content: ExportedCommentInput["body"];
  tags: string[];
  author: string;
  createdAt: ExportedCommentInput["createdAt"];
  updatedAt?: ExportedCommentInput["updatedAt"];
}

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
  let stripped = body;

  while (true) {
    const lines = stripped.split("\n");
    const firstLine = lines[0];
    if (!isAttributionLine(firstLine)) {
      return stripped;
    }

    const remaining = lines.slice(1).join("\n");
    stripped = remaining.startsWith("\n") ? remaining.slice(1) : remaining;
  }
}

export function hasForgejoAttribution(body: string): boolean {
  return hasAttributionPrefix(body, FORGEJO_ATTRIBUTION_PREFIX);
}

function hasToduAttribution(body: string): boolean {
  return hasAttributionPrefix(body, TODU_ATTRIBUTION_PREFIX);
}

function hasAttributionPrefix(body: string, prefix: string): boolean {
  const firstLine = body.split("\n")[0];
  return firstLine.startsWith(prefix) && ATTRIBUTION_SUFFIX_PATTERN.test(firstLine);
}

function isAttributionLine(line: string | undefined): boolean {
  return (
    line !== undefined &&
    (line.startsWith(FORGEJO_ATTRIBUTION_PREFIX) || line.startsWith(TODU_ATTRIBUTION_PREFIX)) &&
    ATTRIBUTION_SUFFIX_PATTERN.test(line)
  );
}

function hasImportedForgejoSyncTag(note: Pick<ForgejoPushNote, "tags">): boolean {
  return note.tags.some((tag) => tag.startsWith(SYNC_EXTERNAL_ID_TAG_PREFIX));
}

function isLegacyImportedCommentLinkNoteId(noteId: NoteId): boolean {
  return String(noteId).startsWith(IMPORTED_COMMENT_LINK_PREFIX);
}

function getImportedForgejoSyncExternalId(note: Pick<ForgejoPushNote, "tags">): string | null {
  const syncTag = note.tags.find((tag) => tag.startsWith(SYNC_EXTERNAL_ID_TAG_PREFIX));
  return syncTag ? syncTag.slice(SYNC_EXTERNAL_ID_TAG_PREFIX.length) : null;
}

function getCommentLinkOrigin(link: ForgejoCommentLink): ForgejoCommentOrigin {
  if (link.origin) {
    return link.origin;
  }

  return isLegacyImportedCommentLinkNoteId(link.noteId) ? "forgejo" : "todu";
}

function inferReconciledCommentOrigin(input: {
  canonicalLink: ForgejoCommentLink | null;
  existingLink: ForgejoCommentLink | null;
  note: ForgejoPushNote;
}): ForgejoCommentOrigin {
  if (input.canonicalLink) {
    return getCommentLinkOrigin(input.canonicalLink);
  }

  if (input.existingLink) {
    return getCommentLinkOrigin(input.existingLink);
  }

  return hasForgejoAttribution(input.note.content) ? "forgejo" : "todu";
}

function shouldSkipUnchangedImportedNote(note: ForgejoPushNote, link: ForgejoCommentLink): boolean {
  const localBody = stripAttribution(note.content);
  if (localBody !== link.lastMirroredBody) {
    return false;
  }

  return getCommentLinkOrigin(link) === "forgejo" || hasForgejoAttribution(note.content);
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
      const existingLink = input.commentLinkStore.getByForgejoCommentId(
        input.binding.id,
        forgejoComment.id
      );

      if (existingLink && getCommentLinkOrigin(existingLink) === "todu") {
        input.commentLinkStore.save({
          ...existingLink,
          lastMirroredAt: forgejoComment.updatedAt ?? forgejoComment.createdAt,
          lastMirroredBody: strippedBody,
          origin: "todu",
        });
        continue;
      }

      if (!existingLink && hasToduAttribution(forgejoComment.body)) {
        continue;
      }

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

      if (!existingLink) {
        const newLink: ForgejoCommentLink = {
          bindingId: input.binding.id,
          taskId: itemLink.taskId,
          noteId: `${IMPORTED_COMMENT_LINK_PREFIX}${forgejoComment.id}` as NoteId,
          issueNumber: itemLink.issueNumber,
          forgejoCommentId: forgejoComment.id,
          lastMirroredAt: forgejoComment.updatedAt ?? forgejoComment.createdAt,
          lastMirroredBody: strippedBody,
          origin: "forgejo",
        };

        input.commentLinkStore.save(newLink);
        createdLinks.push(newLink);
        continue;
      }

      input.commentLinkStore.save({
        ...existingLink,
        lastMirroredAt: forgejoComment.updatedAt ?? forgejoComment.createdAt,
        lastMirroredBody: strippedBody,
        origin: getCommentLinkOrigin(existingLink),
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
  tasks: ExportedTaskInput[];
  itemLinkStore: ForgejoItemLinkStore;
  commentLinkStore: ForgejoCommentLinkStore;
  loadTaskNotes?: (
    taskId: ExportedTaskInput["localTaskId"]
  ) => Promise<Array<{ id: string; tags: string[] }>>;
  onStaleLink?: (context: PushCommentsStaleLinkContext) => void | Promise<void>;
}): Promise<PushCommentsResult> {
  const commentLinks: SyncProviderPushCommentLink[] = [];
  const createdComments: ForgejoComment[] = [];
  const updatedComments: ForgejoComment[] = [];

  for (const task of input.tasks) {
    const itemLink = input.itemLinkStore.getByTaskId(input.binding.id, task.localTaskId as never);
    if (!itemLink) {
      continue;
    }

    const taskNotes = input.loadTaskNotes ? await input.loadTaskNotes(task.localTaskId) : [];
    const noteTagsById = new Map(taskNotes.map((note) => [String(note.id), note.tags]));
    const notes = task.comments.map((comment) =>
      toPushNote(comment, noteTagsById.get(String(comment.localNoteId)) ?? [])
    );
    reconcileLegacyCommentLinks(input.binding.id, itemLink, notes, input.commentLinkStore);

    const currentNoteIds = new Set(task.comments.map((comment) => String(comment.localNoteId)));

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
      const existingLink = resolveCommentLinkForPush({
        binding: input.binding,
        taskId: task.localTaskId,
        itemLink,
        note,
        commentLinkStore: input.commentLinkStore,
      });

      if (
        !existingLink &&
        (hasForgejoAttribution(note.content) || hasImportedForgejoSyncTag(note))
      ) {
        continue;
      }

      if (existingLink) {
        if (shouldSkipUnchangedImportedNote(note, existingLink)) {
          continue;
        }

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
        const matched = await linkExistingForgejoCommentForNote(input, note, itemLink);
        if (matched) {
          commentLinks.push(createPushCommentLink(note.id, itemLink.taskId, matched.id, matched));
          continue;
        }

        const created = await createForgejoCommentFromNote(input, note, itemLink, createdComments);
        commentLinks.push(createPushCommentLink(note.id, itemLink.taskId, created.id, created));
      }
    }
  }

  return { commentLinks, createdComments, updatedComments };
}

function toPushNote(comment: ExportedCommentInput, tags: string[]): ForgejoPushNote {
  return {
    id: comment.localNoteId,
    content: comment.body,
    tags,
    author: TODU_COMMENT_AUTHOR,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

function resolveCommentLinkForPush(input: {
  binding: IntegrationBinding;
  taskId: ExportedTaskInput["localTaskId"];
  itemLink: ForgejoItemLink;
  note: ForgejoPushNote;
  commentLinkStore: ForgejoCommentLinkStore;
}): ForgejoCommentLink | null {
  const existingLink = input.commentLinkStore.getByNoteId(input.binding.id, input.note.id);
  const syncExternalCommentId = getImportedForgejoSyncExternalId(input.note);

  if (syncExternalCommentId === null) {
    return existingLink;
  }

  const forgejoCommentId = Number(syncExternalCommentId);
  const canonicalLink = input.commentLinkStore.getByForgejoCommentId(
    input.binding.id,
    forgejoCommentId
  );
  const reconciledLink: ForgejoCommentLink = {
    bindingId: input.binding.id,
    taskId: input.taskId,
    noteId: input.note.id,
    issueNumber: input.itemLink.issueNumber,
    forgejoCommentId,
    lastMirroredAt:
      canonicalLink?.lastMirroredAt ??
      existingLink?.lastMirroredAt ??
      input.note.updatedAt ??
      input.note.createdAt,
    lastMirroredBody:
      canonicalLink?.lastMirroredBody ??
      existingLink?.lastMirroredBody ??
      stripAttribution(input.note.content),
    origin: inferReconciledCommentOrigin({ canonicalLink, existingLink, note: input.note }),
  };

  if (existingLink && existingLink.forgejoCommentId !== forgejoCommentId) {
    input.commentLinkStore.remove(input.binding.id, input.note.id);
  }

  if (
    canonicalLink?.noteId !== input.note.id ||
    canonicalLink?.taskId !== input.taskId ||
    canonicalLink?.issueNumber !== input.itemLink.issueNumber ||
    existingLink?.forgejoCommentId !== forgejoCommentId
  ) {
    input.commentLinkStore.save(reconciledLink);
  }

  return canonicalLink?.noteId === input.note.id ? canonicalLink : reconciledLink;
}

function reconcileLegacyCommentLinks(
  bindingId: IntegrationBinding["id"],
  itemLink: ForgejoItemLink,
  notes: ForgejoPushNote[],
  commentLinkStore: ForgejoCommentLinkStore
): void {
  for (const existingLink of commentLinkStore.listByIssue(bindingId, itemLink.issueNumber)) {
    const resolvedNoteId = isLegacyImportedCommentLinkNoteId(existingLink.noteId)
      ? resolveLegacyCommentLinkNoteId(existingLink, notes)
      : existingLink.noteId;

    if (resolvedNoteId === null) {
      continue;
    }

    if (existingLink.taskId === itemLink.taskId && existingLink.noteId === resolvedNoteId) {
      continue;
    }

    commentLinkStore.save({
      ...existingLink,
      taskId: itemLink.taskId,
      noteId: resolvedNoteId,
      origin: getCommentLinkOrigin(existingLink),
    });
  }
}

function resolveLegacyCommentLinkNoteId(
  existingLink: ForgejoCommentLink,
  notes: ForgejoPushNote[]
): NoteId | null {
  const matchingNotes = notes.filter((note) => {
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
  note: ForgejoPushNote,
  existingLink: ForgejoCommentLink,
  updatedComments: ForgejoComment[]
): Promise<ForgejoComment | null> {
  const localBody = stripAttribution(note.content);
  const mirroredBody = existingLink.lastMirroredBody ?? localBody;
  const noteUpdatedAt = Date.parse(note.updatedAt ?? note.createdAt);
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
    origin: getCommentLinkOrigin(existingLink),
  });

  return updatedComment;
}

async function linkExistingForgejoCommentForNote(
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
  note: ForgejoPushNote,
  itemLink: ForgejoItemLink
): Promise<ForgejoComment | null> {
  const localBody = stripAttribution(note.content);
  const forgejoComments = await input.issueClient.listComments(input.target, itemLink.issueNumber);
  const matchingComments = forgejoComments.filter(
    (comment) =>
      hasToduAttribution(comment.body) &&
      stripAttribution(comment.body) === localBody &&
      !input.commentLinkStore.getByForgejoCommentId(input.binding.id, comment.id)
  );

  if (matchingComments.length === 0) {
    return null;
  }

  const matchedComment = matchingComments.sort((left, right) => left.id - right.id)[0];
  input.commentLinkStore.save({
    bindingId: input.binding.id,
    taskId: itemLink.taskId,
    noteId: note.id,
    issueNumber: itemLink.issueNumber,
    forgejoCommentId: matchedComment.id,
    lastMirroredAt: matchedComment.updatedAt ?? matchedComment.createdAt,
    lastMirroredBody: localBody,
    origin: "todu",
  });

  return matchedComment;
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
  note: ForgejoPushNote,
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
    origin: "todu",
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
