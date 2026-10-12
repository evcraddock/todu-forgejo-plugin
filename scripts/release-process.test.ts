import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { verifyPackage } from "./verify-package.mjs";

const root = process.cwd();
const run = (script: string, directory: string, ...args: string[]) =>
  spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    cwd: directory,
    encoding: "utf8",
  });

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-release-version-"));
  fs.mkdirSync(path.join(directory, "src"));
  fs.mkdirSync(path.join(directory, ".changeset"));
  fs.writeFileSync(
    path.join(directory, "CHANGELOG.md"),
    "# Changelog\n\n## 0.1.0\n\nInitial release.\n"
  );
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "@todu/forgejo",
      version: "0.1.0",
      private: false,
    })
  );
  fs.writeFileSync(
    path.join(directory, "package-lock.json"),
    JSON.stringify({
      name: "@todu/forgejo",
      version: "0.1.0",
      packages: { "": { name: "@todu/forgejo", version: "0.1.0" } },
    })
  );
  return directory;
}

function replace(directory: string, file: string, before: string, after: string) {
  const full = path.join(directory, file);
  fs.writeFileSync(full, fs.readFileSync(full, "utf8").replaceAll(before, after));
}

describe("release version guards", () => {
  let directory: string;
  beforeEach(() => {
    directory = fixture();
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true });
  });

  it("generates the compiled constant and checks without rewriting stale files", () => {
    expect(run("generate-version.mjs", directory).status).toBe(0);
    expect(run("generate-version.mjs", directory, "--check").status).toBe(0);
    replace(directory, "src/version.ts", "0.1.0", "9.9.9");
    const original = fs.readFileSync(path.join(directory, "src/version.ts"), "utf8");
    const result = run("generate-version.mjs", directory, "--check");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("version.ts");
    expect(fs.readFileSync(path.join(directory, "src/version.ts"), "utf8")).toBe(original);
  });

  it.each(["todu-forgejo-plugin", "todu/forgejo", "@todu/other"])(
    "rejects unexpected npm identity %s before release or packing",
    (name) => {
      for (const file of ["package.json", "package-lock.json"]) {
        replace(directory, file, "@todu/forgejo", name);
      }
      expect(run("generate-version.mjs", directory).status).toBe(0);
      const result = run("check-release.mjs", directory, "--version", "0.1.0", "--tag", "latest");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("@todu/forgejo");
      expect(() => verifyPackage(directory)).toThrow("@todu/forgejo");
    }
  );

  it.each(["package-lock.json", "src/version.ts"])("rejects drift in %s", (file) => {
    expect(run("generate-version.mjs", directory).status).toBe(0);
    replace(directory, file, "0.1.0", "0.2.0");
    expect(
      run("check-release.mjs", directory, "--version", "0.1.0", "--tag", "latest").status
    ).not.toBe(0);
  });

  it("rejects an unexpected release version, pending changesets, and private packages", () => {
    expect(run("generate-version.mjs", directory).status).toBe(0);
    expect(
      run("check-release.mjs", directory, "--version", "0.2.0", "--tag", "latest").status
    ).not.toBe(0);
    fs.writeFileSync(
      path.join(directory, ".changeset", "pending.md"),
      '---\n"@todu/forgejo": patch\n---\nFix\n'
    );
    expect(
      run("check-release.mjs", directory, "--version", "0.1.0", "--tag", "latest").status
    ).not.toBe(0);
    fs.unlinkSync(path.join(directory, ".changeset", "pending.md"));
    replace(directory, "package.json", '"private":false', '"private":true');
    expect(
      run("check-release.mjs", directory, "--version", "0.1.0", "--tag", "latest").status
    ).not.toBe(0);
  });

  it("requires explicit publication inputs and only accepts the latest channel", () => {
    expect(run("generate-version.mjs", directory).status).toBe(0);
    expect(run("check-release.mjs", directory).status).not.toBe(0);
    expect(
      run("check-release.mjs", directory, "--version", "0.1.0", "--tag", "latest").status
    ).toBe(0);
    for (const tag of ["next", "beta", "garbage"]) {
      const result = run("check-release.mjs", directory, "--version", "0.1.0", "--tag", tag);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("--tag must be latest");
    }
  });

  it.each(["0.2.0-next.0", "0.2.0-beta.1", "0.2.0-rc.1"])(
    "rejects prerelease version %s on every channel",
    (version) => {
      for (const file of ["package.json", "package-lock.json", "CHANGELOG.md"]) {
        replace(directory, file, "0.1.0", version);
      }
      expect(run("generate-version.mjs", directory).status).toBe(0);
      for (const tag of ["latest", "next"]) {
        expect(
          run("check-release.mjs", directory, "--version", version, "--tag", tag).status
        ).not.toBe(0);
      }
    }
  );

  it.each(["pre", "exit"])("rejects leftover Changesets %s mode before publishing", (mode) => {
    expect(run("generate-version.mjs", directory).status).toBe(0);
    fs.writeFileSync(
      path.join(directory, ".changeset", "pre.json"),
      JSON.stringify({ mode, tag: "next" })
    );
    const result = run("check-release.mjs", directory, "--version", "0.1.0", "--tag", "latest");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("prerelease mode");
  });

  it("accepts dated stable release notes", () => {
    replace(directory, "CHANGELOG.md", "## 0.1.0", "## 0.1.0 - 2026-10-12");
    expect(run("generate-version.mjs", directory).status).toBe(0);
    const result = run("check-release.mjs", directory, "--version", "0.1.0", "--tag", "latest");
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("requires release notes for the exact approved version", () => {
    expect(run("generate-version.mjs", directory).status).toBe(0);
    replace(directory, "CHANGELOG.md", "## 0.1.0", "## Unreleased");
    const result = run("check-release.mjs", directory, "--version", "0.1.0", "--tag", "latest");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CHANGELOG.md");
  });

  it.each(["garbage", "01.2.3", "1.2.3-next.01", "1.2.3+build"])(
    "rejects non-publishable version %s",
    (version) => {
      replace(directory, "package.json", "0.1.0", version);
      expect(run("generate-version.mjs", directory).status).not.toBe(0);
    }
  );
});
