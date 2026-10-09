import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Result } from "@todu/core";
import { createDaemonLogger, createSyncPluginWorkerRuntime } from "@todu/daemon";
import { createTodu, type ToduWithInternalTools } from "@todu/engine";

import { createInMemoryForgejoIssueClient } from "@/forgejo-client";
import { createForgejoSyncProvider } from "@/forgejo-provider";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

// Published npm host code, isolated local storage, no daemon process or networking.
describe("Forgejo replay through the npm host's v4 application lifecycle", () => {
  it.each(["task apply", "comment apply", "local flush"])(
    "recovers from %s failure and restart without duplicate local records",
    async (failure) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-host-ack-"));
      const storagePath = path.join(directory, "host");
      const storageDir = path.join(directory, "plugin");
      let todu: ToduWithInternalTools | null = null;
      try {
        todu = (await createTodu({ storagePath })) as ToduWithInternalTools;
        const project = value(await todu.project.create({ name: "Replay" }));
        const binding = value(
          await todu.integration.create({
            provider: "forgejo",
            projectId: project.id,
            targetKind: "repository",
            targetRef: "acme/roadmap",
            strategy: "pull",
            enabled: true,
          })
        );
        const target = {
          baseUrl: "https://code.example.com",
          apiBaseUrl: "https://code.example.com/api/v1",
          owner: "acme",
          repo: "roadmap",
        };
        const issueClient = createInMemoryForgejoIssueClient();
        issueClient.seedIssues(
          target,
          [7, 8].map((number) => ({
            number,
            externalId: `${target.baseUrl}/acme/roadmap#${number}`,
            title: `Issue ${number}`,
            state: "open",
            labels: [],
            assignees: [],
            createdAt: "2026-03-12T00:00:00.000Z",
            updatedAt: "2026-03-12T00:01:00.000Z",
          }))
        );
        issueClient.seedComments(
          target,
          7,
          [11, 12].map((id) => ({
            id,
            issueNumber: 7,
            body: `Comment ${id}`,
            createdAt: "2026-03-12T00:01:30.000Z",
          }))
        );
        const config = {
          enabled: true,
          settings: { baseUrl: target.baseUrl, token: "test-token", storageDir },
          intervalMs: 60_000,
          retryInitialMs: 60_000,
          retryMaxMs: 60_000,
        };
        const startCycle = (provider: ReturnType<typeof createForgejoSyncProvider>) =>
          createSyncPluginWorkerRuntime({
            pluginName: "forgejo",
            pluginVersion: provider.version,
            modulePath: "/isolated-test",
            authorityId: "isolated-test",
            provider,
            providerApiVersion: 4,
            config,
            getTodu: () => todu,
            logger: createDaemonLogger({ level: "error" }),
          }).start();

        if (failure === "task apply") {
          const create = todu.task.create.bind(todu.task);
          vi.spyOn(todu.task, "create").mockImplementation(async (input) => {
            if (input.externalId?.endsWith("#8"))
              throw new Error("injected task application failure");
            return create(input);
          });
        } else if (failure === "comment apply") {
          const create = todu.__internal.syncRuntime.notes.createWithId.bind(
            todu.__internal.syncRuntime.notes
          );
          let calls = 0;
          vi.spyOn(todu.__internal.syncRuntime.notes, "createWithId").mockImplementation(
            async (...args) => {
              if (++calls === 2) throw new Error("injected comment application failure");
              return create(...args);
            }
          );
        } else {
          vi.spyOn(todu.__internal.syncRuntime, "flush").mockRejectedValueOnce(
            new Error("injected host flush failure")
          );
        }
        const provider = createForgejoSyncProvider({ issueClient });
        const acknowledgment = vi.spyOn(provider, "acknowledgePull");
        const firstCycle = startCycle(provider);
        try {
          await vi.waitFor(
            async () =>
              expect(value(await todu!.integration.getStatus(binding.id)).state).toBe("error"),
            { timeout: 5000 }
          );
          expect(acknowledgment).not.toHaveBeenCalled();
          expect(provider.getState().runtimeStates[0]).toMatchObject({
            issuePullCursor: null,
            commentPullCursor: null,
          });
          expect(provider.getState().runtimeStates[0].pendingPull).not.toBeNull();
        } finally {
          await firstCycle.stop();
        }
        const existingTasks = value(await todu.task.list({ projectId: project.id })).map(
          (task) => task.id
        );
        const existingNotes = value(await todu.note.list()).map((note) => note.id);
        expect(existingTasks).toHaveLength(failure === "task apply" ? 1 : 2);
        expect(existingNotes).toHaveLength(
          failure === "task apply" ? 0 : failure === "comment apply" ? 1 : 2
        );
        await todu.close();
        todu = null;
        vi.restoreAllMocks();

        // The provider must replay its original durable batch even if the source is gone.
        issueClient.seedIssues(target, []);
        issueClient.seedComments(target, 7, []);
        todu = (await createTodu({ storagePath })) as ToduWithInternalTools;
        const restarted = createForgejoSyncProvider({ issueClient });
        const acknowledged = vi.spyOn(restarted, "acknowledgePull");
        const secondCycle = startCycle(restarted);
        try {
          await vi.waitFor(
            async () => {
              expect(value(await todu!.integration.getStatus(binding.id)).state).toBe("idle");
              expect(acknowledged).toHaveBeenCalledTimes(1);
            },
            { timeout: 5000 }
          );
          expect(restarted.getState().runtimeStates[0].pendingPull).toBeNull();
          expect(restarted.getState().runtimeStates[0].issuePullCursor).not.toBeNull();
        } finally {
          await secondCycle.stop();
        }
        await todu.close();
        todu = (await createTodu({ storagePath })) as ToduWithInternalTools;
        const tasks = value(await todu.task.list({ projectId: project.id }));
        const notes = value(await todu.note.list());
        expect(tasks).toHaveLength(2);
        expect(notes).toHaveLength(2);
        expect(tasks.map((task) => task.id)).toEqual(expect.arrayContaining(existingTasks));
        expect(notes.map((note) => note.id)).toEqual(expect.arrayContaining(existingNotes));
      } finally {
        vi.restoreAllMocks();
        await todu?.close();
        fs.rmSync(directory, { recursive: true });
      }
    },
    15_000
  );
});
