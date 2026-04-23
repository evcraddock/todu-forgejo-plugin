import {
  createIntegrationBindingId,
  createNoteId,
  createProjectId,
  createTaskId,
  type ExportedCommentInput,
  type ExportedTaskInput,
  type IntegrationBinding,
} from "@todu/core";

import {
  createInMemoryForgejoCommentLinkStore,
  type ForgejoCommentLink,
} from "@/forgejo-comment-links";
import {
  formatAttributedBody,
  formatForgejoAttribution,
  formatToduAttribution,
  hasForgejoAttribution,
  pullComments,
  pushComments,
  stripAttribution,
} from "@/forgejo-comments";
import { createInMemoryForgejoIssueClient } from "@/forgejo-client";
import { createLinkFromTask, createInMemoryForgejoItemLinkStore } from "@/forgejo-links";

const binding: IntegrationBinding = {
  id: createIntegrationBindingId("binding-1"),
  provider: "forgejo",
  projectId: createProjectId("project-1"),
  targetKind: "repository",
  targetRef: "erik/todu-forgejo-plugin-test",
  strategy: "bidirectional",
  enabled: true,
  createdAt: "2026-03-12T00:00:00.000Z",
  updatedAt: "2026-03-12T00:00:00.000Z",
};

const target = {
  baseUrl: "https://forgejo.caradoc.com",
  apiBaseUrl: "https://forgejo.caradoc.com/api/v1",
  owner: "erik",
  repo: "todu-forgejo-plugin-test",
};

function createTask(
  comments: ExportedCommentInput[],
  updatedAt = "2026-03-12T00:00:00.000Z"
): ExportedTaskInput {
  return {
    localTaskId: createTaskId("task-1"),
    title: "Sync comments",
    description: "Test task",
    status: "active",
    priority: "medium",
    labels: [],
    assignees: [],
    comments,
    updatedAt,
  };
}

