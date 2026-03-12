import { createIntegrationBindingId, createProjectId, type IntegrationBinding } from "@todu/core";

import {
  FORGEJO_PROVIDER_NAME,
  FORGEJO_REPOSITORY_TARGET_KIND,
  ForgejoBindingValidationError,
  parseForgejoBinding,
  parseForgejoRepositoryTargetRef,
} from "@/forgejo-binding";

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

describe("forgejo binding", () => {
  it("parses a valid owner/repo target ref", () => {
    expect(parseForgejoRepositoryTargetRef(" acme/roadmap ")).toEqual({
      owner: "acme",
      repo: "roadmap",
    });
  });

  it("rejects malformed target refs", () => {
    expect(() => parseForgejoRepositoryTargetRef("acme")).toThrow(ForgejoBindingValidationError);
    expect(() => parseForgejoRepositoryTargetRef("acme/")).toThrow(ForgejoBindingValidationError);
  });

  it("parses a valid forgejo binding", () => {
    const binding = parseForgejoBinding(createBinding());

    expect(binding.owner).toBe("acme");
    expect(binding.repo).toBe("roadmap");
  });

  it("rejects invalid provider and target kind", () => {
    expect(() => parseForgejoBinding(createBinding({ provider: "github" }))).toThrow(
      ForgejoBindingValidationError
    );
    expect(() => parseForgejoBinding(createBinding({ targetKind: "issue" }))).toThrow(
      ForgejoBindingValidationError
    );
  });
});
