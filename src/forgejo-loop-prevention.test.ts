import { createForgejoLoopPreventionStore, createForgejoWriteKey } from "@/forgejo-loop-prevention";

describe("forgejo loop prevention", () => {
  it("recognizes own writes by key and timestamp", () => {
    const store = createForgejoLoopPreventionStore();
    store.recordWrite("issue:b1:42", "2026-03-12T12:00:00.000Z");

    expect(store.isOwnWrite("issue:b1:42", "2026-03-12T12:00:00.000Z")).toBe(true);
    expect(store.isOwnWrite("issue:b1:42", "2026-03-12T12:01:00.000Z")).toBe(false);
    expect(store.isOwnWrite("issue:b1:99", "2026-03-12T12:00:00.000Z")).toBe(false);
  });

  it("clears expired writes", () => {
    const store = createForgejoLoopPreventionStore();
    store.recordWrite("issue:b1:1", "2026-03-12T10:00:00.000Z");
    store.recordWrite("issue:b1:2", "2026-03-12T12:00:00.000Z");

    store.clearExpired(60 * 60 * 1000, new Date("2026-03-12T13:00:00.000Z"));

    expect(store.isOwnWrite("issue:b1:1", "2026-03-12T10:00:00.000Z")).toBe(false);
    expect(store.isOwnWrite("issue:b1:2", "2026-03-12T12:00:00.000Z")).toBe(true);
  });

  it("creates stable write keys", () => {
    expect(createForgejoWriteKey("issue", "binding-1", "42")).toBe("issue:binding-1:42");
    expect(createForgejoWriteKey("comment", "binding-1", "100")).toBe("comment:binding-1:100");
  });
});
