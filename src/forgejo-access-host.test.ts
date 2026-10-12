import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createNoteId, type Result } from "@todu/core";
import { createDaemonLogger, createSyncPluginWorkerRuntime } from "@todu/daemon";
import { createTodu, type ToduWithInternalTools } from "@todu/engine";

import { createFileForgejoCommentLinkStore } from "@/forgejo-comment-links";
import { createHttpForgejoIssueClient } from "@/forgejo-http-client";
import { createFileForgejoItemLinkStore } from "@/forgejo-links";
import { createForgejoSyncProvider } from "@/forgejo-provider";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

// Real HTTP adapter with mocked transport + real published host; no networking.
describe("linked Forgejo HTTP failures through host backoff and restart", () => {
  it.each([
    [7, 404],
    [401, 404],
    [403, 404],
    [7, 401],
    [7, 403],
  ])(
    "retains issue #%i HTTP %i failure rather than claiming recovery",
    async (issueNumber, statusCode) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-host-access-"));
      const storagePath = path.join(directory, "host");
      const storageDir = path.join(directory, "plugin");
      let todu: ToduWithInternalTools | null = null;
      try {
        todu = (await createTodu({ storagePath })) as ToduWithInternalTools;
        const project = value(await todu.project.create({ name: "Access failure" }));
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
        const externalId = `https://code.example.com/acme/roadmap#${issueNumber}`;
        const task = value(
          await todu.task.create({ projectId: project.id, title: "Original", externalId })
        );
        fs.mkdirSync(storageDir);
        const itemPath = path.join(storageDir, "item-links.json");
        const commentPath = path.join(storageDir, "comment-links.json");
        createFileForgejoItemLinkStore(itemPath).save({
          bindingId: binding.id,
          taskId: task.id,
          issueNumber,
          externalId,
          lastMirroredAt: "2026-01-01T00:00:00.000Z",
          fieldSnapshots: { content: { title: "Baseline", description: "Preserve" } },
        });
        createFileForgejoCommentLinkStore(commentPath).save({
          bindingId: binding.id,
          taskId: task.id,
          noteId: createNoteId("note-fixture"),
          issueNumber,
          forgejoCommentId: 11,
          origin: "todu",
          lastMirroredAt: "2026-01-01T00:00:00.000Z",
          lastMirroredBody: "Preserve baseline",
        });
        const originalItems = fs.readFileSync(itemPath, "utf8");
        const originalComments = fs.readFileSync(commentPath, "utf8");
        const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
          expect(init?.method).toBe("GET");
          if (new URL(String(url)).pathname.endsWith("/comments"))
            return new Response("Unavailable", { status: statusCode });
          if (new URL(String(url)).pathname.endsWith("/issues")) return Response.json([]);
          throw new Error(`Unexpected mock request ${url}`);
        });
        const client = createHttpForgejoIssueClient("synthetic-token", { fetchImpl });
        let previousAttempt: string | null = null;
        for (let cycle = 0; cycle < 2; cycle++) {
          const provider = createForgejoSyncProvider({ issueClient: client });
          const runtime = createSyncPluginWorkerRuntime({
            pluginName: "forgejo",
            pluginVersion: provider.version,
            modulePath: "/isolated-test",
            authorityId: "isolated-test",
            provider,
            providerApiVersion: 4,
            config: {
              enabled: true,
              settings: {
                baseUrl: "https://code.example.com",
                token: "synthetic-token",
                storageDir,
              },
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
                expect(status.lastAttemptedSyncAt).not.toBe(previousAttempt);
                expect(status.lastAttemptedSyncAt).not.toBeNull();
                expect(status.state).toBe("error");
                expect(status.lastSuccessfulSyncAt).toBeNull();
                expect(status.lastErrorSummary).toContain(
                  statusCode === 404 ? "explicit identity repair" : `failed: ${statusCode}`
                );
              },
              { timeout: 5000 }
            );
          } finally {
            await runtime.stop();
          }
          previousAttempt = value(await todu.integration.getStatus(binding.id)).lastAttemptedSyncAt;
          expect(fs.readFileSync(itemPath, "utf8")).toBe(originalItems);
          expect(fs.readFileSync(commentPath, "utf8")).toBe(originalComments);
          expect(value(await todu.task.get(task.id)).externalId).toBe(externalId);
          expect(value(await todu.task.list({ projectId: project.id }))).toHaveLength(1);
          await todu.close();
          todu = (await createTodu({ storagePath })) as ToduWithInternalTools;
        }
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        vi.restoreAllMocks();
        await todu?.close();
        fs.rmSync(directory, { recursive: true });
      }
    },
    15_000
  );
});
