import {
  createInitialForgejoFieldSync,
  validateForgejoFieldSync,
  resolveForgejoDeferredPulls,
} from "@/forgejo-v7-ledger";
import type { ForgejoPendingPull } from "@/forgejo-pull-checkpoint";
import {
  createInitialForgejoRuntimeState,
  createFileForgejoBindingRuntimeStore,
} from "@/forgejo-runtime";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const bindingId = "ibind-ledger" as never;
const original: ForgejoPendingPull = {
  checkpoint: { id: "captured-original", scope: "scope" },
  issueCursor: "2026-01-01T00:00:00.000Z",
  commentCursor: "2026-01-01T00:00:00.000Z",
  result: {
    tasks: [],
    comments: [
      {
        externalId: "61",
        externalTaskId: "remote",
        body: "Captured body",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
  itemUpserts: [],
  itemRemovals: [],
  commentUpserts: [],
  commentRemovals: [],
};

describe("v7 durable field-sync ledger", () => {
  it("keeps legacy runtime state readable without inventing field history", () => {
    const state = createInitialForgejoRuntimeState(bindingId);
    expect(state.pendingPull).toBeNull();
    expect(state.fieldSync).toBeUndefined();
    expect(createInitialForgejoFieldSync()).toEqual({
      version: 7,
      pending: null,
      retryIssueNumbers: [],
      remoteWrites: {},
    });
  });

  it("retains exact deferred originals, deduplicates unchanged polling and releases only applied references", () => {
    const first = resolveForgejoDeferredPulls(undefined, new Set(), {
      original,
      externalIds: ["remote"],
    });
    expect(first[0].original).toEqual(original);
    expect(() =>
      validateForgejoFieldSync(
        { ...createInitialForgejoFieldSync(), scope: "scope", deferredPulls: first },
        bindingId
      )
    ).not.toThrow();
    const another = {
      ...structuredClone(original),
      checkpoint: { id: "later-capture", scope: "scope" },
    };
    expect(
      resolveForgejoDeferredPulls(first, new Set(), { original: another, externalIds: ["remote"] })
    ).toEqual(first);
    another.result.comments![0].body = "New captured body";
    const changed = resolveForgejoDeferredPulls(first, new Set(), {
      original: another,
      externalIds: ["remote"],
    });
    expect(changed).toHaveLength(2);
    expect(changed[0].original.result.comments![0].body).toBe("Captured body");
    expect(changed[1].original.result.comments![0].body).toBe("New captured body");
    expect(resolveForgejoDeferredPulls(changed, new Set(["remote"]))).toEqual([]);
    expect(original.result.comments![0].body).toBe("Captured body");
  });
  it.each([
    null,
    {},
    { version: 6 },
    { ...createInitialForgejoFieldSync(), retryIssueNumbers: [0] },
    {
      ...createInitialForgejoFieldSync(),
      remoteWrites: {
        bad: { issueNumber: 1, localTaskId: "task-x", groups: { workflow: { status: "invalid" } } },
      },
    },
    { ...createInitialForgejoFieldSync(), pending: {} },
    {
      ...createInitialForgejoFieldSync(),
      scope: "scope",
      deferredPulls: [{ original, externalIds: ["unreferenced"] }],
    },
    {
      ...createInitialForgejoFieldSync(),
      scope: "other-scope",
      deferredPulls: [{ original, externalIds: ["remote"] }],
    },
    { ...createInitialForgejoFieldSync(), scope: "scope", deferredAssignments: [0] },
    { ...createInitialForgejoFieldSync(), scope: "scope", deferredCommentIssueNumbers: ["7"] },
    { ...createInitialForgejoFieldSync(), deferredAssignments: [7] },
    {
      ...createInitialForgejoFieldSync(),
      scope: "scope",
      remoteWrites: {
        remote: {
          issueNumber: 1,
          localTaskId: "task-x",
          groups: { content: { title: " padded ", description: "Body" } },
        },
      },
    },
    { ...createInitialForgejoFieldSync(), retryIssueNumbers: [7] },
    {
      ...createInitialForgejoFieldSync(),
      scope: "scope",
      remoteWrites: { remote: { issueNumber: 1, localTaskId: "task-x" } },
    },
    {
      ...createInitialForgejoFieldSync(),
      scope: "scope",
      remoteWrites: { remote: { issueNumber: 1, localTaskId: "task-x", groups: {} } },
    },
  ])("fails closed on malformed field state %j", (entry) => {
    expect(() => validateForgejoFieldSync(entry, bindingId)).toThrow(/field-sync/i);
  });

  it("retains independent remote writes and deferred reads across file-store restart", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-v7-ledger-"));
    try {
      const file = path.join(directory, "runtime.json");
      const state = {
        ...createInitialForgejoRuntimeState(bindingId),
        fieldSync: {
          ...createInitialForgejoFieldSync(),
          scope: "binding/project/repository",
          retryIssueNumbers: [7],
          remoteWrites: {
            "remote-id": {
              issueNumber: 7,
              localTaskId: "task-x" as never,
              groups: { workflow: { status: "done" as const } },
            },
          },
        },
      };
      createFileForgejoBindingRuntimeStore(file).save(state);
      expect(createFileForgejoBindingRuntimeStore(file).get(bindingId)).toEqual(state);
      const corrupt = JSON.parse(fs.readFileSync(file, "utf8"));
      corrupt[0].fieldSync.version = 99;
      fs.writeFileSync(file, JSON.stringify(corrupt));
      expect(() => createFileForgejoBindingRuntimeStore(file).get(bindingId)).toThrow(
        /field-sync/i
      );
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  });
});
