import type { ForgejoAuthType } from "@/forgejo-config";
import {
  createForgejoAuthorizationHeader,
  type CreateForgejoIssueInput,
  type ForgejoComment,
  type ForgejoHttpClientOptions,
  type ForgejoIssue,
  type ForgejoIssueClient,
  type ForgejoRepositoryTarget,
  type ListForgejoCommentsOptions,
  type ListForgejoIssuesOptions,
  type UpdateForgejoIssueInput,
} from "@/forgejo-client";
import { formatForgejoIssueExternalId } from "@/forgejo-ids";

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

interface ForgejoApiLabel {
  id: number;
  name: string;
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
    externalId: formatForgejoIssueExternalId({
      baseUrl: target.baseUrl,
      owner: target.owner,
      repo: target.repo,
      issueNumber: raw.number,
    }),
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
  const labelIdCache = new Map<string, Map<string, number>>();

  const getLabelRepoKey = (target: ForgejoRepositoryTarget): string =>
    `${target.apiBaseUrl}/repos/${target.owner}/${target.repo}`;

  const fetchLabelIds = async (target: ForgejoRepositoryTarget): Promise<Map<string, number>> => {
    const repoKey = getLabelRepoKey(target);
    const cached = labelIdCache.get(repoKey);
    if (cached) {
      return cached;
    }

    const rawLabels = await listAllPages<ForgejoApiLabel>(
      target,
      `/repos/${target.owner}/${target.repo}/labels`
    );

    const mapping = new Map<string, number>();
    for (const label of rawLabels) {
      mapping.set(label.name, label.id);
    }

    labelIdCache.set(repoKey, mapping);
    return mapping;
  };

  const invalidateLabelCache = (target: ForgejoRepositoryTarget): void => {
    labelIdCache.delete(getLabelRepoKey(target));
  };

  const resolveLabelIds = async (
    target: ForgejoRepositoryTarget,
    labelNames: string[]
  ): Promise<number[]> => {
    if (labelNames.length === 0) {
      return [];
    }

    const mapping = await fetchLabelIds(target);
    const ids: number[] = [];

    for (const name of labelNames) {
      const id = mapping.get(name);
      if (id != null) {
        ids.push(id);
      }
    }

    return ids;
  };

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
      const labelIds = input.labels ? await resolveLabelIds(target, input.labels) : undefined;
      const rawIssue = await request<ForgejoApiIssue>(
        target,
        "POST",
        `/repos/${target.owner}/${target.repo}/issues`,
        {
          title: input.title,
          body: input.body,
          labels: labelIds,
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
        }
      );

      if (input.labels != null) {
        const labelIds = await resolveLabelIds(target, input.labels);
        await request<ForgejoApiLabel[]>(
          target,
          "PUT",
          `/repos/${target.owner}/${target.repo}/issues/${issueNumber}/labels`,
          { labels: labelIds }
        );
      }

      return mapApiIssue(target, rawIssue);
    },

    async listLabels(target: ForgejoRepositoryTarget): Promise<string[]> {
      const rawLabels = await listAllPages<ForgejoApiLabel>(
        target,
        `/repos/${target.owner}/${target.repo}/labels`
      );
      return rawLabels.map((label) => label.name);
    },

    async createLabel(target: ForgejoRepositoryTarget, name: string): Promise<void> {
      await request<ForgejoApiLabel>(
        target,
        "POST",
        `/repos/${target.owner}/${target.repo}/labels`,
        {
          name,
          color: "ededed",
        }
      );
      invalidateLabelCache(target);
    },

    async listComments(
      target: ForgejoRepositoryTarget,
      issueNumber: number,
      options?: ListForgejoCommentsOptions
    ): Promise<ForgejoComment[]> {
      let path = `/repos/${target.owner}/${target.repo}/issues/${issueNumber}/comments`;
      if (options?.since) {
        path += `?since=${encodeURIComponent(options.since)}`;
      }

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