describe("forgejo comments", () => {
  it("formats and strips attribution headers without nesting", () => {
    const body = formatAttributedBody(
      formatToduAttribution("bob", "2026-03-12T00:00:00.000Z"),
      "Original body"
    );

    expect(stripAttribution(body)).toBe("Original body");
    expect(
      hasForgejoAttribution(
        formatAttributedBody(formatForgejoAttribution("alice", "2026-03-12T00:00:00.000Z"), "Body")
      )
    ).toBe(true);
  });

  it("pulls forgejo comments, strips existing attribution, and creates durable comment links", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const itemLinkStore = createInMemoryForgejoItemLinkStore();
    const commentLinkStore = createInMemoryForgejoCommentLinkStore();

    itemLinkStore.save(
      createLinkFromTask({
        binding,
        taskId: createTaskId("task-1"),
        baseUrl: target.baseUrl,
        owner: target.owner,
        repo: target.repo,
        issueNumber: 7,
      })
    );

    issueClient.seedComments(target, 7, [
      {
        id: 11,
        issueNumber: 7,
        body: formatAttributedBody(
          formatToduAttribution("bob", "2026-03-12T00:00:00.000Z"),
          "Plain comment body"
        ),
        author: "alice",
        createdAt: "2026-03-12T01:00:00.000Z",
        updatedAt: "2026-03-12T02:00:00.000Z",
      },
    ]);

    const result = await pullComments({
      binding,
      issueClient,
      target,
      itemLinkStore,
      commentLinkStore,
    });

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject({
      externalId: "11",
      externalTaskId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#7",
      author: expect.objectContaining({ externalLogin: "alice", displayName: "alice" }),
      createdAt: "2026-03-12T01:00:00.000Z",
      updatedAt: "2026-03-12T02:00:00.000Z",
    });
    expect(result.comments[0].body).toBe(
      "_Synced from Forgejo comment by @alice on 2026-03-12T01:00:00.000Z_\n\nPlain comment body"
    );
    expect(result.createdLinks).toHaveLength(1);
    expect(commentLinkStore.getByForgejoCommentId(binding.id, 11)).toMatchObject({
      noteId: "external:11",
      lastMirroredBody: "Plain comment body",
    });
  });

  it("keeps durable links when forgejo comments are deleted remotely", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const itemLinkStore = createInMemoryForgejoItemLinkStore();
    const commentLinkStore = createInMemoryForgejoCommentLinkStore();

    itemLinkStore.save(
      createLinkFromTask({
        binding,
        taskId: createTaskId("task-1"),
        baseUrl: target.baseUrl,
        owner: target.owner,
        repo: target.repo,
        issueNumber: 7,
      })
    );

    const existingLink: ForgejoCommentLink = {
      bindingId: binding.id,
      taskId: createTaskId("task-1"),
      noteId: createNoteId("external:11"),
      issueNumber: 7,
      forgejoCommentId: 11,
      lastMirroredAt: "2026-03-12T01:00:00.000Z",
      lastMirroredBody: "Plain comment body",
    };
    commentLinkStore.save(existingLink);

    const result = await pullComments({
      binding,
      issueClient,
      target,
      itemLinkStore,
      commentLinkStore,
    });

    expect(result).toMatchObject({ comments: [], createdLinks: [] });
    expect(commentLinkStore.getByForgejoCommentId(binding.id, 11)).toEqual(existingLink);
  });

  it("supports since-based comment pulls and touched issue filtering", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const itemLinkStore = createInMemoryForgejoItemLinkStore();
    const commentLinkStore = createInMemoryForgejoCommentLinkStore();

    itemLinkStore.save(
      createLinkFromTask({
        binding,
        taskId: createTaskId("task-7"),
        baseUrl: target.baseUrl,
        owner: target.owner,
        repo: target.repo,
        issueNumber: 7,
      })
    );
    itemLinkStore.save(
      createLinkFromTask({
        binding,
        taskId: createTaskId("task-8"),
        baseUrl: target.baseUrl,
        owner: target.owner,
        repo: target.repo,
        issueNumber: 8,
      })
    );

    commentLinkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-7"),
      noteId: createNoteId("external:11"),
      issueNumber: 7,
      forgejoCommentId: 11,
      lastMirroredAt: "2026-03-12T01:00:00.000Z",
      lastMirroredBody: "Older body",
    });

    issueClient.seedComments(target, 7, [
      {
        id: 11,
        issueNumber: 7,
        body: "Older body",
        author: "alice",
        createdAt: "2026-03-12T01:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
      {
        id: 12,
        issueNumber: 7,
        body: "Newer body",
        author: "alice",
        createdAt: "2026-03-12T03:00:00.000Z",
        updatedAt: "2026-03-12T03:00:00.000Z",
      },
    ]);
    issueClient.seedComments(target, 8, [
      {
        id: 21,
        issueNumber: 8,
        body: "Other issue body",
        author: "bob",
        createdAt: "2026-03-12T04:00:00.000Z",
        updatedAt: "2026-03-12T04:00:00.000Z",
      },
    ]);

    const result = await pullComments({
      binding,
      issueClient,
      target,
      itemLinkStore,
      commentLinkStore,
      issueNumbers: [7],
      since: "2026-03-12T02:00:00.000Z",
    });

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].externalId).toBe("12");
    expect(commentLinkStore.getByForgejoCommentId(binding.id, 11)).not.toBeNull();
    expect(commentLinkStore.getByForgejoCommentId(binding.id, 21)).toBeNull();
  });

  it("pushes local notes to forgejo, updates linked comments, and prunes stale links for removed local notes", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const itemLinkStore = createInMemoryForgejoItemLinkStore();
    const commentLinkStore = createInMemoryForgejoCommentLinkStore();

    issueClient.seedIssues(target, [
      {
        number: 7,
        externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#7",
        title: "Issue",
        state: "open",
        labels: [],
        assigneeActorIds: [],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);
    issueClient.seedComments(target, 7, [
      {
        id: 21,
        issueNumber: 7,
        body: "Old remote body",
        author: "alice",
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
      {
        id: 22,
        issueNumber: 7,
        body: "Keep me",
        author: "alice",
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    itemLinkStore.save(
      createLinkFromTask({
        binding,
        taskId: createTaskId("task-1"),
        baseUrl: target.baseUrl,
        owner: target.owner,
        repo: target.repo,
        issueNumber: 7,
      })
    );

    commentLinkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-1"),
      noteId: createNoteId("note-existing"),
      issueNumber: 7,
      forgejoCommentId: 21,
      lastMirroredAt: "2026-03-12T00:00:00.000Z",
      lastMirroredBody: "Old remote body",
    });
    commentLinkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-1"),
      noteId: createNoteId("note-delete"),
      issueNumber: 7,
      forgejoCommentId: 22,
      lastMirroredAt: "2026-03-12T00:00:00.000Z",
      lastMirroredBody: "Keep me",
    });

    const task = createTask(
      [
        {
          localNoteId: createNoteId("note-existing"),
          body: "Updated local body",
          createdAt: "2026-03-12T03:00:00.000Z",
        },
        {
          localNoteId: createNoteId("note-new"),
          body: "Brand new local note",
          createdAt: "2026-03-12T04:00:00.000Z",
        },
      ],
      "2026-03-12T04:30:00.000Z"
    );

    let listCommentsCalls = 0;
    const originalListComments = issueClient.listComments.bind(issueClient);
    issueClient.listComments = async (...args) => {
      listCommentsCalls += 1;
      return originalListComments(...args);
    };

    const result = await pushComments({
      binding,
      issueClient,
      target,
      tasks: [task],
      itemLinkStore,
      commentLinkStore,
    });

    expect(listCommentsCalls).toBe(0);
    expect(result.updatedComments).toHaveLength(1);
    expect(result.updatedComments[0].id).toBe(21);
    expect(result.updatedComments[0].body).toBe(
      "_Synced from todu comment by @todu on 2026-03-12T03:00:00.000Z_\n\nUpdated local body"
    );
    expect(result.createdComments).toHaveLength(1);
    expect(result.createdComments[0].body).toBe(
      "_Synced from todu comment by @todu on 2026-03-12T04:00:00.000Z_\n\nBrand new local note"
    );
    expect(commentLinkStore.getByNoteId(binding.id, createNoteId("note-new"))).toMatchObject({
      lastMirroredBody: "Brand new local note",
    });
    expect(commentLinkStore.getByNoteId(binding.id, createNoteId("note-existing"))).toMatchObject({
      lastMirroredBody: "Updated local body",
    });
    expect(commentLinkStore.getByNoteId(binding.id, createNoteId("note-delete"))).toBeNull();
    expect(issueClient.snapshotComments(target, 7).map((comment) => comment.id)).toEqual([
      21, 22, 23,
    ]);
    expect(result.commentLinks).toHaveLength(2);
    expect(result.commentLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          localNoteId: createNoteId("note-existing"),
          externalTaskId: createTaskId("task-1"),
          externalCommentId: "21",
        }),
        expect.objectContaining({
          localNoteId: createNoteId("note-new"),
          externalTaskId: createTaskId("task-1"),
        }),
      ])
    );
  });

  it("pushes edits made to imported forgejo notes back to forgejo when the local note changed", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const itemLinkStore = createInMemoryForgejoItemLinkStore();
    const commentLinkStore = createInMemoryForgejoCommentLinkStore();

    issueClient.seedIssues(target, [
      {
        number: 7,
        externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#7",
        title: "Issue",
        state: "open",
        labels: [],
        assigneeActorIds: [],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);
    issueClient.seedComments(target, 7, [
      {
        id: 21,
        issueNumber: 7,
        body: "Imported body",
        author: "alice",
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T01:00:00.000Z",
      },
    ]);

    itemLinkStore.save(
      createLinkFromTask({
        binding,
        taskId: createTaskId("task-1"),
        baseUrl: target.baseUrl,
        owner: target.owner,
        repo: target.repo,
        issueNumber: 7,
      })
    );
    commentLinkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-1"),
      noteId: createNoteId("external:21"),
      issueNumber: 7,
      forgejoCommentId: 21,
      lastMirroredAt: "2026-03-12T01:00:00.000Z",
      lastMirroredBody: "Imported body",
    });

    const task = createTask(
      [
        {
          localNoteId: createNoteId("external:21"),
          body: formatAttributedBody(
            formatForgejoAttribution("alice", "2026-03-12T00:00:00.000Z"),
            "Edited imported body"
          ),
          createdAt: "2026-03-12T00:00:00.000Z",
        },
      ],
      "2026-03-12T03:00:00.000Z"
    );

    const result = await pushComments({
      binding,
      issueClient,
      target,
      tasks: [task],
      itemLinkStore,
      commentLinkStore,
    });

    expect(result.updatedComments).toHaveLength(1);
    expect(result.updatedComments[0].body).toBe(
      "_Synced from todu comment by @todu on 2026-03-12T00:00:00.000Z_\n\nEdited imported body"
    );
    expect(commentLinkStore.getByNoteId(binding.id, createNoteId("external:21"))).toMatchObject({
      lastMirroredBody: "Edited imported body",
    });
  });

  it("removes stale comment links for missing local notes before pushing", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const itemLinkStore = createInMemoryForgejoItemLinkStore();
    const commentLinkStore = createInMemoryForgejoCommentLinkStore();

    issueClient.seedIssues(target, [
      {
        number: 7,
        externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#7",
        title: "Issue",
        state: "open",
        labels: [],
        assigneeActorIds: [],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    itemLinkStore.save(
      createLinkFromTask({
        binding,
        taskId: createTaskId("task-1"),
        baseUrl: target.baseUrl,
        owner: target.owner,
        repo: target.repo,
        issueNumber: 7,
      })
    );
    commentLinkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-1"),
      noteId: createNoteId("note-stale"),
      issueNumber: 7,
      forgejoCommentId: 21,
      lastMirroredAt: "2026-03-12T01:00:00.000Z",
      lastMirroredBody: "Old local body",
    });
    commentLinkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-1"),
      noteId: createNoteId("note-existing"),
      issueNumber: 7,
      forgejoCommentId: 22,
      lastMirroredAt: "2026-03-12T01:00:00.000Z",
      lastMirroredBody: "Existing body",
    });

    const staleLinks: ForgejoCommentLink[] = [];
    const result = await pushComments({
      binding,
      issueClient,
      target,
      tasks: [
        createTask([
          {
            localNoteId: createNoteId("note-existing"),
            body: "Existing body",
            createdAt: "2026-03-12T01:00:00.000Z",
          },
        ]),
      ],
      itemLinkStore,
      commentLinkStore,
      onStaleLink: ({ commentLink }) => {
        staleLinks.push(commentLink);
      },
    });

    expect(result.createdComments).toHaveLength(0);
    expect(result.updatedComments).toHaveLength(0);
    expect(result.commentLinks).toHaveLength(1);
    expect(staleLinks).toEqual([
      expect.objectContaining({ noteId: createNoteId("note-stale"), forgejoCommentId: 21 }),
    ]);
    expect(commentLinkStore.getByNoteId(binding.id, createNoteId("note-stale"))).toBeNull();
    expect(commentLinkStore.getByNoteId(binding.id, createNoteId("note-existing"))).not.toBeNull();
  });

  it("reconciles note-tag comment linkage conflicts to the canonical forgejo comment id during push", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const itemLinkStore = createInMemoryForgejoItemLinkStore();
    const commentLinkStore = createInMemoryForgejoCommentLinkStore();

    issueClient.seedIssues(target, [
      {
        number: 7,
        externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#7",
        title: "Issue",
        state: "open",
        labels: [],
        assigneeActorIds: [],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    itemLinkStore.save(
      createLinkFromTask({
        binding,
        taskId: createTaskId("task-1"),
        baseUrl: target.baseUrl,
        owner: target.owner,
        repo: target.repo,
        issueNumber: 7,
      })
    );
    commentLinkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-1"),
      noteId: createNoteId("note-real"),
      issueNumber: 7,
      forgejoCommentId: 99,
      lastMirroredAt: "2026-03-12T05:00:00.000Z",
      lastMirroredBody: "Remote changed body",
    });

    const result = await pushComments({
      binding,
      issueClient,
      target,
      tasks: [
        createTask([
          {
            localNoteId: createNoteId("note-real"),
            body: "Remote changed body",
            createdAt: "2026-03-12T00:00:00.000Z",
          },
        ]),
      ],
      itemLinkStore,
      commentLinkStore,
      loadTaskNotes: async () => [
        { id: String(createNoteId("note-real")), tags: ["sync:externalId:21"] },
      ],
    });

    expect(result.commentLinks).toEqual([
      expect.objectContaining({
        localNoteId: createNoteId("note-real"),
        externalTaskId: createTaskId("task-1"),
        externalCommentId: "21",
      }),
    ]);
    expect(commentLinkStore.getByNoteId(binding.id, createNoteId("note-real"))).toMatchObject({
      forgejoCommentId: 21,
      lastMirroredBody: "Remote changed body",
    });
  });

  it("reconciles legacy imported comment links to real local note ids during push", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const itemLinkStore = createInMemoryForgejoItemLinkStore();
    const commentLinkStore = createInMemoryForgejoCommentLinkStore();

    issueClient.seedIssues(target, [
      {
        number: 7,
        externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#7",
        title: "Issue",
        state: "open",
        labels: [],
        assigneeActorIds: [],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    itemLinkStore.save(
      createLinkFromTask({
        binding,
        taskId: createTaskId("task-1"),
        baseUrl: target.baseUrl,
        owner: target.owner,
        repo: target.repo,
        issueNumber: 7,
      })
    );
    commentLinkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-legacy"),
      noteId: createNoteId("external:21"),
      issueNumber: 7,
      forgejoCommentId: 21,
      lastMirroredAt: "2026-03-12T05:00:00.000Z",
      lastMirroredBody: "Remote changed body",
    });

    const task: ExportedTaskInput = {
      localTaskId: createTaskId("task-1"),
      externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#7",
      title: "Sync comments",
      description: "Test task",
      status: "active",
      priority: "medium",
      labels: [],
      assignees: [],
      updatedAt: "2026-03-12T04:00:00.000Z",
      comments: [
        {
          localNoteId: createNoteId("note-real"),
          body: formatAttributedBody(
            formatForgejoAttribution("alice", "2026-03-12T00:00:00.000Z"),
            "Remote changed body"
          ),
          createdAt: "2026-03-12T00:00:00.000Z",
        },
      ],
    };

    const result = await pushComments({
      binding,
      issueClient,
      target,
      tasks: [task],
      itemLinkStore,
      commentLinkStore,
    });

    expect(result.updatedComments).toHaveLength(0);
    expect(result.createdComments).toHaveLength(0);
    expect(result.commentLinks).toEqual([
      expect.objectContaining({ localNoteId: createNoteId("note-real"), externalCommentId: "21" }),
    ]);
    expect(commentLinkStore.getByNoteId(binding.id, createNoteId("note-real"))).toMatchObject({
      taskId: createTaskId("task-1"),
      forgejoCommentId: 21,
      lastMirroredBody: "Remote changed body",
    });
    expect(commentLinkStore.getByNoteId(binding.id, createNoteId("external:21"))).toBeNull();
  });

  it("skips unchanged linked notes and ignores unlinked imported notes", async () => {
    const issueClient = createInMemoryForgejoIssueClient();
    const itemLinkStore = createInMemoryForgejoItemLinkStore();
    const commentLinkStore = createInMemoryForgejoCommentLinkStore();

    issueClient.seedIssues(target, [
      {
        number: 7,
        externalId: "https://forgejo.caradoc.com/erik/todu-forgejo-plugin-test#7",
        title: "Issue",
        state: "open",
        labels: [],
        assigneeActorIds: [],
        assignees: [],
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);
    issueClient.seedComments(target, 7, [
      {
        id: 21,
        issueNumber: 7,
        body: "Remote changed body",
        author: "alice",
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T05:00:00.000Z",
      },
    ]);

    itemLinkStore.save(
      createLinkFromTask({
        binding,
        taskId: createTaskId("task-1"),
        baseUrl: target.baseUrl,
        owner: target.owner,
        repo: target.repo,
        issueNumber: 7,
      })
    );
    commentLinkStore.save({
      bindingId: binding.id,
      taskId: createTaskId("task-1"),
      noteId: createNoteId("external:21"),
      issueNumber: 7,
      forgejoCommentId: 21,
      lastMirroredAt: "2026-03-12T05:00:00.000Z",
      lastMirroredBody: "Remote changed body",
    });

    const task = createTask(
      [
        {
          localNoteId: createNoteId("external:21"),
          body: formatAttributedBody(
            formatForgejoAttribution("alice", "2026-03-12T00:00:00.000Z"),
            "Remote changed body"
          ),
          createdAt: "2026-03-12T00:00:00.000Z",
        },
        {
          localNoteId: createNoteId("external:99"),
          body: formatAttributedBody(
            formatForgejoAttribution("alice", "2026-03-12T00:00:00.000Z"),
            "Unlinked imported body"
          ),
          createdAt: "2026-03-12T00:00:00.000Z",
        },
      ],
      "2026-03-12T04:00:00.000Z"
    );

    const result = await pushComments({
      binding,
      issueClient,
      target,
      tasks: [task],
      itemLinkStore,
      commentLinkStore,
    });

    expect(result.updatedComments).toHaveLength(0);
    expect(result.createdComments).toHaveLength(0);
    expect(result.commentLinks).toHaveLength(1);
    expect(commentLinkStore.getByNoteId(binding.id, createNoteId("external:21"))).toMatchObject({
      lastMirroredBody: "Remote changed body",
    });
    expect(commentLinkStore.getByNoteId(binding.id, createNoteId("external:99"))).toBeNull();
  });
});
