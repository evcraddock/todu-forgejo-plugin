import { reconcileSyncTaskFieldGroup } from "@todu/engine";
import type { IntegrationBinding } from "@todu/core";
import {
  forgejoAssignmentLogins,
  forgejoGroupedPatch,
  remoteForgejoGroups,
  selectForgejoPushGroups,
} from "@/forgejo-v7-fields";
const binding = { id: "ibind-test", options: {} } as IntegrationBinding;
const issue = {
  number: 7,
  externalId: "https://code.example/acme/repo#7",
  title: "Title",
  body: "Body",
  state: "open" as const,
  labels: ["status:waiting", "priority:high", "remote-label"],
  assignees: [],
};

describe("v7 selective field decisions", () => {
  it.each([
    ["active", "active", "active"],
    ["active", "done", "active"],
    ["active", "active", "done"],
    ["active", "done", "done"],
    ["active", "waiting", "done"],
    ["canceled", "active", "canceled"],
  ] as const)(
    "matches the published host's three-way workflow selection for %s / %s / %s",
    (baseStatus, localStatus, remoteStatus) => {
      for (const remoteTimestamp of [
        undefined,
        "2026-01-01T00:00:00Z",
        "2026-02-01T00:00:00Z",
        "2026-03-01T00:00:00Z",
      ]) {
        const base = { status: baseStatus },
          local = { status: localStatus },
          remote = { status: remoteStatus };
        const selected = selectForgejoPushGroups({
          base: { workflow: base },
          local: { workflow: local },
          remote: { workflow: remote },
          localTimestamp: "2026-02-01T00:00:00Z",
          remoteTimestamp,
        });
        const expected = reconcileSyncTaskFieldGroup({
          bindingId: binding.id,
          localTaskId: "task-test" as never,
          externalId: issue.externalId,
          group: "workflow",
          local,
          input: { base, remote, ...(remoteTimestamp ? { sourceTimestamp: remoteTimestamp } : {}) },
          localTimestamp: "2026-02-01T00:00:00Z",
        });
        if (!expected.ok) throw new Error(expected.error.message);
        expect(selected.writes.workflow !== undefined).toBe(expected.value.remoteWriteRequired);
        expect(selected.mirrored.workflow !== undefined).toBe(localStatus === remoteStatus);
      }
    }
  );
  it("does not authorize writes for unknown disagreements or incomplete observations", () => {
    const selected = selectForgejoPushGroups({
      base: {},
      local: { workflow: { status: "active" } },
      remote: { workflow: { status: "done" } },
      localTimestamp: "2026-01-01T00:00:00Z",
    });
    expect(selected.writes).toEqual({});
    expect(selected.unresolved).toBe(true);
  });
  it("preserves classification labels during a workflow-only write", () => {
    expect(forgejoGroupedPatch({ workflow: { status: "done" } }, issue, binding).patch).toEqual({
      state: "closed",
      labels: ["priority:high", "remote-label", "status:done"],
    });
  });
  it("preserves workflow labels during a classification-only write", () => {
    expect(
      forgejoGroupedPatch(
        { classification: { priority: "low", labels: ["local-label"] } },
        issue,
        binding
      ).patch
    ).toEqual({ labels: ["local-label", "priority:low", "status:waiting"] });
  });
  it("combines workflow/classification without leaking content or assignment fields", () => {
    expect(
      forgejoGroupedPatch(
        { workflow: { status: "done" }, classification: { priority: "low", labels: [] } },
        issue,
        binding
      ).patch
    ).toEqual({ state: "closed", labels: ["priority:low", "status:done"] });
  });
  it("allows a complete empty assignment but never uses display names/account IDs as usernames", () => {
    expect(forgejoAssignmentLogins({ assignees: [] }, binding)).toEqual([]);
    expect(
      forgejoAssignmentLogins({ assignees: [{ externalAccountId: "42" }] }, binding)
    ).toBeNull();
    const result = forgejoGroupedPatch(
      {
        content: { title: "Local", description: "" },
        assignment: { assignees: [{ externalAccountId: "42" }] },
      },
      issue,
      binding
    );
    expect(result).toEqual({
      patch: { title: "Local", body: "" },
      writable: { content: { title: "Local", description: "" } },
    });
  });
  it("canonicalizes login aliases through mappings and never drops an unidentified remote assignee", () => {
    const mapped = {
      ...binding,
      options: {
        actorMappings: [
          { actorId: "actor-a" as never, externalLogin: "alice", externalAccountId: "42" },
        ],
      },
    };
    expect(remoteForgejoGroups({ ...issue, assignees: ["alice"] }, mapped).assignment).toEqual({
      assignees: [{ externalAccountId: "42" }],
    });
    expect(
      remoteForgejoGroups({ ...issue, assignees: ["alice", { displayName: "Unknown" }] }, mapped)
        .assignment
    ).toBeUndefined();
  });
});
