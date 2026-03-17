import type {
  ExternalComment,
  IntegrationBinding,
  Note,
  NoteId,
  SyncProviderPushCommentLink,
  TaskPushPayload,
} from "@todu/core";

import type { ForgejoComment, ForgejoIssueClient } from "@/forgejo-client";
import type { ForgejoCommentLink, ForgejoCommentLinkStore } from "@/forgejo-comment-links";
import type { ForgejoItemLink, ForgejoItemLinkStore } from "@/forgejo-links";

const FORGEJO_ATTRIBUTION_PREFIX = "_Synced from Forgejo comment by @";
const TODU_ATTRIBUTION_PREFIX = "_Synced from todu comment by @";
const ATTRIBUTION_SUFFIX_PATTERN = / on \d{4}-\d{2}-\d{2}T[\d:.]+Z_$/;
const IMPORTED_COMMENT_LINK_PREFIX = "external:";

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

function isImportedCommentLink(link: ForgejoCommentLink): boolean {
  return (link.noteId as string).startsWith(IMPORTED_COMMENT_LINK_PREFIX);
}

export interface PullCommentsResult {
  comments: ExternalComment[];
  createdLinks: ForgejoCommentLink[];
  deletedLinks: ForgejoCommentLink[];
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
}): Promise<PullCommentsResult> {
  const comments: ExternalComment[] = [];
  const createdLinks: ForgejoCommentLink[] = [];
  const deletedLinks: ForgejoCommentLink[] = [];

  const issueNumbers = input.issueNumbers ? new Set(input.issueNumbers) : null;
  const itemLinks = input.itemLinkStore
    .list(input.binding.id)
    .filter((itemLink) => issueNumbers?.has(itemLink.issueNumber) ?? true);

  for (const itemLink of itemLinks) {
    const forgejoComments = await input.issueClient.listComments(
      input.target,
      itemLink.issueNumber,
      input.since ? { since: input.since } : undefined
    );
    const existingCommentLinks = input.commentLinkStore.listByIssue(
      input.binding.id,
      itemLink.issueNumber
    );

    if (!input.since) {
      const forgejoCommentIds = new Set(forgejoComments.map((comment) => comment.id));

      for (const commentLink of existingCommentLinks) {
        if (!forgejoCommentIds.has(commentLink.forgejoCommentId)) {
          input.commentLinkStore.removeByForgejoCommentId(
            input.binding.id,
            commentLink.forgejoCommentId
          );
          deletedLinks.push(commentLink);
        }
      }
    }

    for (const forgejoComment of forgejoComments) {
      const strippedBody = stripAttribution(forgejoComment.body);

      comments.push({
        externalId: String(forgejoComment.id),
        externalTaskId: itemLink.externalId,
        body: formatAttributedBody(
          formatForgejoAttribution(forgejoComment.author, forgejoComment.createdAt),
          strippedBody
        ),
        author: forgejoComment.author,
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

  return { comments, createdLinks, deletedLinks };
}

export interface PushCommentsResult {
  commentLinks: SyncProviderPushCommentLink[];
  createdComments: ForgejoComment[];
  updatedComments: ForgejoComment[];
  deletedCommentIds: number[];
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
  tasks: TaskPushPayload[];
  itemLinkStore: ForgejoItemLinkStore;
  commentLinkStore: ForgejoCommentLinkStore;
}): Promise<PushCommentsResult> {
  const commentLinks: SyncProviderPushCommentLink[] = [];
  const createdComments: ForgejoComment[] = [];
  const updatedComments: ForgejoComment[] = [];
  const deletedCommentIds: number[] = [];

  for (const task of input.tasks) {
    const itemLink = input.itemLinkStore.getByTaskId(input.binding.id, task.id);
    if (!itemLink) {
      continue;
    }

    const remoteComments = await input.issueClient.listComments(input.target, itemLink.issueNumber);
    const remoteCommentsById = new Map(remoteComments.map((comment) => [comment.id, comment]));
    const existingCommentLinks = input.commentLinkStore.listByTask(input.binding.id, task.id);
    const currentNoteIds = new Set(task.comments.map((comment) => comment.id));

    for (const commentLink of existingCommentLinks) {
      if (!currentNoteIds.has(commentLink.noteId) && !isImportedCommentLink(commentLink)) {
        await deleteForgejoComment(input, commentLink, deletedCommentIds);
      }
    }

    for (const note of task.comments) {
      const existingLink = input.commentLinkStore.getByNoteId(input.binding.id, note.id);

      if (!existingLink) {
        if (hasForgejoAttribution(note.content)) {
          continue;
        }

        const createdComment = await createForgejoCommentFromNote(
          input,
          note,
          task,
          itemLink,
          createdComments
        );
        commentLinks.push(
          createPushCommentLink(note.id, String(task.id), createdComment.id, createdComment)
        );
        continue;
      }

      const updatedComment = await syncExistingForgejoComment({
        binding: input.binding,
        issueClient: input.issueClient,
        target: input.target,
        task,
        note,
        itemLink,
        existingLink,
        remoteComment: remoteCommentsById.get(existingLink.forgejoCommentId) ?? null,
        commentLinkStore: input.commentLinkStore,
        updatedComments,
        createdComments,
      });

      commentLinks.push(
        createPushCommentLink(
          note.id,
          String(task.id),
          updatedComment?.id ?? existingLink.forgejoCommentId,
          updatedComment
        )
      );
    }
  }

  return { commentLinks, createdComments, updatedComments, deletedCommentIds };
}

async function deleteForgejoComment(
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
  commentLink: ForgejoCommentLink,
  deletedCommentIds: number[]
): Promise<void> {
  try {
    await input.issueClient.deleteComment(input.target, commentLink.forgejoCommentId);
  } catch {
    // Comment may already be deleted remotely; proceed with local link cleanup.
  }

  input.commentLinkStore.remove(input.binding.id, commentLink.noteId);
  deletedCommentIds.push(commentLink.forgejoCommentId);
}

async function syncExistingForgejoComment(input: {
  binding: IntegrationBinding;
  issueClient: ForgejoIssueClient;
  target: {
    baseUrl: string;
    apiBaseUrl: string;
    owner: string;
    repo: string;
  };
  task: TaskPushPayload;
  note: Note;
  itemLink: ForgejoItemLink;
  existingLink: ForgejoCommentLink;
  remoteComment: ForgejoComment | null;
  commentLinkStore: ForgejoCommentLinkStore;
  updatedComments: ForgejoComment[];
  createdComments: ForgejoComment[];
}): Promise<ForgejoComment | null> {
  const localBody = stripAttribution(input.note.content);
  const remoteBody = input.remoteComment ? stripAttribution(input.remoteComment.body) : null;
  const mirroredBody = input.existingLink.lastMirroredBody ?? remoteBody ?? localBody;
  const localChanged = localBody !== mirroredBody;
  const remoteChanged = remoteBody !== null && remoteBody !== mirroredBody;
  const localObservedAt = getLocalObservedAt(input.note);

  if (!localChanged) {
    if (input.remoteComment && input.existingLink.lastMirroredBody !== remoteBody) {
      input.commentLinkStore.save({
        ...input.existingLink,
        lastMirroredAt: input.remoteComment.updatedAt ?? input.remoteComment.createdAt,
        lastMirroredBody: remoteBody ?? input.existingLink.lastMirroredBody,
      });
    }

    return null;
  }

  if (
    input.remoteComment &&
    remoteChanged &&
    remoteWinsConflict(input.remoteComment, localObservedAt)
  ) {
    input.commentLinkStore.save({
      ...input.existingLink,
      lastMirroredAt: input.remoteComment.updatedAt ?? input.remoteComment.createdAt,
      lastMirroredBody: remoteBody ?? input.existingLink.lastMirroredBody,
    });
    return null;
  }

  if (!input.remoteComment) {
    const recreatedComment = await createForgejoCommentFromNote(
      {
        binding: input.binding,
        issueClient: input.issueClient,
        target: input.target,
        commentLinkStore: input.commentLinkStore,
      },
      input.note,
      input.task,
      input.itemLink,
      input.createdComments,
      input.existingLink
    );

    return recreatedComment;
  }

  const attributedBody = formatAttributedBody(
    formatToduAttribution(input.note.author, input.note.createdAt),
    localBody
  );

  const updatedComment = await input.issueClient.updateComment(
    input.target,
    input.existingLink.forgejoCommentId,
    attributedBody
  );

  input.updatedComments.push(updatedComment);
  input.commentLinkStore.save({
    ...input.existingLink,
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
  note: Note,
  task: TaskPushPayload,
  itemLink: ForgejoItemLink,
  createdComments: ForgejoComment[],
  existingLink?: ForgejoCommentLink
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

  if (existingLink) {
    input.commentLinkStore.remove(input.binding.id, existingLink.noteId);
  }

  input.commentLinkStore.save({
    bindingId: input.binding.id,
    taskId: task.id,
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
  externalTaskId: string,
  forgejoCommentId: number,
  comment: ForgejoComment | null
): SyncProviderPushCommentLink {
  return {
    localNoteId: noteId,
    externalCommentId: String(forgejoCommentId),
    externalTaskId,
    sourceUrl: comment?.sourceUrl,
    createdAt: comment?.createdAt,
    updatedAt: comment?.updatedAt,
    raw: comment,
  };
}

function getLocalObservedAt(note: Note): string {
  return note.createdAt;
}

function remoteWinsConflict(remoteComment: ForgejoComment, localObservedAt: string): boolean {
  const remoteObservedAt = Date.parse(remoteComment.updatedAt ?? remoteComment.createdAt);
  const localObservedAtMs = Date.parse(localObservedAt);

  if (Number.isNaN(remoteObservedAt) || Number.isNaN(localObservedAtMs)) {
    return false;
  }

  return remoteObservedAt > localObservedAtMs;
}
