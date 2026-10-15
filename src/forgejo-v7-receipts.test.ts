import {
  MAX_TASK_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  type SyncProviderPullAcknowledgmentV7,
} from "@todu/core";
import { validateForgejoV7Receipts } from "@/forgejo-v7-receipts";
import type { ForgejoV7Payload } from "@/forgejo-v7-ledger";
const payload: ForgejoV7Payload = {
  tasks: [],
  taskUpdates: [
    {
      externalId: "remote",
      localTaskId: "task-local" as never,
      groups: {
        workflow: {
          base: { state: "known", value: { status: "active" } },
          remote: { status: "done" },
        },
      },
    },
  ],
};
const receipt = (): SyncProviderPullAcknowledgmentV7 => ({
  bootstrapResults: [],
  taskResults: [
    {
      externalId: "remote",
      localTaskId: "task-local" as never,
      groups: {
        workflow: {
          state: "persisted",
          value: { status: "done" },
          baseline: "mirrored",
          remoteWriteRequired: false,
        },
      },
    },
  ],
});

describe("v7 receipt validation before committing read progress", () => {
  it("accepts exactly verified mirrored values for supplied groups", () => {
    expect(validateForgejoV7Receipts(payload, receipt())[0]).toMatchObject({
      mirrored: { workflow: { status: "done" } },
      writes: {},
      unresolved: false,
    });
  });
  it.each([
    { bootstrapResults: [], taskResults: [] },
    { bootstrapResults: [receipt().taskResults[0]], taskResults: receipt().taskResults },
    { ...receipt(), taskResults: [{ ...receipt().taskResults[0], localTaskId: "task-other" }] },
    { ...receipt(), taskResults: [{ ...receipt().taskResults[0], externalId: "foreign" }] },
    { ...receipt(), taskResults: [{ ...receipt().taskResults[0], groups: {} }] },
    {
      ...receipt(),
      taskResults: [
        {
          ...receipt().taskResults[0],
          groups: {
            workflow: {
              state: "persisted",
              value: { status: "active" },
              baseline: "unproven",
              remoteWriteRequired: false,
              reason: "initialization-disagreement",
            },
          },
        },
      ],
    },
    {
      ...receipt(),
      taskResults: [
        {
          ...receipt().taskResults[0],
          groups: {
            workflow: {
              state: "persisted",
              value: { status: "active" },
              baseline: "mirrored",
              remoteWriteRequired: false,
            },
          },
        },
      ],
    },
    {
      ...receipt(),
      taskResults: [
        {
          ...receipt().taskResults[0],
          groups: {
            workflow: {
              state: "persisted",
              value: { status: "done" },
              baseline: "mirrored",
              remoteWriteRequired: true,
            },
          },
        },
      ],
    },
    {
      ...receipt(),
      taskResults: [
        {
          ...receipt().taskResults[0],
          groups: {
            workflow: {
              state: "deferred",
              reason: "pending-content-approval",
              value: { status: "done" },
            },
          },
        },
      ],
    },
  ])("rejects malformed, mismatched, or unproven receipts %j", (invalid) => {
    expect(() =>
      validateForgejoV7Receipts(payload, invalid as SyncProviderPullAcknowledgmentV7)
    ).toThrow(/acknowledgment/);
  });
  it("stages a known-base local winner without advancing its baseline", () => {
    const ack = receipt();
    ack.taskResults[0].groups.workflow = {
      state: "persisted",
      value: { status: "waiting" },
      baseline: "unproven",
      remoteWriteRequired: true,
      reason: "remote-write-required",
    };
    expect(validateForgejoV7Receipts(payload, ack)[0]).toMatchObject({
      mirrored: {},
      writes: { workflow: { status: "waiting" } },
      unresolved: true,
    });
    const unknown = structuredClone(payload);
    unknown.taskUpdates[0].groups.workflow!.base = { state: "unknown" };
    expect(() => validateForgejoV7Receipts(unknown, ack)).toThrow(/unproven/);
  });
  it.each([
    { name: "padded title", value: { title: " padded ", description: "Body" } },
    { name: "padded description", value: { title: "Title", description: " padded " } },
    {
      name: "oversized title",
      value: { title: "x".repeat(MAX_TASK_TITLE_LENGTH + 1), description: "Body" },
    },
    {
      name: "oversized description",
      value: { title: "Title", description: "x".repeat(MAX_DESCRIPTION_LENGTH + 1) },
    },
  ])("rejects $name before accepting a persisted write receipt", ({ value }) => {
    const content = { title: "Title", description: "Body" };
    const issued: ForgejoV7Payload = {
      tasks: [],
      taskUpdates: [
        {
          externalId: "remote",
          localTaskId: "task-local" as never,
          groups: { content: { base: { state: "known", value: content }, remote: content } },
        },
      ],
    };
    const ack: SyncProviderPullAcknowledgmentV7 = {
      bootstrapResults: [],
      taskResults: [
        {
          externalId: "remote",
          localTaskId: "task-local" as never,
          groups: {
            content: {
              state: "persisted",
              baseline: "unproven",
              remoteWriteRequired: true,
              reason: "remote-write-required",
              value,
            },
          },
        },
      ],
    };
    expect(() => validateForgejoV7Receipts(issued, ack)).toThrow(/v7 field value/);
  });
  it("rejects swapped receipts and duplicate actual local identities", () => {
    const two = structuredClone(payload);
    two.taskUpdates.push({
      ...two.taskUpdates[0],
      externalId: "second",
      localTaskId: "task-second" as never,
    });
    const ack = receipt();
    ack.taskResults.push({
      ...ack.taskResults[0],
      externalId: "second",
      localTaskId: "task-second" as never,
    });
    expect(validateForgejoV7Receipts(two, ack)).toHaveLength(2);
    ack.taskResults.reverse();
    expect(() => validateForgejoV7Receipts(two, ack)).toThrow(/identity/);
  });
});
