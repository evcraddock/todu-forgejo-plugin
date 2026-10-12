import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { versionSource } from "./generate-version.mjs";
import { lookupVersion, planRelease } from "./plan-release.mjs";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-release-plan-"));
  fs.mkdirSync(path.join(directory, "src"));
  fs.mkdirSync(path.join(directory, ".changeset"));
  fs.writeFileSync(path.join(directory, ".changeset/README.md"), "Changesets instructions\n");
  metadata();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true });
});

function metadata(version = "0.1.2", name = "@todu/forgejo", privatePackage = false) {
  const value = { name, version, private: privatePackage };
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(value));
  fs.writeFileSync(
    path.join(directory, "package-lock.json"),
    JSON.stringify({ name, version, packages: { "": value } })
  );
  fs.writeFileSync(path.join(directory, "src/version.ts"), versionSource(version));
}

it("plans publication only for an unpublished stable version", async () => {
  const lookup = vi.fn().mockResolvedValue(null);
  expect(await planRelease(directory, lookup)).toMatchObject({
    version: "0.1.2",
    shouldPublish: true,
  });
  expect(lookup).toHaveBeenCalledWith("@todu/forgejo", "0.1.2");
});

it("skips an existing version without rebuilding or requiring identical recompression", async () => {
  const lookup = vi.fn().mockResolvedValue({
    name: "@todu/forgejo",
    version: "0.1.2",
    dist: { integrity: "sha512-previously-published-bytes" },
  });
  expect(await planRelease(directory, lookup)).toMatchObject({
    version: "0.1.2",
    shouldPublish: false,
    reason: expect.stringContaining("already published"),
  });
});

it("skips pending local versioning before contacting the registry", async () => {
  fs.writeFileSync(path.join(directory, ".changeset/fix.md"), "pending release\n");
  const lookup = vi.fn();
  expect(await planRelease(directory, lookup)).toMatchObject({ shouldPublish: false });
  expect(lookup).not.toHaveBeenCalled();
});

it.each(["0.1.3-next.0", "0.1.3-beta.1"])("rejects prerelease %s", async (version) => {
  metadata(version);
  const lookup = vi.fn();
  await expect(planRelease(directory, lookup)).rejects.toThrow("stable");
  expect(lookup).not.toHaveBeenCalled();
});

it.each(["pre", "exit"])("rejects leftover prerelease %s state", async (mode) => {
  fs.writeFileSync(path.join(directory, ".changeset/pre.json"), JSON.stringify({ mode }));
  await expect(planRelease(directory, vi.fn())).rejects.toThrow("prerelease mode");
});

it.each(["todu-forgejo-plugin", "@todu/other"])("rejects package identity %s", async (name) => {
  metadata("0.1.2", name);
  await expect(planRelease(directory, vi.fn())).rejects.toThrow("@todu/forgejo");
});

it("rejects private packages and stale generated versions", async () => {
  metadata("0.1.2", "@todu/forgejo", true);
  await expect(planRelease(directory, vi.fn())).rejects.toThrow("public");
  metadata();
  fs.writeFileSync(path.join(directory, "src/version.ts"), versionSource("0.1.1"));
  await expect(planRelease(directory, vi.fn())).rejects.toThrow("version.ts");
});

it.each([
  { name: "@todu/other", version: "0.1.2", dist: { integrity: "sha512-test" } },
  { name: "@todu/forgejo", version: "0.1.1", dist: { integrity: "sha512-test" } },
  { name: "@todu/forgejo", version: "0.1.2", dist: {} },
])("fails closed on unexpected registry metadata %j", async (registry) => {
  await expect(planRelease(directory, vi.fn().mockResolvedValue(registry))).rejects.toThrow();
});

it("does not turn a registry/network failure into permission to publish", async () => {
  await expect(
    planRelease(directory, vi.fn().mockRejectedValue(new Error("Registry unavailable")))
  ).rejects.toThrow("Registry unavailable");
});

it.each([401, 403, 429, 500])("rejects registry HTTP %s", async (status) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("error", { status }));
  await expect(lookupVersion("@todu/forgejo", "0.1.2")).rejects.toThrow(`HTTP ${status}`);
});

it("uses an anonymous bounded exact-version lookup and treats only 404 as missing", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("missing", { status: 404 }));
  expect(await lookupVersion("@todu/forgejo", "0.1.2")).toBeNull();
  expect(fetch).toHaveBeenCalledWith("https://registry.npmjs.org/%40todu%2Fforgejo/0.1.2", {
    signal: expect.any(AbortSignal),
  });
});
