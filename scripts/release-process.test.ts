import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
      name: "todu-forgejo-plugin",
      version: "0.1.0",
      private: false,
    })
  );
  fs.writeFileSync(
    path.join(directory, "package-lock.json"),
    JSON.stringify({
      name: "todu-forgejo-plugin",
      version: "0.1.0",
      packages: { "": { name: "todu-forgejo-plugin", version: "0.1.0" } },
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
      '---\n"todu-forgejo-plugin": patch\n---\nFix\n'
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

  it("requires explicit publication inputs and keeps prereleases off latest", () => {
    expect(run("generate-version.mjs", directory).status).toBe(0);
    expect(run("check-release.mjs", directory).status).not.toBe(0);
    expect(
      run("check-release.mjs", directory, "--version", "0.1.0", "--tag", "latest").status
    ).toBe(0);
    replace(directory, "package.json", "0.1.0", "0.2.0-next.0");
    replace(directory, "package-lock.json", "0.1.0", "0.2.0-next.0");
    replace(directory, "CHANGELOG.md", "0.1.0", "0.2.0-next.0");
    expect(run("generate-version.mjs", directory).status).toBe(0);
    expect(
      run("check-release.mjs", directory, "--version", "0.2.0-next.0", "--tag", "latest").status
    ).not.toBe(0);
    expect(
      run("check-release.mjs", directory, "--version", "0.2.0-next.0", "--tag", "next").status
    ).toBe(0);
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
