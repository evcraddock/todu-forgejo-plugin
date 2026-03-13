import { createIntegrationBindingId } from "@todu/core";

import {
  computeNextForgejoRetryDelay,
  createInitialForgejoRuntimeState,
  createInMemoryForgejoBindingRuntimeStore,
  recordForgejoFailure,
  recordForgejoSuccess,
  shouldForgejoRetry,
} from "@/forgejo-runtime";

describe("forgejo runtime", () => {
  it("computes bounded exponential retry delays", () => {
    expect(computeNextForgejoRetryDelay(0)).toBe(0);
    expect(computeNextForgejoRetryDelay(1, { initialSeconds: 5, maxSeconds: 300 })).toBe(5);
    expect(computeNextForgejoRetryDelay(2, { initialSeconds: 5, maxSeconds: 300 })).toBe(10);
    expect(computeNextForgejoRetryDelay(10, { initialSeconds: 5, maxSeconds: 30 })).toBe(30);
  });

  it("records failure and success transitions", () => {
    const bindingId = createIntegrationBindingId("binding-1");
    const initial = createInitialForgejoRuntimeState(bindingId);
    const failed = recordForgejoFailure(
      initial,
      "rate limited",
      { initialSeconds: 5, maxSeconds: 300 },
      new Date("2026-03-12T00:00:00.000Z")
    );

    expect(failed.retryAttempt).toBe(1);
    expect(failed.nextRetryAt).toBe("2026-03-12T00:00:05.000Z");
    expect(failed.lastError).toBe("rate limited");

    const succeeded = recordForgejoSuccess(
      failed,
      "2026-03-12T00:01:00.000Z",
      new Date("2026-03-12T00:01:00.000Z")
    );

    expect(succeeded.retryAttempt).toBe(0);
    expect(succeeded.nextRetryAt).toBeNull();
    expect(succeeded.lastError).toBeNull();
    expect(succeeded.cursor).toBe("2026-03-12T00:01:00.000Z");
  });

  it("checks retry eligibility against nextRetryAt", () => {
    const bindingId = createIntegrationBindingId("binding-1");
    const state = {
      ...createInitialForgejoRuntimeState(bindingId),
      retryAttempt: 1,
      nextRetryAt: "2026-03-12T00:10:00.000Z",
    };

    expect(shouldForgejoRetry(state, new Date("2026-03-12T00:09:59.000Z"))).toBe(false);
    expect(shouldForgejoRetry(state, new Date("2026-03-12T00:10:00.000Z"))).toBe(true);
  });

  it("stores runtime state in memory per binding", () => {
    const store = createInMemoryForgejoBindingRuntimeStore();
    const bindingId = createIntegrationBindingId("binding-1");
    const state = createInitialForgejoRuntimeState(bindingId);

    store.save(state);

    expect(store.get(bindingId)).toEqual(state);
    expect(store.listAll()).toEqual([state]);

    store.remove(bindingId);
    expect(store.get(bindingId)).toBeNull();
  });
});
