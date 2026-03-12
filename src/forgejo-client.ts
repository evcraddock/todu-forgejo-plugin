import type { ForgejoRepositoryTarget as ForgejoRepositoryRef } from "@/forgejo-binding";
import type { ForgejoAuthType } from "@/forgejo-config";
import { formatForgejoIssueExternalId } from "@/forgejo-ids";

export interface ForgejoRepositoryTarget extends ForgejoRepositoryRef {
  baseUrl: string;
  apiBaseUrl: string;
}

export interface ForgejoIssue {
  number: number;
  externalId: string;
  title: string;
  body?: string;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
  sourceUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  isPullRequest?: boolean;
}

export interface ForgejoComment {
  id: number;
  issueNumber: number;
  body: string;
  author: string;
  sourceUrl?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateForgejoIssueInput {
  title: string;
  body?: string;
  state?: ForgejoIssue["state"];
  labels?: string[];
}

export interface UpdateForgejoIssueInput {
  title?: string;
  body?: string;
  state?: ForgejoIssue["state"];
  labels?: string[];
}

export interface ListForgejoIssuesOptions {
  since?: string;
}

export interface ForgejoIssueClient {
  listIssues(
    target: ForgejoRepositoryTarget,
    options?: ListForgejoIssuesOptions
  ): Promise<ForgejoIssue[]>;
  getIssue(target: ForgejoRepositoryTarget, issueNumber: number): Promise<ForgejoIssue | null>;
  createIssue(
    target: ForgejoRepositoryTarget,
    input: CreateForgejoIssueInput
  ): Promise<ForgejoIssue>;
  updateIssue(
    target: ForgejoRepositoryTarget,
    issueNumber: number,
    input: UpdateForgejoIssueInput
  ): Promise<ForgejoIssue>;
  listComments(target: ForgejoRepositoryTarget, issueNumber: number): Promise<ForgejoComment[]>;
  createComment(
    target: ForgejoRepositoryTarget,
    issueNumber: number,
    body: string
  ): Promise<ForgejoComment>;
  updateComment(
    target: ForgejoRepositoryTarget,
    commentId: number,
    body: string
  ): Promise<ForgejoComment>;
  deleteComment(target: ForgejoRepositoryTarget, commentId: number): Promise<void>;
}

export interface InMemoryForgejoIssueClient extends ForgejoIssueClient {
  seedIssues(target: ForgejoRepositoryTarget, issues: ForgejoIssue[]): void;
  seedComments(
    target: ForgejoRepositoryTarget,
    issueNumber: number,
    comments: ForgejoComment[]
  ): void;
  snapshotIssues(target: ForgejoRepositoryTarget): ForgejoIssue[];
  snapshotComments(target: ForgejoRepositoryTarget, issueNumber: number): ForgejoComment[];
}

export interface ForgejoHttpClientOptions {
  authType?: ForgejoAuthType;
  fetchImpl?: typeof fetch;
}

export function createForgejoIssueSourceUrl(
  target: ForgejoRepositoryTarget,
  issueNumber: number
): string {
  return `${target.baseUrl}/${target.owner}/${target.repo}/issues/${issueNumber}`;
}

export function createForgejoCommentSourceUrl(
  target: ForgejoRepositoryTarget,
  issueNumber: number,
  commentId: number
): string {
  return `${createForgejoIssueSourceUrl(target, issueNumber)}#issuecomment-${commentId}`;
}

export function createForgejoAuthorizationHeader(
  token: string,
  authType: ForgejoAuthType = "token"
): string {
  return authType === "bearer" ? `Bearer ${token}` : `token ${token}`;
}

export function createInMemoryForgejoIssueClient(): InMemoryForgejoIssueClient {
  const issuesByRepository = new Map<string, ForgejoIssue[]>();
  const commentsByIssue = new Map<string, ForgejoComment[]>();
  let nextCommentId = 1;

  const getRepositoryKey = (target: ForgejoRepositoryTarget): string =>
    `${target.baseUrl}/${target.owner}/${target.repo}`;

  const getCommentKey = (target: ForgejoRepositoryTarget, issueNumber: number): string =>
    `${getRepositoryKey(target)}#${issueNumber}`;

  const getIssues = (target: ForgejoRepositoryTarget): ForgejoIssue[] => {
    const repositoryKey = getRepositoryKey(target);
    return issuesByRepository.get(repositoryKey) ?? [];
  };

  const setIssues = (target: ForgejoRepositoryTarget, issues: ForgejoIssue[]): void => {
    issuesByRepository.set(getRepositoryKey(target), issues);
  };

  const getComments = (target: ForgejoRepositoryTarget, issueNumber: number): ForgejoComment[] =>
    commentsByIssue.get(getCommentKey(target, issueNumber)) ?? [];

  const setComments = (
    target: ForgejoRepositoryTarget,
    issueNumber: number,
    comments: ForgejoComment[]
  ): void => {
    commentsByIssue.set(getCommentKey(target, issueNumber), comments);
  };

  const cloneIssue = (issue: ForgejoIssue): ForgejoIssue => ({
    ...issue,
    labels: [...issue.labels],
    assignees: [...issue.assignees],
  });

  const cloneComment = (comment: ForgejoComment): ForgejoComment => ({ ...comment });

  const findCommentById = (
    target: ForgejoRepositoryTarget,
    commentId: number
  ): { comments: ForgejoComment[]; index: number; issueNumber: number } | null => {
    for (const [key, comments] of commentsByIssue.entries()) {
      if (!key.startsWith(getRepositoryKey(target))) {
        continue;
      }

      const index = comments.findIndex((comment) => comment.id === commentId);
      if (index !== -1) {
        const issueNumber = comments[index].issueNumber;
        return { comments, index, issueNumber };
      }
    }

    return null;
  };

  return {
    seedIssues(target, issues): void {
      setIssues(
        target,
        issues.map((issue) =>
          cloneIssue({
            ...issue,
            externalId:
              issue.externalId ??
              formatForgejoIssueExternalId({
                baseUrl: target.baseUrl,
                owner: target.owner,
                repo: target.repo,
                issueNumber: issue.number,
              }),
            sourceUrl: issue.sourceUrl ?? createForgejoIssueSourceUrl(target, issue.number),
            assignees: [...(issue.assignees ?? [])],
          })
        )
      );
    },
    seedComments(target, issueNumber, comments): void {
      const seeded = comments.map((comment) => {
        const id = comment.id || nextCommentId++;
        if (comment.id && comment.id >= nextCommentId) {
          nextCommentId = comment.id + 1;
        }

        return cloneComment({
          ...comment,
          id,
          issueNumber,
          sourceUrl: comment.sourceUrl ?? createForgejoCommentSourceUrl(target, issueNumber, id),
        });
      });

      setComments(target, issueNumber, seeded);
    },
    snapshotIssues(target): ForgejoIssue[] {
      return getIssues(target).map(cloneIssue);
    },
    snapshotComments(target, issueNumber): ForgejoComment[] {
      return getComments(target, issueNumber).map(cloneComment);
    },
    async listIssues(target, options): Promise<ForgejoIssue[]> {
      return getIssues(target)
        .filter((issue) => !issue.isPullRequest)
        .filter((issue) => {
          if (!options?.since || !issue.updatedAt) {
            return true;
          }

          return issue.updatedAt >= options.since;
        })
        .map(cloneIssue);
    },
    async getIssue(target, issueNumber): Promise<ForgejoIssue | null> {
      const issue = getIssues(target)
        .filter((candidate) => !candidate.isPullRequest)
        .find((candidate) => candidate.number === issueNumber);

      return issue ? cloneIssue(issue) : null;
    },
    async createIssue(target, input): Promise<ForgejoIssue> {
      const issues = getIssues(target);
      const nextIssueNumber = issues.reduce((max, issue) => Math.max(max, issue.number), 0) + 1;
      const timestamp = new Date().toISOString();
      const createdIssue: ForgejoIssue = {
        number: nextIssueNumber,
        externalId: formatForgejoIssueExternalId({
          baseUrl: target.baseUrl,
          owner: target.owner,
          repo: target.repo,
          issueNumber: nextIssueNumber,
        }),
        title: input.title,
        body: input.body,
        state: input.state ?? "open",
        labels: [...(input.labels ?? [])],
        assignees: [],
        sourceUrl: createForgejoIssueSourceUrl(target, nextIssueNumber),
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      setIssues(target, [...issues, createdIssue]);
      return cloneIssue(createdIssue);
    },
    async updateIssue(target, issueNumber, input): Promise<ForgejoIssue> {
      const issues = getIssues(target);
      const index = issues.findIndex((issue) => issue.number === issueNumber);
      if (index === -1) {
        throw new Error(`Forgejo issue not found: ${target.owner}/${target.repo}#${issueNumber}`);
      }

      const existingIssue = issues[index];
      const updatedIssue: ForgejoIssue = {
        ...existingIssue,
        title: input.title ?? existingIssue.title,
        body: input.body ?? existingIssue.body,
        state: input.state ?? existingIssue.state,
        labels: input.labels ? [...input.labels] : [...existingIssue.labels],
        updatedAt: new Date().toISOString(),
      };

      const nextIssues = [...issues];
      nextIssues[index] = updatedIssue;
      setIssues(target, nextIssues);
      return cloneIssue(updatedIssue);
    },
    async listComments(target, issueNumber): Promise<ForgejoComment[]> {
      return getComments(target, issueNumber).map(cloneComment);
    },
    async createComment(target, issueNumber, body): Promise<ForgejoComment> {
      const comments = getComments(target, issueNumber);
      const commentId = nextCommentId++;
      const timestamp = new Date().toISOString();
      const createdComment: ForgejoComment = {
        id: commentId,
        issueNumber,
        body,
        author: "forgejo-token-user",
        sourceUrl: createForgejoCommentSourceUrl(target, issueNumber, commentId),
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      setComments(target, issueNumber, [...comments, createdComment]);
      return cloneComment(createdComment);
    },
    async updateComment(target, commentId, body): Promise<ForgejoComment> {
      const found = findCommentById(target, commentId);
      if (!found) {
        throw new Error(
          `Forgejo comment not found: ${getRepositoryKey(target)} comment ${commentId}`
        );
      }

      const existingComment = found.comments[found.index];
      const updatedComment: ForgejoComment = {
        ...existingComment,
        body,
        updatedAt: new Date().toISOString(),
      };

      found.comments[found.index] = updatedComment;
      return cloneComment(updatedComment);
    },
    async deleteComment(target, commentId): Promise<void> {
      const found = findCommentById(target, commentId);
      if (!found) {
        throw new Error(
          `Forgejo comment not found: ${getRepositoryKey(target)} comment ${commentId}`
        );
      }

      found.comments.splice(found.index, 1);
    },
  };
}
