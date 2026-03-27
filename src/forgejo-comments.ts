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
const SYNC_EXTERNAL_ID_TAG_PREFIX = "sync:externalId:";

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

function hasImportedForgejoSyncTag(note: Note): boolean {
  return note.tags.some((tag) => tag.startsWith(SYNC_EXTERNAL_ID_TAG_PREFIX));
}

export interface PullCommentsResult {
  comments: ExternalComment[];
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
  const comments: ExternalComment[] = [];
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

  return { comments, createdLinks };
}

export interface PushCommentsResult {
  commentLinks: SyncProviderPushCommentLink[];
  createdComments: ForgejoComment[];
  updatedComments: ForgejoComment[];
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

  for (const task of input.tasks) {
    const itemLink = input.itemLinkStore.getByTaskId(input.binding.id, task.id);
    if (!itemLink) {
      continue;
    }

    const localTaskId = task.id;

    for (const note of task.comments) {
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
          itemLink,
          updatedComments
        );
        commentLinks.push(
          createPushCommentLink(note.id, localTaskId, existingLink.forgejoCommentId, updated)
        );
      } else {
        const created = await createForgejoCommentFromNote(
          input,
          note,
          task,
          itemLink,
          createdComments
        );
        commentLinks.push(createPushCommentLink(note.id, localTaskId, created.id, created));
      }
    }
  }

  return { commentLinks, createdComments, updatedComments };
}

async function updateForgejoCommentIfNeeded(
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
  existingLink: ForgejoCommentLink,
  _itemLink: ForgejoItemLink,
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
  note: Note,
  task: TaskPushPayload,
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
