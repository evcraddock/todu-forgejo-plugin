import { createHttpForgejoIssueClient } from "@/forgejo-http-client";

function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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
      baseUrl: "https://forge.caradoc.com",
      apiBaseUrl: "https://forge.caradoc.com/api/v1",
      owner: "acme",
      repo: "roadmap",
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
});
