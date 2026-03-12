import { createIntegrationBindingId, createProjectId, type IntegrationBinding } from "@todu/core";

import { FORGEJO_PROVIDER_NAME, FORGEJO_REPOSITORY_TARGET_KIND } from "@/forgejo-binding";
import { createInMemoryForgejoIssueClient } from "@/forgejo-client";
import { createInMemoryForgejoItemLinkStore } from "@/forgejo-links";
import { createForgejoSyncProvider } from "@/forgejo-provider";

function createBinding(overrides: Partial<IntegrationBinding> = {}): IntegrationBinding {
  return {
    id: createIntegrationBindingId("binding-1"),
    provider: FORGEJO_PROVIDER_NAME,
    projectId: createProjectId("project-1"),
    targetKind: FORGEJO_REPOSITORY_TARGET_KIND,
    targetRef: "acme/roadmap",
    strategy: "bidirectional",
    enabled: true,
    createdAt: "2026-03-12T00:00:00.000Z",
    updatedAt: "2026-03-12T00:00:00.000Z",
    ...overrides,
  };
}

const project = {
  id: createProjectId("project-1"),
  name: "roadmap",
  status: "active" as const,
  priority: "medium" as const,
  createdAt: "2026-03-12T00:00:00.000Z",
  updatedAt: "2026-03-12T00:00:00.000Z",
};

describe("forgejo provider", () => {
  it("exports initialized settings after initialize and resets on shutdown", async () => {
    const provider = createForgejoSyncProvider({ issueClient: createInMemoryForgejoIssueClient() });

    expect(provider.getState().initialized).toBe(false);

    await provider.initialize({
      settings: {
        baseUrl: "https://code.example.com",
        token: "secret-token",
      },
    });

    expect(provider.getState().initialized).toBe(true);
    expect(provider.getState().settings?.apiBaseUrl).toBe("https://code.example.com/api/v1");

    await provider.shutdown();
    expect(provider.getState().initialized).toBe(false);
  });

  it("validates bindings during pull and push", async () => {
    const provider = createForgejoSyncProvider({ issueClient: createInMemoryForgejoIssueClient() });
    await provider.initialize({
      settings: {
        baseUrl: "https://code.example.com",
        token: "secret-token",
      },
    });

    await expect(provider.pull(createBinding(), project)).resolves.toEqual({ tasks: [] });
    await expect(provider.push(createBinding(), [], project)).resolves.toEqual({
      commentLinks: [],
      taskLinks: [],
    });
    await expect(provider.pull(createBinding({ provider: "github" }), project)).rejects.toThrow();
  });

  it("respects binding strategies for non-comment field sync", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const provider = createForgejoSyncProvider({
      issueClient,
      linkStore: createInMemoryForgejoItemLinkStore(),
    });
    await provider.initialize({
      settings: {
        baseUrl: "https://code.example.com",
        token: "secret-token",
      },
    });

    await expect(provider.pull(createBinding({ strategy: "push" }), project)).resolves.toEqual({
      tasks: [],
    });
    await expect(provider.push(createBinding({ strategy: "pull" }), [], project)).resolves.toEqual({
      commentLinks: [],
      taskLinks: [],
    });
  });

  it("maps external tasks into local tasks with normalized defaults", () => {
    const provider = createForgejoSyncProvider({ issueClient: createInMemoryForgejoIssueClient() });
    const task = provider.mapToTask(
      {
        externalId: "https://code.example.com/acme/roadmap#42",
        title: "Ship roadmap",
      },
      project
    );

    expect(task.id).toBe("forgejo:https://code.example.com/acme/roadmap#42");
    expect(task.status).toBe("active");
    expect(task.priority).toBe("medium");
  });
});
