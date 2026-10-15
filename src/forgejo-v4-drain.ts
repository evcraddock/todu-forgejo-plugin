import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeForgejoStateFile } from "@/forgejo-storage";
import { parseForgejoBinding } from "@/forgejo-binding";
import {
  SYNC_PROVIDER_API_VERSION_V4,
  type IntegrationBinding,
  type SyncProviderRegistrationV4,
  type SyncProviderV4,
} from "@todu/core";
import {
  createForgejoSyncProvider as createV4Provider,
  checkpointScope,
  createForgejoRepositoryTarget,
  FORGEJO_PROVIDER_VERSION,
  type CreateForgejoSyncProviderOptions,
} from "@/forgejo-legacy-provider";
import { replayForgejoPendingPull, type ForgejoPendingPull } from "@/forgejo-pull-checkpoint";

/** Explicit operator-selected recovery entrypoint, never an automatic v7 fallback. */
export function createForgejoV4DrainProvider(
  options: CreateForgejoSyncProviderOptions = {}
): SyncProviderV4 {
  const legacy = createV4Provider(options);
  const frozen = new Map<IntegrationBinding["id"], ForgejoPendingPull>();
  let boundary: Record<string, string> | undefined;
  const digest = (pending: ForgejoPendingPull) =>
    createHash("sha256").update(JSON.stringify(pending)).digest("hex");
  return {
    name: legacy.name,
    version: legacy.version,
    async initialize(config) {
      await legacy.initialize(config);
      frozen.clear();
      const { runtimeStore, settings } = legacy.resources();
      const states = runtimeStore.listAll();
      if (states.some((state) => state.fieldSync?.pending))
        throw new Error(
          "V4 drain cannot process v7 pending work; retain it and use the v7 provider"
        );
      const file = settings.storageDir ? path.join(settings.storageDir, "v4-drain.json") : null;
      if (file && fs.existsSync(file)) {
        const journal = JSON.parse(fs.readFileSync(file, "utf8")) as {
          version: number;
          batches: Record<string, string>;
        };
        if (
          !journal ||
          journal.version !== 1 ||
          !journal.batches ||
          typeof journal.batches !== "object" ||
          Array.isArray(journal.batches) ||
          Object.entries(journal.batches).some(
            ([id, hash]) => !id || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)
          )
        )
          throw new Error("Invalid captured v4 drain boundary; preserve journal for recovery");
        boundary = journal.batches;
      } else if (!boundary) {
        boundary = Object.fromEntries(
          states.flatMap((state) =>
            state.pendingPull ? [[state.bindingId, digest(state.pendingPull)]] : []
          )
        );
        if (file) writeForgejoStateFile(file, { version: 1, batches: boundary });
      }
      for (const state of states) {
        if (!state.pendingPull) continue;
        if (
          !Object.hasOwn(boundary!, state.bindingId) ||
          boundary![state.bindingId] !== digest(state.pendingPull)
        )
          throw new Error(
            "Pending work is outside the captured v4 drain boundary; preserve all records"
          );
        frozen.set(state.bindingId, structuredClone(state.pendingPull));
      }
    },
    async shutdown() {
      frozen.clear();
      await legacy.shutdown();
    },
    async pull(binding, project) {
      if (!binding.enabled || !["pull", "bidirectional"].includes(binding.strategy))
        return { tasks: [], checkpoint: null };
      const original = frozen.get(binding.id);
      const current = legacy.resources().runtimeStore.get(binding.id);
      if (!original || !current?.pendingPull) {
        if (current?.pendingPull)
          throw new Error("New work appeared outside the captured v4 drain boundary");
        return { tasks: [], checkpoint: null };
      }
      const currentScope = checkpointScope(
        binding,
        createForgejoRepositoryTarget(parseForgejoBinding(binding), legacy.resources().settings),
        project.id
      );
      if (original.checkpoint.scope !== currentScope)
        throw new Error(
          "Original v4 drain scope changed; do not apply this batch to another target/project"
        );
      if (JSON.stringify(original) !== JSON.stringify(current.pendingPull))
        throw new Error("Original v4 drain batch changed; preserve work for explicit recovery");
      return replayForgejoPendingPull(original);
    },
    async acknowledgePull(binding, checkpoint, project) {
      if (checkpoint === null) return;
      const original = frozen.get(binding.id);
      if (!original || JSON.stringify(checkpoint) !== JSON.stringify(original.checkpoint))
        throw new Error("Checkpoint is outside the captured v4 drain boundary");
      await legacy.acknowledgePull(binding, checkpoint, project);
    },
    // Even a bidirectional binding cannot create/update remote records in drain mode.
    async push() {
      return { taskLinks: [], commentLinks: [] };
    },
  };
}
export const syncProvider: SyncProviderRegistrationV4 = {
  manifest: {
    name: "forgejo",
    version: FORGEJO_PROVIDER_VERSION,
    apiVersion: SYNC_PROVIDER_API_VERSION_V4,
  },
  provider: createForgejoV4DrainProvider(),
};
