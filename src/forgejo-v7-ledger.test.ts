import { createInitialForgejoFieldSync, validateForgejoFieldSync } from "@/forgejo-v7-ledger";
import {
  createInitialForgejoRuntimeState,
  createFileForgejoBindingRuntimeStore,
} from "@/forgejo-runtime";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const bindingId = "ibind-ledger" as never;

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
