import { createTaskId, type Task } from "@todu/core";

export interface ForgejoIssueRef {
  baseUrl: string;
  owner: string;
  repo: string;
  issueNumber: number;
}

export class ForgejoExternalIdError extends Error {
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ForgejoExternalIdError";
    this.details = details;
  }
}

export function formatForgejoIssueExternalId(issue: ForgejoIssueRef): string {
  return `${issue.baseUrl}/${issue.owner}/${issue.repo}#${issue.issueNumber}`;
}

export function parseForgejoIssueExternalId(externalId: string): ForgejoIssueRef {
  const normalizedExternalId = externalId.trim();
  if (!normalizedExternalId) {
    throw new ForgejoExternalIdError("Invalid Forgejo externalId: value is required", {
      externalId,
    });
  }

  const issueDelimiterIndex = normalizedExternalId.lastIndexOf("#");
  if (issueDelimiterIndex <= 0 || issueDelimiterIndex === normalizedExternalId.length - 1) {
    throw new ForgejoExternalIdError(
      `Invalid Forgejo externalId \`${externalId}\`: expected <baseUrl>/<owner>/<repo>#<number> format`,
      {
        externalId,
      }
    );
  }

  const baseAndRepo = normalizedExternalId.slice(0, issueDelimiterIndex);
  const issueNumberText = normalizedExternalId.slice(issueDelimiterIndex + 1);
  const issueNumber = Number.parseInt(issueNumberText, 10);

  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new ForgejoExternalIdError(
      `Invalid Forgejo externalId \`${externalId}\`: issue number must be a positive integer`,
      {
        externalId,
        issueNumber: issueNumberText,
      }
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseAndRepo);
  } catch {
    throw new ForgejoExternalIdError(
      `Invalid Forgejo externalId \`${externalId}\`: expected a valid base URL before /owner/repo`,
      {
        externalId,
      }
    );
  }

  const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);
  if (pathSegments.length < 2) {
    throw new ForgejoExternalIdError(
      `Invalid Forgejo externalId \`${externalId}\`: expected <baseUrl>/<owner>/<repo>#<number> format`,
      {
        externalId,
      }
    );
  }

  const repo = pathSegments[pathSegments.length - 1];
  const owner = pathSegments[pathSegments.length - 2];
  const basePathSegments = pathSegments.slice(0, -2);
  parsedUrl.pathname = basePathSegments.length > 0 ? `/${basePathSegments.join("/")}` : "/";
  parsedUrl.search = "";
  parsedUrl.hash = "";
  const baseUrl = parsedUrl.toString().replace(/\/$/, "");

  return {
    baseUrl,
    owner,
    repo,
    issueNumber,
  };
}

export function createImportedTaskId(externalId: string): Task["id"] {
  return createTaskId(`forgejo:${externalId}`);
}
