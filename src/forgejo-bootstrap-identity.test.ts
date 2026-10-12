import {
  createIntegrationBindingId,
  createNoteId,
  createProjectId,
  createTaskId,
  type ExportedTaskInput,
  type IntegrationBinding,
} from "@todu/core";

import { bootstrapTasksToForgejoIssues } from "@/forgejo-bootstrap";
import { createInMemoryForgejoIssueClient } from "@/forgejo-client";
import { createInMemoryForgejoCommentLinkStore } from "@/forgejo-comment-links";
import { createImportedTaskId } from "@/forgejo-ids";
import { createInMemoryForgejoItemLinkStore } from "@/forgejo-links";

const binding: IntegrationBinding = {
  id: createIntegrationBindingId("binding-identity"),
  projectId: createProjectId("project-identity"),
  provider: "forgejo",
  targetKind: "repository",
  targetRef: "acme/roadmap",
  strategy: "bidirectional",
  enabled: true,
  createdAt: "2026-03-12T00:00:00.000Z",
  updatedAt: "2026-03-12T00:00:00.000Z",
};
const target = {
  baseUrl: "https://code.example.com",
  apiBaseUrl: "https://code.example.com/api/v1",
  owner: "acme",
  repo: "roadmap",
};
const externalId = `${target.baseUrl}/acme/roadmap#9`;

function task(overrides: Partial<ExportedTaskInput> = {}): ExportedTaskInput {
  return {
    localTaskId: createTaskId("task-original"),
    title: "Original task",
    description: "Preserve this content",
    status: "active",
    priority: "medium",
    labels: [],
    assignees: [],
    comments: [],
    updatedAt: "2026-03-12T01:00:00.000Z",
    ...overrides,
  };
}

describe("bootstrap identity protection", () => {
  it.each(["stored hydration", "stored update", "external ID", "source URL", "imported ID"])(
    "retains unavailable %s identity without creating or metadata-relinking",
    async (reference) => {
      const issueClient = createInMemoryForgejoIssueClient();
      const linkStore = createInMemoryForgejoItemLinkStore();
      const commentLinkStore = createInMemoryForgejoCommentLinkStore();
      let original: ExportedTaskInput;
      if (reference.startsWith("stored")) {
        original = task({ externalId });
        linkStore.save({
          bindingId: binding.id,
          taskId: original.localTaskId,
          issueNumber: 9,
          externalId,
          ...(reference === "stored update" ? { lastMirroredAt: "2026-03-12T00:00:00.000Z" } : {}),
          fieldSnapshots: {
            content: { title: "Original task", description: "Preserve this content" },
          },
        });
        commentLinkStore.save({
          bindingId: binding.id,
          taskId: original.localTaskId,
          noteId: createNoteId("note-original"),
          issueNumber: 9,
          forgejoCommentId: 11,
          lastMirroredAt: "2026-03-12T00:00:00.000Z",
          lastMirroredBody: "Preserve this comment baseline",
        });
      } else if (reference === "external ID") {
        original = task({ externalId });
      } else if (reference === "source URL") {
        original = task({ sourceUrl: `${target.baseUrl}/acme/roadmap/issues/9` });
      } else {
        original = task({ localTaskId: createImportedTaskId(externalId) });
      }
      // Even a unique metadata match is not permission to replace explicit identity.
      issueClient.seedIssues(target, [
        {
          number: 62,
          externalId: `${target.baseUrl}/acme/roadmap#62`,
          title: original.title,
          body: original.description,
          state: "open",
          labels: ["status:active", "priority:medium"],
          assignees: [],
          createdAt: "2026-03-12T00:00:00.000Z",
        },
      ]);
      const originalLinks = linkStore.listAll();
      const originalComments = commentLinkStore.listAll();
      const createIssue = vi.spyOn(issueClient, "createIssue");
      for (let retry = 0; retry < 2; retry++) {
        await expect(
          bootstrapTasksToForgejoIssues({
            binding,
            ...target,
            tasks: [original],
            issueClient,
            linkStore,
            commentLinkStore,
          })
        ).rejects.toThrow("explicit identity repair");
        expect(linkStore.listAll()).toEqual(originalLinks);
        expect(commentLinkStore.listAll()).toEqual(originalComments);
        expect(issueClient.snapshotIssues(target)).toHaveLength(1);
        expect(createIssue).not.toHaveBeenCalled();
      }
    }
  );

  it.each(["persisted link mismatch", "foreign external ID"])(
    "blocks %s before processing any remote writes",
    async (conflict) => {
      const issueClient = createInMemoryForgejoIssueClient();
      const linkStore = createInMemoryForgejoItemLinkStore();
      const original = task({
        externalId: conflict === "foreign external ID" ? "other-provider:9" : externalId,
      });
      if (conflict === "persisted link mismatch") {
        linkStore.save({
          bindingId: binding.id,
          taskId: original.localTaskId,
          issueNumber: 62,
          externalId: `${target.baseUrl}/acme/roadmap#62`,
        });
      }
      const originalLinks = linkStore.listAll();
      const createIssue = vi.spyOn(issueClient, "createIssue");
      const updateIssue = vi.spyOn(issueClient, "updateIssue");
      const createLabel = vi.spyOn(issueClient, "createLabel");
      await expect(
        bootstrapTasksToForgejoIssues({
          binding,
          ...target,
          tasks: [
            task({ localTaskId: createTaskId("task-new"), title: "Unlinked new task" }),
            original,
          ],
          issueClient,
          linkStore,
        })
      ).rejects.toThrow("explicit identity repair");
      expect(createIssue).not.toHaveBeenCalled();
      expect(updateIssue).not.toHaveBeenCalled();
      expect(createLabel).not.toHaveBeenCalled();
      expect(linkStore.listAll()).toEqual(originalLinks);
    }
  );
});
