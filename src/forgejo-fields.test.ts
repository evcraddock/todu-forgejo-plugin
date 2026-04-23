import {
  createForgejoIssueCreateFromTask,
  getNormalForgejoLabels,
  normalizeForgejoIssuePriority,
  normalizeForgejoIssueStatus,
} from "@/forgejo-fields";

describe("forgejo fields", () => {
  it("maps task fields into forgejo issue payloads", () => {
    const payload = createForgejoIssueCreateFromTask({
      localTaskId: "task-1" as never,
      title: "Ship feature",
      description: "Markdown body",
      status: "inprogress",
      priority: "high",
      labels: ["bug", "priority:low"],
      assignees: [],
      updatedAt: "2026-03-12T00:00:00.000Z",
      comments: [],
    });

    expect(payload).toEqual({
      title: "Ship feature",
      body: "Markdown body",
      state: "open",
      labels: ["bug", "status:inprogress", "priority:high"],
    });
  });

  it("normalizes forgejo issue status deterministically", () => {
    expect(normalizeForgejoIssueStatus("open", ["status:waiting", "status:active"])).toEqual({
      state: "open",
      status: "active",
      statusLabel: "status:active",
    });

    expect(normalizeForgejoIssueStatus("closed", ["status:canceled"])).toEqual({
      state: "closed",
      status: "canceled",
      statusLabel: "status:canceled",
    });
  });

  it("normalizes forgejo issue priority deterministically", () => {
    expect(normalizeForgejoIssuePriority(["priority:low", "priority:high"])).toEqual({
      priority: "high",
      priorityLabel: "priority:high",
    });
  });

  it("filters reserved labels from normal labels", () => {
    expect(
      getNormalForgejoLabels(["bug", "status:active", "priority:medium", "needs-review"])
    ).toEqual(["bug", "needs-review"]);
  });
});
