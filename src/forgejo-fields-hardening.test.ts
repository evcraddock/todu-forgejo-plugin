import {
  createForgejoIssueCreateFromTask,
  createForgejoStatusFromTask,
  createForgejoPriorityFromTask,
  getNormalForgejoLabels,
  mergeForgejoLabels,
  normalizeForgejoIssuePriority,
  normalizeForgejoIssueStatus,
} from "@/forgejo-fields";

describe("status normalization edge cases", () => {
  it("defaults open issue without status label to active", () => {
    expect(normalizeForgejoIssueStatus("open", [])).toEqual({
      state: "open",
      status: "active",
      statusLabel: "status:active",
    });
  });

  it("defaults open issue with unknown status label to active", () => {
    expect(normalizeForgejoIssueStatus("open", ["status:unknown"])).toEqual({
      state: "open",
      status: "active",
      statusLabel: "status:active",
    });
  });

  it("defaults closed issue without status label to done", () => {
    expect(normalizeForgejoIssueStatus("closed", [])).toEqual({
      state: "closed",
      status: "done",
      statusLabel: "status:done",
    });
  });

  it("resolves closed issue with status:canceled to canceled", () => {
    expect(normalizeForgejoIssueStatus("closed", ["status:canceled"])).toEqual({
      state: "closed",
      status: "canceled",
      statusLabel: "status:canceled",
    });
  });

  it("picks highest precedence open status when multiple are present", () => {
    expect(
      normalizeForgejoIssueStatus("open", ["status:waiting", "status:inprogress", "status:active"])
    ).toEqual({
      state: "open",
      status: "active",
      statusLabel: "status:active",
    });
  });

  it("picks done over canceled on closed when both present", () => {
    expect(normalizeForgejoIssueStatus("closed", ["status:canceled", "status:done"])).toEqual({
      state: "closed",
      status: "done",
      statusLabel: "status:done",
    });
  });

  it("ignores open status labels on closed issues", () => {
    expect(normalizeForgejoIssueStatus("closed", ["status:active", "status:inprogress"])).toEqual({
      state: "closed",
      status: "done",
      statusLabel: "status:done",
    });
  });
});

describe("priority normalization edge cases", () => {
  it("defaults to medium when no priority label exists", () => {
    expect(normalizeForgejoIssuePriority([])).toEqual({
      priority: "medium",
      priorityLabel: "priority:medium",
    });
  });

  it("defaults to medium with unknown priority label", () => {
    expect(normalizeForgejoIssuePriority(["priority:critical"])).toEqual({
      priority: "medium",
      priorityLabel: "priority:medium",
    });
  });

  it("picks highest precedence priority when multiple are present", () => {
    expect(normalizeForgejoIssuePriority(["priority:low", "priority:high"])).toEqual({
      priority: "high",
      priorityLabel: "priority:high",
    });
  });
});

describe("task to forgejo field mapping", () => {
  it("maps all open statuses to open state", () => {
    expect(createForgejoStatusFromTask("active").state).toBe("open");
    expect(createForgejoStatusFromTask("inprogress").state).toBe("open");
    expect(createForgejoStatusFromTask("waiting").state).toBe("open");
  });

  it("maps done and canceled to closed state", () => {
    expect(createForgejoStatusFromTask("done").state).toBe("closed");
    expect(createForgejoStatusFromTask("canceled").state).toBe("closed");
  });

  it("maps all priority levels correctly", () => {
    expect(createForgejoPriorityFromTask("low").priorityLabel).toBe("priority:low");
    expect(createForgejoPriorityFromTask("medium").priorityLabel).toBe("priority:medium");
    expect(createForgejoPriorityFromTask("high").priorityLabel).toBe("priority:high");
  });
});

describe("label merging and filtering", () => {
  it("strips status and priority labels from normal labels", () => {
    expect(
      getNormalForgejoLabels([
        "bug",
        "status:active",
        "priority:high",
        "feature",
        "status:done",
        "priority:low",
      ])
    ).toEqual(["bug", "feature"]);
  });

  it("deduplicates normal labels during merge", () => {
    expect(
      mergeForgejoLabels(["bug", "bug", "feature"], "status:active", "priority:medium")
    ).toEqual(["bug", "feature", "status:active", "priority:medium"]);
  });

  it("strips pre-existing status/priority from task labels before merge", () => {
    const payload = createForgejoIssueCreateFromTask({
      id: "task-1" as never,
      title: "Task",
      status: "inprogress",
      priority: "high",
      projectId: "project-1" as never,
      labels: ["bug", "status:active", "priority:low"],
      assignees: [],
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:00.000Z",
    });

    expect(payload.labels).toEqual(["bug", "status:inprogress", "priority:high"]);
  });

  it("returns empty normal labels with only reserved labels", () => {
    expect(getNormalForgejoLabels(["status:active", "priority:medium"])).toEqual([]);
  });

  it("returns empty for empty input", () => {
    expect(getNormalForgejoLabels([])).toEqual([]);
  });
});
