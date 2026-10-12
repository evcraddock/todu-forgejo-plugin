import { createHttpForgejoIssueClient } from "@/forgejo-http-client";
import { ForgejoHttpError, getForgejoHttpStatus } from "@/forgejo-http-error";
import { classifyForgejoSyncError } from "@/forgejo-provider";

const target = {
  baseUrl: "https://code.example.com",
  apiBaseUrl: "https://code.example.com/api/v1",
  owner: "acme",
  repo: "roadmap",
};
const kinds = new Map([
  [401, "auth"],
  [403, "permission"],
  [404, "not-found"],
  [429, "rate-limit"],
  [500, "server"],
]);

describe("Forgejo HTTP status is not a resource number", () => {
  it.each(
    [401, 403, 404, 429, 500].flatMap((number) =>
      [401, 403, 404, 429, 500].map((status) => [number, status])
    )
  )(
    "reads issue #%i response %i independently of path and body numbers",
    async (issueNumber, status) => {
      const client = createHttpForgejoIssueClient("synthetic-token", {
        fetchImpl: async () => new Response("401 403 404 429 500", { status }),
      });
      if (status === 404) {
        await expect(client.getIssue(target, issueNumber)).resolves.toBeNull();
      } else {
        await expect(client.getIssue(target, issueNumber)).rejects.toMatchObject({ status });
      }
      try {
        await client.listComments(target, issueNumber);
        throw new Error("HTTP failure was not propagated");
      } catch (error) {
        expect(error).toBeInstanceOf(ForgejoHttpError);
        expect(getForgejoHttpStatus(error)).toBe(status);
        expect(classifyForgejoSyncError(error).kind).toBe(kinds.get(status));
      }
    }
  );

  it.each([
    ["Forgejo API GET /issues/401/comments failed: 404 unavailable", 404],
    ["Forgejo API GET /issues/404 failed: 500 unavailable", 500],
    ["Forgejo API GET /issues/403 failed: 401 unavailable", 401],
    ["authentication failed: Forgejo API GET /issues/404 failed: 401 unavailable", 401],
    ["permission denied: Forgejo API GET /issues/401 failed: 403 unavailable", 403],
    ["resource not found: Forgejo API GET /issues/403 failed: 404 unavailable", 404],
    ["Forgejo API failed: 404 unavailable", 404],
    ["Forgejo API GET /issues/401 failed: 404 upstream failed: 403", 404],
    ["401 unauthorized", 401],
    ["network timeout while reading /issues/401", null],
    ["Forgejo pagination exceeded 5000 items for /issues/404/comments", null],
    ["task 404 has inconsistent linkage", null],
  ])("parses legacy/persisted status in %s", (message, status) => {
    expect(getForgejoHttpStatus(new Error(message))).toBe(status);
  });
});
