import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Result } from "@todu/core";
import { createDaemonLogger, createSyncPluginWorkerRuntime } from "@todu/daemon";
import { createTodu, type ToduWithInternalTools } from "@todu/engine";

import { createInMemoryForgejoIssueClient } from "@/forgejo-client";
import { createFileForgejoItemLinkStore } from "@/forgejo-links";
import { createForgejoSyncProvider } from "@/forgejo-provider";
import { createFileForgejoBindingRuntimeStore } from "@/forgejo-runtime";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

// Real published host application/identity guards, isolated storage, no networking.
describe("Forgejo identity recovery through the npm host", () => {
  it("does not recreate linked issues or duplicate tasks on retry and restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-host-identity-"));
    const storagePath = path.join(directory, "host");
    const storageDir = path.join(directory, "plugin");
    let todu: ToduWithInternalTools | null = null;
    try {
      todu = (await createTodu({ storagePath })) as ToduWithInternalTools;
      const project = value(await todu.project.create({ name: "Identity recovery" }));
      const binding = value(
        await todu.integration.create({
          provider: "forgejo",
          projectId: project.id,
          targetKind: "repository",
          targetRef: "acme/roadmap",
          strategy: "bidirectional",
          enabled: true,
        })
      );
      const target = {
        baseUrl: "https://code.example.com",
        apiBaseUrl: "https://code.example.com/api/v1",
        owner: "acme",
        repo: "roadmap",
      };
      const originals = [];
      for (const [number, title] of [
        [9, "Enhance Neovim for prose and markdown writing"],
        [31, "Create agent skill for switching monitor input"],
      ] as const) {
        originals.push(
          value(
            await todu.task.create({
              projectId: project.id,
              title,
              externalId: `${target.baseUrl}/acme/roadmap#${number}`,
              sourceUrl: `${target.baseUrl}/acme/roadmap/issues/${number}`,
            })
          )
        );
      }
      fs.mkdirSync(storageDir);
      const links = createFileForgejoItemLinkStore(path.join(storageDir, "item-links.json"));
      for (const [index, task] of originals.entries()) {
        links.save({
          bindingId: binding.id,
          taskId: task.id,
          issueNumber: [9, 31][index],
          externalId: task.externalId!,
          lastMirroredAt: "2026-01-01T00:00:00.000Z",
        });
      }
      const originalLinks = links.list(binding.id);
      const issueClient = createInMemoryForgejoIssueClient();
      const createIssue = vi.spyOn(issueClient, "createIssue");
      const createComment = vi.spyOn(issueClient, "createComment");
      // The old issues are unavailable. Empty comment results exercise the push
      // update-404 path separately from missing-comment-endpoint blocking.
      let previousAttempt: string | null = null;
      for (let cycle = 0; cycle < 3; cycle++) {
        const provider = createForgejoSyncProvider({ issueClient });
        const runtime = createSyncPluginWorkerRuntime({
          pluginName: "forgejo",
          pluginVersion: provider.version,
          modulePath: "/isolated-test",
          authorityId: "isolated-test",
          provider,
          providerApiVersion: 4,
          config: {
            enabled: true,
            settings: { baseUrl: target.baseUrl, token: "test-token", storageDir },
            intervalMs: 60_000,
            retryInitialMs: 60_000,
            retryMaxMs: 60_000,
          },
          getTodu: () => todu,
          logger: createDaemonLogger({ level: "error" }),
        }).start();
        try {
          await vi.waitFor(
            async () => {
              const status = value(await todu!.integration.getStatus(binding.id));
              expect(status.state).toBe("error");
              expect(status.lastAttemptedSyncAt).not.toBe(previousAttempt);
              expect(status.lastErrorSummary).not.toBeNull();
            },
            { timeout: 5000 }
          );
        } finally {
          await runtime.stop();
        }
        const status = value(await todu.integration.getStatus(binding.id));
        previousAttempt = status.lastAttemptedSyncAt;
        const tasks = value(await todu.task.list({ projectId: project.id }));
        // Let the baseline reach the later pull that imports replacement issues;
        // the final cycle asserts identities as well as the absence of creates.
        if (cycle === 2) {
          expect(tasks.map((task) => task.id).sort()).toEqual(
            originals.map((task) => task.id).sort()
          );
          expect(tasks.map((task) => task.externalId).sort()).toEqual(
            originals.map((task) => task.externalId).sort()
          );
          expect(createIssue).not.toHaveBeenCalled();
          expect(createComment).not.toHaveBeenCalled();
          expect(links.list(binding.id)).toEqual(originalLinks);
          expect(
            createFileForgejoBindingRuntimeStore(path.join(storageDir, "runtime-state.json")).get(
              binding.id
            )?.lastPushSuccessAt
          ).toBeNull();
        }
        expect(status.lastSuccessfulSyncAt).toBeNull();
        if (cycle === 2) expect(status.lastErrorSummary).toContain("explicit identity repair");
        await todu.close();
        todu = (await createTodu({ storagePath })) as ToduWithInternalTools;
      }
    } finally {
      vi.restoreAllMocks();
      await todu?.close();
      fs.rmSync(directory, { recursive: true });
    }
  }, 20_000);

  it("keeps the host guard and error status when a provider returns a conflicting task link", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-host-link-guard-"));
    let todu: ToduWithInternalTools | null = null;
    try {
      todu = (await createTodu({ storagePath: directory })) as ToduWithInternalTools;
      const project = value(await todu.project.create({ name: "Link guard" }));
      const binding = value(
        await todu.integration.create({
          provider: "forgejo",
          projectId: project.id,
          targetKind: "repository",
          targetRef: "acme/roadmap",
          strategy: "push",
          enabled: true,
        })
      );
      const externalId = "https://code.example.com/acme/roadmap#9";
      const task = value(
        await todu.task.create({ projectId: project.id, title: "Original", externalId })
      );
      const provider = createForgejoSyncProvider({
        issueClient: createInMemoryForgejoIssueClient(),
      });
      vi.spyOn(provider, "push").mockResolvedValue({
        commentLinks: [],
        taskLinks: [
          { localTaskId: task.id, externalId: "https://code.example.com/acme/roadmap#62" },
        ],
      });
      const runtime = createSyncPluginWorkerRuntime({
        pluginName: "forgejo",
        pluginVersion: provider.version,
        modulePath: "/isolated-test",
        authorityId: "isolated-test",
        provider,
        providerApiVersion: 4,
        config: {
          enabled: true,
          settings: { baseUrl: "https://code.example.com", token: "test-token" },
          intervalMs: 60_000,
          retryInitialMs: 60_000,
          retryMaxMs: 60_000,
        },
        getTodu: () => todu,
        logger: createDaemonLogger({ level: "error" }),
      }).start();
      try {
        await vi.waitFor(
          async () =>
            expect(value(await todu!.integration.getStatus(binding.id)).state).toBe("error"),
          { timeout: 5000 }
        );
        const status = value(await todu.integration.getStatus(binding.id));
        expect(status.lastErrorSummary).toContain(
          "push task link conflicts with existing task linkage"
        );
        expect(status.lastSuccessfulSyncAt).toBeNull();
        expect(value(await todu.task.get(task.id)).externalId).toBe(externalId);
        expect(value(await todu.task.list({ projectId: project.id }))).toHaveLength(1);
      } finally {
        await runtime.stop();
      }
    } finally {
      vi.restoreAllMocks();
      await todu?.close();
      fs.rmSync(directory, { recursive: true });
    }
  }, 10_000);
});
