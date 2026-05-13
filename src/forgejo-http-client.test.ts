import { createHttpForgejoIssueClient } from "@/forgejo-http-client";

const target = {
  baseUrl: "https://forge.caradoc.com",
  apiBaseUrl: "https://forge.caradoc.com/api/v1",
  owner: "acme",
  repo: "roadmap",
};

function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createApiComment(id: number) {
  return {
    id,
    body: `Comment ${id}`,
    user: { id: id + 1000, login: `user-${id}` },
    html_url: `https://forge.caradoc.com/acme/roadmap/issues/45#comment-${id}`,
    created_at: "2026-05-12T00:00:00.000Z",
    updated_at: "2026-05-12T00:00:00.000Z",
  };
}

describe("forgejo http client", () => {
  it("uses binding target credentials when provided", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(url),
        authorization: headers.get("Authorization"),
      });
      return createJsonResponse([]);
    };

    const client = createHttpForgejoIssueClient("fallback-token", {
      authType: "token",
      fetchImpl,
    });

    await client.listIssues({
      ...target,
      token: "instance-token",
      authType: "bearer",
    });

    expect(requests).toEqual([
      {
        url: "https://forge.caradoc.com/api/v1/repos/acme/roadmap/issues?state=all&limit=100&page=1",
        authorization: "Bearer instance-token",
      },
    ]);
  });

  it("stops comment pagination when a repeated page is returned", async () => {
    const requests: string[] = [];
    const page = Array.from({ length: 100 }, (_, index) => createApiComment(index + 1));
    const fetchImpl: typeof fetch = async (url) => {
      requests.push(String(url));
      if (requests.length > 2) {
        throw new Error("pagination should have stopped after the repeated page");
      }

      return createJsonResponse(page);
    };

    const client = createHttpForgejoIssueClient("token", { fetchImpl });

    const comments = await client.listComments(target, 45);

    expect(comments).toHaveLength(100);
    expect(comments.map((comment) => comment.id)).toEqual(page.map((comment) => comment.id));
    expect(requests).toEqual([
      "https://forge.caradoc.com/api/v1/repos/acme/roadmap/issues/45/comments?limit=100&page=1",
      "https://forge.caradoc.com/api/v1/repos/acme/roadmap/issues/45/comments?limit=100&page=2",
    ]);
  });

  it("deduplicates comments by id when an oversized non-paginated response repeats", async () => {
    const page = Array.from({ length: 125 }, (_, index) => createApiComment(index + 1));
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      requests.push(String(url));
      if (requests.length > 2) {
        throw new Error("pagination should have stopped after the oversized repeated page");
      }

      return createJsonResponse(page);
    };

    const client = createHttpForgejoIssueClient("token", { fetchImpl });

    const comments = await client.listComments(target, 45);

    expect(comments).toHaveLength(125);
    expect(new Set(comments.map((comment) => comment.id))).toHaveLength(125);
    expect(requests).toHaveLength(2);
  });

  it("fails safely when comment pagination exceeds bounded item processing", async () => {
    let nextId = 1;
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      requests.push(String(url));
      return createJsonResponse(Array.from({ length: 100 }, () => createApiComment(nextId++)));
    };

    const client = createHttpForgejoIssueClient("token", { fetchImpl });

    await expect(client.listComments(target, 45)).rejects.toThrow(
      "Forgejo pagination exceeded 5000 items"
    );
    expect(requests).toHaveLength(51);
  });

  it("deduplicates comments by id across partially overlapping pages", async () => {
    const pages = [
      Array.from({ length: 100 }, (_, index) => createApiComment(index + 1)),
      [createApiComment(100), createApiComment(101)],
    ];
    const fetchImpl: typeof fetch = async () => createJsonResponse(pages.shift() ?? []);
    const client = createHttpForgejoIssueClient("token", { fetchImpl });

    const comments = await client.listComments(target, 45);

    expect(comments.map((comment) => comment.id)).toEqual(
      Array.from({ length: 101 }, (_, index) => index + 1)
    );
  });
});
