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
  "dist/forgejo-v4-drain.js",
  "dist/forgejo-v4-drain.d.ts",
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
  const verified = { name: "@todu/forgejo", version: "0.1.0", integrity };
  const existing = { version: "0.1.0", "dist.integrity": integrity };
  expect(publicationNeeded(existing, verified, tarball)).toBe(false);
  expect(publicationNeeded({ error: { code: "E404" } }, verified, tarball)).toBe(true);
  for (const name of ["todu-forgejo-plugin", "todu/forgejo", "@todu/other"]) {
    expect(() =>
      publicationNeeded({ error: { code: "E404" } }, { ...verified, name }, tarball)
    ).toThrow("@todu/forgejo");
  }
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

it.each([
  ["todu-forgejo-0.1.0.tgz", true],
  ["todu-forgejo-plugin-0.1.0.tgz", false],
] as const)("checks scoped tarball basename %s before publication", (filename, accepted) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-published-package-"));
  try {
    const release = path.join(directory, ".release");
    fs.mkdirSync(release);
    const tarball = Buffer.from("verified scoped artifact fixture");
    const verified = {
      name: "@todu/forgejo",
      version: "0.1.0",
      filename,
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    };
    fs.writeFileSync(path.join(release, filename), tarball);
    fs.writeFileSync(path.join(release, "package-verification.json"), JSON.stringify(verified));
    fs.writeFileSync(
      path.join(release, "registry.json"),
      JSON.stringify({ error: { code: "E404" } })
    );
    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), "scripts/check-published.mjs")],
      {
        cwd: directory,
        env: { EXPECTED_VERSION: "0.1.0" },
        encoding: "utf8",
        timeout: 10000,
      }
    );
    if (accepted) {
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("should_publish=true");
    } else {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("todu-forgejo-0.1.0.tgz");
    }
  } finally {
    fs.rmSync(directory, { recursive: true });
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
      fs.writeFileSync(path.join(directory, "CHANGELOG.md"), "# @todu/forgejo\n\n");
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
        '---\n"@todu/forgejo": patch\n---\nVerify isolated patch preparation.\n'
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
        `## ${expectedVersion}\n`
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
      // Each new release request adds one patch Changeset, never prerelease state.
      for (const version of ["0.1.2", "0.1.3"]) {
        fs.writeFileSync(
          path.join(directory, ".changeset", "test-patch.md"),
          '---\n"@todu/forgejo": patch\n---\nPrepare the next stable release.\n'
        );
        const next = spawnSync("npm", ["run", "version-packages"], options);
        expect(next.status, next.stdout + next.stderr).toBe(0);
        expect(
          JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).version
        ).toBe(version);
        const nextLock = JSON.parse(
          fs.readFileSync(path.join(directory, "package-lock.json"), "utf8")
        );
        expect(nextLock.version).toBe(version);
        expect(nextLock.packages[""].version).toBe(version);
        expect(fs.readFileSync(path.join(directory, "src/version.ts"), "utf8")).toContain(
          `VERSION = "${version}"`
        );
        expect(fs.readFileSync(path.join(directory, "CHANGELOG.md"), "utf8")).toContain(
          `## ${version}\n`
        );
        expect(fs.existsSync(path.join(directory, ".changeset/pre.json"))).toBe(false);
        expect(fs.existsSync(path.join(directory, ".changeset/test-patch.md"))).toBe(false);
      }
      expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toBe(originalPackage);
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  },
  20_000
);

it("targets only the scoped registry package and canonical tarball in the workflow", () => {
  const workflow = fs.readFileSync(".github/workflows/npm-release.yml", "utf8");
  expect(workflow).toContain("npm view @todu/forgejo name");
  expect(workflow).toContain('npm view "@todu/forgejo@$EXPECTED_VERSION" version dist.integrity');
  expect(workflow).toContain('npm publish ".release/todu-forgejo-$EXPECTED_VERSION.tgz"');
  expect(workflow).not.toContain("todu-forgejo-plugin");
});

it("uploads hidden release artifacts without broadening the selected files", () => {
  const workflow = fs.readFileSync(".github/workflows/npm-release.yml", "utf8");
  const upload = workflow.match(/^ {6}- uses: actions\/upload-artifact@v4\n((?: {8,}.+\n)+)/m)?.[1];
  expect(upload).toBeDefined();
  expect(upload).toMatch(/^ {10}include-hidden-files: true$/m);
  expect(upload).toMatch(
    /^ {10}path: \|\n {12}\.release\/\*\.tgz\n {12}\.release\/package-verification\.json\n(?= {10}\S)/m
  );
  expect(upload).toMatch(/^ {10}if-no-files-found: error$/m);
  expect(fs.readFileSync(".gitignore", "utf8")).toMatch(/^\.release\/$/m);
});

it("uses stable versions and the latest channel for the release skill and workflow", () => {
  const metadata = JSON.parse(fs.readFileSync("package.json", "utf8"));
  expect(metadata.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(fs.existsSync(".changeset/pre.json")).toBe(false);
  const skill = fs.readFileSync(".pi/skills/release/SKILL.md", "utf8");
  expect(skill).toContain("name: release");
  expect(skill).toContain('"@todu/forgejo": patch');
  expect(skill).toContain("npm run version-packages");
  expect(skill).toContain("0.1.1 → 0.1.2 → 0.1.3");
  const workflow = fs.readFileSync(".github/workflows/npm-release.yml", "utf8");
  expect(workflow).not.toContain("dist_tag:");
  expect(workflow).not.toContain("inputs.dist_tag");
  expect(workflow.match(/DIST_TAG: latest/g)).toHaveLength(2);
});

it("publishes main automatically through OIDC without a manual release gate", () => {
  const workflow = fs.readFileSync(".github/workflows/npm-release.yml", "utf8");
  expect(workflow).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m);
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).not.toContain("inputs:");
  expect(workflow).not.toContain("inputs.commit");
  expect(workflow).not.toContain("inputs.version");
  expect(workflow).not.toMatch(/^ {2}pull_request:/m);
  expect(workflow).toContain('test "$GITHUB_REF" = refs/heads/main');
  expect(workflow).toContain("ref: ${{ github.sha }}");
  expect(workflow).toContain("environment: npm-release");
  expect(workflow).not.toContain("required_reviewers");
  expect(workflow).not.toContain("GH_TOKEN");
  expect(workflow).toContain("id-token: write");
  expect(workflow).toContain("--ignore-scripts --provenance");
  expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  expect(workflow).toContain("git merge-base --is-ancestor");
});

it("skips pending and published versions before building or requesting publishing permissions", () => {
  const workflow = fs.readFileSync(".github/workflows/npm-release.yml", "utf8");
  expect(workflow).toContain('node scripts/plan-release.mjs >> "$GITHUB_OUTPUT"');
  expect(workflow).toContain("if: needs.prepare.outputs.should_publish == 'true'");
  expect(workflow).toContain("EXPECTED_VERSION: ${{ needs.prepare.outputs.version }}");
  expect(workflow).toContain("if: steps.release.outputs.should_publish == 'true'");
  const prepare = workflow.split("\n  publish:\n")[0];
  expect(prepare).not.toContain("id-token: write");
});
