import type { SyncAssigneeIdentity, SyncTaskFieldGroupValues } from "@todu/core";

import {
  equalForgejoFieldSnapshot,
  normalizeForgejoFieldSnapshot,
  normalizeForgejoFieldSnapshots,
} from "@/forgejo-field-snapshots";

const snapshots: SyncTaskFieldGroupValues = {
  content: { title: "Title", description: "Markdown\n\n**body**" },
  workflow: { status: "inprogress" },
  classification: { priority: "high", labels: ["bug", "feature"] },
  assignment: { assignees: [{ externalAccountId: "12" }, { externalLogin: "alice" }] },
};

describe("Forgejo field snapshot normalization", () => {
  it("uses complete core-compatible values for all four independent groups", () => {
    expect(normalizeForgejoFieldSnapshots(snapshots)).toStrictEqual(snapshots);
    expect(normalizeForgejoFieldSnapshots({ content: snapshots.content })).toStrictEqual({
      content: snapshots.content,
    });
    expect(normalizeForgejoFieldSnapshots({})).toStrictEqual({});
  });

  it("preserves title/body bytes, including deliberate empty bodies", () => {
    const content = { title: "  Exact title  ", description: "\n**exact body**\n" };
    expect(normalizeForgejoFieldSnapshot("content", content)).toStrictEqual(content);
    expect(
      normalizeForgejoFieldSnapshot("content", { title: "Title", description: "" }).description
    ).toBe("");
    expect(
      equalForgejoFieldSnapshot("content", snapshots.content, {
        ...snapshots.content,
        description: "Other body",
      })
    ).toBe(false);
  });

  it.each(["active", "inprogress", "waiting", "done", "canceled"] as const)(
    "retains normalized workflow status %s",
    (status) => {
      expect(normalizeForgejoFieldSnapshot("workflow", { status })).toStrictEqual({ status });
    }
  );

  it("deduplicates and sorts shared labels, excluding reserved labels without changing their case", () => {
    const input = {
      priority: "high" as const,
      labels: ["feature", "status:done", "bug", "priority:low", "bug", "Bug"],
    };
    expect(normalizeForgejoFieldSnapshot("classification", input)).toStrictEqual({
      priority: "high",
      labels: ["Bug", "bug", "feature"],
    });
    expect(input.labels).toHaveLength(6);
    expect(
      equalForgejoFieldSnapshot("classification", snapshots.classification, {
        priority: "high",
        labels: ["feature", "bug", "bug"],
      })
    ).toBe(true);
  });

  it("compares assignee sets by stable account ID, with exact login fallback", () => {
    const withDisplayName = {
      externalAccountId: "12",
      externalLogin: "renamed",
      displayName: "New display name",
    } as SyncAssigneeIdentity;
    const input = {
      assignees: [
        { externalLogin: "alice" },
        withDisplayName,
        { externalAccountId: "12", externalLogin: "old-login" },
      ],
    };
    expect(normalizeForgejoFieldSnapshot("assignment", input)).toStrictEqual(snapshots.assignment);
    expect(equalForgejoFieldSnapshot("assignment", snapshots.assignment, input)).toBe(true);
    expect(
      equalForgejoFieldSnapshot("assignment", snapshots.assignment, {
        assignees: [{ externalAccountId: "13" }, { externalLogin: "alice" }],
      })
    ).toBe(false);
    expect(
      normalizeForgejoFieldSnapshot("assignment", {
        assignees: [{ externalAccountId: "alice" }, { externalLogin: "alice" }],
      }).assignees
    ).toHaveLength(2);
    expect(input.assignees[1]).toBe(withDisplayName);
  });

  it("keeps explicit empty label and assignee sets distinct from missing groups", () => {
    expect(
      normalizeForgejoFieldSnapshots({
        classification: { priority: "medium", labels: [] },
        assignment: { assignees: [] },
      })
    ).toStrictEqual({
      classification: { priority: "medium", labels: [] },
      assignment: { assignees: [] },
    });
  });

  it("detaches nested inputs so later mutation cannot change the normalized baseline", () => {
    const input = structuredClone(snapshots);
    const normalized = normalizeForgejoFieldSnapshots(input);
    input.classification.labels.push("later");
    input.assignment.assignees[0].externalAccountId = "changed";
    expect(normalized).toStrictEqual(snapshots);
  });

  it.each([
    null,
    [],
    new Map(),
    new Date("2026-03-12T00:00:00Z"),
    { unknown: {} },
    { content: { title: "Title" } },
    { workflow: { status: "invalid" } },
    { classification: { priority: "medium", labels: [null] } },
    { assignment: { assignees: [{ displayName: "Not an identity" }] } },
    { assignment: { assignees: [{ externalAccountId: "" }] } },
  ])("rejects incomplete/malformed snapshots rather than guessing values: %j", (input) => {
    expect(() => normalizeForgejoFieldSnapshots(input)).toThrow("Invalid Forgejo field snapshot");
  });
});
