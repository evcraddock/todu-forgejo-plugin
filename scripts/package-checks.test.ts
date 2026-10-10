import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import { checkPackFiles } from "./verify-package.mjs";
import { publicationNeeded } from "./check-published.mjs";

const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/version.d.ts",
  "docs/release.md",
  "docs/FORGEJO-STORAGE-MIGRATION.md",
  "docs/SMOKE-TEST.md",
  "scripts/migrate-forgejo-storage.mjs",
].map((file) => ({ path: file }));

it("requires complete distributables and excludes source, credentials, and live state", () => {
  expect(() => checkPackFiles(required)).not.toThrow();
  expect(() => checkPackFiles(required.filter((entry) => entry.path !== "dist/index.js"))).toThrow(
    "missing"
  );
  for (const file of [
    ".env",
    "config/dev.todu.yaml",
    "src/forgejo-provider.ts",
    ".dev/data.json",
    "dist/stale.js",
  ]) {
    expect(() => checkPackFiles([...required, { path: file }])).toThrow("Unexpected");
  }
});

it("publishes only missing versions and fails closed on changed bytes or registry errors", () => {
  const tarball = Buffer.from("tested artifact");
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const verified = { name: "todu-forgejo-plugin", version: "0.1.0", integrity };
  const existing = { version: "0.1.0", "dist.integrity": integrity };
  expect(publicationNeeded(existing, verified, tarball)).toBe(false);
  expect(publicationNeeded({ error: { code: "E404" } }, verified, tarball)).toBe(true);
  expect(() => publicationNeeded(existing, verified, Buffer.from("tampered"))).toThrow("changed");
  expect(() =>
    publicationNeeded({ ...existing, "dist.integrity": "different" }, verified, tarball)
  ).toThrow("never overwrite");
  expect(() => publicationNeeded({ ...existing, version: "0.2.0" }, verified, tarball)).toThrow(
    "unexpected version"
  );
  for (const code of ["E401", "E403", "E500", "ENOTFOUND"]) {
    expect(() => publicationNeeded({ error: { code } }, verified, tarball)).toThrow(
      "Registry lookup failed"
    );
  }
});

it.each(["stable", "prerelease"])(
  "prepares a real %s Changesets version in isolation",
  (mode) => {
    const root = process.cwd();
    const originalPackage = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-changesets-"));
    try {
      fs.mkdirSync(path.join(directory, "src"));
      fs.mkdirSync(path.join(directory, "scripts"));
      fs.mkdirSync(path.join(directory, ".changeset"));
      fs.copyFileSync(
        path.join(root, ".changeset/config.json"),
        path.join(directory, ".changeset/config.json")
      );
      for (const name of [
        "package.json",
        "package-lock.json",
        "CHANGELOG.md",
        "src/version.ts",
        "scripts/generate-version.mjs",
      ]) {
        fs.copyFileSync(path.join(root, name), path.join(directory, name));
      }
      // Use a fixed fixture base, independent of future releases in this checkout.
      for (const file of ["package.json", "package-lock.json"]) {
        const full = path.join(directory, file);
        const value = JSON.parse(fs.readFileSync(full, "utf8"));
        value.version = "0.1.0";
        if (value.packages) value.packages[""].version = "0.1.0";
        fs.writeFileSync(full, JSON.stringify(value));
      }
      fs.symlinkSync(
        path.join(root, "node_modules"),
        path.join(directory, "node_modules"),
        "junction"
      );
      fs.writeFileSync(
        path.join(directory, ".changeset", "test-patch.md"),
        '---\n"todu-forgejo-plugin": patch\n---\nVerify isolated patch preparation.\n'
      );
      const home = path.join(directory, "home");
      fs.mkdirSync(home);
      const npmrc = path.join(home, "npmrc");
      const globalNpmrc = path.join(home, "global-npmrc");
      fs.writeFileSync(npmrc, "");
      fs.writeFileSync(globalNpmrc, "");
      const options = {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          NPM_CONFIG_USERCONFIG: npmrc,
          NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
          NPM_CONFIG_OFFLINE: "true",
        },
        encoding: "utf8",
        timeout: 60_000,
      } as const;
      if (mode === "prerelease") {
        const enter = spawnSync("npm", ["run", "changeset", "--", "pre", "enter", "next"], options);
        expect(enter.status, enter.stdout + enter.stderr).toBe(0);
      }
      const result = spawnSync("npm", ["run", "version-packages"], options);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const expectedVersion = mode === "prerelease" ? "0.1.1-next.0" : "0.1.1";
      expect(
        JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).version
      ).toBe(expectedVersion);
      expect(fs.readFileSync(path.join(directory, "src/version.ts"), "utf8")).toContain(
        `VERSION = "${expectedVersion}"`
      );
      const lock = JSON.parse(fs.readFileSync(path.join(directory, "package-lock.json"), "utf8"));
      expect(lock.version).toBe(expectedVersion);
      expect(lock.packages[""].version).toBe(expectedVersion);
      expect(fs.readFileSync(path.join(directory, "CHANGELOG.md"), "utf8")).toContain(
        `## ${expectedVersion}`
      );
      expect(fs.readFileSync(path.join(directory, "CHANGELOG.md"), "utf8")).toContain(
        "Verify isolated patch preparation."
      );
      expect(fs.existsSync(path.join(directory, ".changeset/test-patch.md"))).toBe(false);
      if (mode === "prerelease") {
        const exit = spawnSync("npm", ["run", "changeset", "--", "pre", "exit"], options);
        expect(exit.status, exit.stdout + exit.stderr).toBe(0);
        const stable = spawnSync("npm", ["run", "version-packages"], options);
        expect(stable.status, stable.stdout + stable.stderr).toBe(0);
        expect(
          JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).version
        ).toBe("0.1.1");
      }
      expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toBe(originalPackage);
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  },
  20_000
);

it("keeps source merges and tags outside the publication path", () => {
  const workflow = fs.readFileSync(".github/workflows/npm-release.yml", "utf8");
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).not.toMatch(/^ {2}(push|pull_request):/m);
  expect(workflow).toContain("environment: npm-release");
  expect(workflow).toContain("id-token: write");
  expect(workflow).toContain("--ignore-scripts --provenance");
  expect(workflow).not.toContain("NPM_TOKEN");
  expect(workflow).toContain("git merge-base --is-ancestor");
});
