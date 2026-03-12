import type { ForgejoAuthType } from "@/forgejo-config";
import {
  createForgejoAuthorizationHeader,
  formatForgejoIssueExternalId,
  type CreateForgejoIssueInput,
  type ForgejoComment,
  type ForgejoHttpClientOptions,
  type ForgejoIssue,
  type ForgejoIssueClient,
  type ForgejoRepositoryTarget,
  type ListForgejoIssuesOptions,
  type UpdateForgejoIssueInput,
} from "@/forgejo-client";

interface ForgejoApiIssue {
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  labels: Array<{ name: string } | string>;
  assignees?: Array<{ login?: string; username?: string }>;
  html_url: string;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

interface ForgejoApiComment {
  id: number;
  body: string;
  user?: { login?: string; username?: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

function normalizeLabels(labels: ForgejoApiIssue["labels"]): string[] {
  return labels.map((label) => (typeof label === "string" ? label : label.name));
}

function normalizeAssignees(assignees?: Array<{ login?: string; username?: string }>): string[] {
  return (assignees ?? []).map((assignee) => assignee.login ?? assignee.username ?? "unknown");
}

function mapApiIssue(target: ForgejoRepositoryTarget, raw: ForgejoApiIssue): ForgejoIssue {
  return {
    number: raw.number,
    externalId: formatForgejoIssueExternalId(target, raw.number),
    title: raw.title,
    body: raw.body ?? undefined,
    state: raw.state,
    labels: normalizeLabels(raw.labels),
    assignees: normalizeAssignees(raw.assignees),
    sourceUrl: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    isPullRequest: raw.pull_request != null,
  };
}

function mapApiComment(
  _target: ForgejoRepositoryTarget,
  issueNumber: number,
  raw: ForgejoApiComment
): ForgejoComment {
  return {
    id: raw.id,
    issueNumber,
    body: raw.body,
    author: raw.user?.login ?? raw.user?.username ?? "unknown",
    sourceUrl: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function createHttpForgejoIssueClient(
  token: string,
  options: ForgejoHttpClientOptions = {}
): ForgejoIssueClient {
  const authType: ForgejoAuthType = options.authType ?? "token";
  const fetchImpl = options.fetchImpl ?? fetch;

  const request = async <T>(
    target: ForgejoRepositoryTarget,
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> => {
    const url = `${target.apiBaseUrl}${path}`;
    const response = await fetchImpl(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: createForgejoAuthorizationHeader(token, authType),
        ...(body != null ? { "Content-Type": "application/json" } : {}),
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Forgejo API ${method} ${path} failed: ${response.status} ${text}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  };

  const listAllPages = async <T>(target: ForgejoRepositoryTarget, path: string): Promise<T[]> => {
    const results: T[] = [];
    let page = 1;
    const limit = 100;

    for (;;) {
      const separator = path.includes("?") ? "&" : "?";
      const items = await request<T[]>(
        target,
        "GET",
        `${path}${separator}limit=${limit}&page=${page}`
      );
      results.push(...items);

      if (items.length < limit) {
        break;
      }

      page += 1;
    }

    return results;
  };

  return {
    async listIssues(
      target: ForgejoRepositoryTarget,
      options?: ListForgejoIssuesOptions
    ): Promise<ForgejoIssue[]> {
      let path = `/repos/${target.owner}/${target.repo}/issues?state=all`;
      if (options?.since) {
        path += `&since=${encodeURIComponent(options.since)}`;
      }

      const rawIssues = await listAllPages<ForgejoApiIssue>(target, path);
      return rawIssues.map((rawIssue) => mapApiIssue(target, rawIssue));
    },

    async getIssue(
      target: ForgejoRepositoryTarget,
      issueNumber: number
    ): Promise<ForgejoIssue | null> {
      try {
        const rawIssue = await request<ForgejoApiIssue>(
          target,
          "GET",
          `/repos/${target.owner}/${target.repo}/issues/${issueNumber}`
        );

        return mapApiIssue(target, rawIssue);
      } catch (error) {
        if (error instanceof Error && error.message.includes("404")) {
          return null;
        }

        throw error;
      }
    },

    async createIssue(
      target: ForgejoRepositoryTarget,
      input: CreateForgejoIssueInput
    ): Promise<ForgejoIssue> {
      const rawIssue = await request<ForgejoApiIssue>(
        target,
        "POST",
        `/repos/${target.owner}/${target.repo}/issues`,
        {
          title: input.title,
          body: input.body,
          labels: input.labels,
        }
      );

      return mapApiIssue(target, rawIssue);
    },

    async updateIssue(
      target: ForgejoRepositoryTarget,
      issueNumber: number,
      input: UpdateForgejoIssueInput
    ): Promise<ForgejoIssue> {
      const rawIssue = await request<ForgejoApiIssue>(
        target,
        "PATCH",
        `/repos/${target.owner}/${target.repo}/issues/${issueNumber}`,
        {
          ...(input.title != null ? { title: input.title } : {}),
          ...(input.body != null ? { body: input.body } : {}),
          ...(input.state != null ? { state: input.state } : {}),
          ...(input.labels != null ? { labels: input.labels } : {}),
        }
      );

      return mapApiIssue(target, rawIssue);
    },

    async listComments(
      target: ForgejoRepositoryTarget,
      issueNumber: number
    ): Promise<ForgejoComment[]> {
      const path = `/repos/${target.owner}/${target.repo}/issues/${issueNumber}/comments`;
      const rawComments = await listAllPages<ForgejoApiComment>(target, path);
      return rawComments.map((rawComment) => mapApiComment(target, issueNumber, rawComment));
    },

    async createComment(
      target: ForgejoRepositoryTarget,
      issueNumber: number,
      body: string
    ): Promise<ForgejoComment> {
      const rawComment = await request<ForgejoApiComment>(
        target,
        "POST",
        `/repos/${target.owner}/${target.repo}/issues/${issueNumber}/comments`,
        { body }
      );

      return mapApiComment(target, issueNumber, rawComment);
    },

    async updateComment(
      target: ForgejoRepositoryTarget,
      commentId: number,
      body: string
    ): Promise<ForgejoComment> {
      const rawComment = await request<ForgejoApiComment>(
        target,
        "PATCH",
        `/repos/${target.owner}/${target.repo}/issues/comments/${commentId}`,
        { body }
      );

      return mapApiComment(target, 0, rawComment);
    },

    async deleteComment(target: ForgejoRepositoryTarget, commentId: number): Promise<void> {
      await request<void>(
        target,
        "DELETE",
        `/repos/${target.owner}/${target.repo}/issues/comments/${commentId}`
      );
    },
  };
}
