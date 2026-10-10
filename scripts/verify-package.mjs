#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { checkVersion } from "./generate-version.mjs";

const requiredFiles = [
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
];

export function checkPackFiles(files) {
  const names = files.map((entry) => entry.path);
  for (const name of requiredFiles) {
    assert(names.includes(name), `Required package file missing: ${name}`);
  }
  for (const name of names) {
    assert(
      requiredFiles.includes(name) || /^dist\/[a-z0-9-]+\.d\.ts$/.test(name),
      `Unexpected package file (possible source, secret, or runtime state): ${name}`
    );
  }
}

export function verifyPackage(root = process.cwd(), outputDirectory) {
  const metadata = checkVersion(root);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgejo-package-"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const home = path.join(directory, "home");
  fs.mkdirSync(home);
  const userConfig = path.join(directory, "npmrc");
  const globalConfig = path.join(directory, "global-npmrc");
  fs.writeFileSync(userConfig, "");
  fs.writeFileSync(globalConfig, "");
  // Never inherit Todu overrides, npm authentication, plugin config, or live HOME.
  const env = {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"),
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_CACHE: path.join(directory, "npm-cache"),
  };
  const run = (command, args, cwd) =>
    execFileSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    const [packed] = JSON.parse(
      run(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], root)
    );
    assert.equal(packed.name, metadata.name);
    assert.equal(packed.version, metadata.version);
    checkPackFiles(packed.files);
    const tarball = path.join(directory, packed.filename);
    const consumer = path.join(directory, "consumer");
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
    run(
      npm,
      [
        "install",
        tarball,
        `@types/node@${JSON.parse(fs.readFileSync(path.join(root, "node_modules/@types/node/package.json"), "utf8")).version}`,
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--registry=https://registry.npmjs.org",
      ],
      consumer
    );
    const installed = path.join(consumer, "node_modules", metadata.name);
    const installedMetadata = JSON.parse(
      fs.readFileSync(path.join(installed, "package.json"), "utf8")
    );
    assert.equal(installedMetadata.version, metadata.version);
    assert.equal(installedMetadata.name, metadata.name);
    fs.writeFileSync(
      path.join(consumer, "load.mjs"),
      `
import assert from "node:assert/strict";
import { syncProvider, FORGEJO_PROVIDER_VERSION } from ${JSON.stringify(metadata.name)};
assert.equal(syncProvider.manifest.name, "forgejo");
assert.equal(syncProvider.manifest.version, ${JSON.stringify(metadata.version)});
assert.equal(syncProvider.provider.version, ${JSON.stringify(metadata.version)});
assert.equal(FORGEJO_PROVIDER_VERSION, ${JSON.stringify(metadata.version)});
assert.equal(syncProvider.manifest.apiVersion, 4);
for (const method of ["initialize", "shutdown", "pull", "push", "acknowledgePull"]) {
  assert.equal(typeof syncProvider.provider[method], "function");
}
`
    );
    run(process.execPath, ["load.mjs"], consumer);
    for (const entry of packed.files.filter((entry) => entry.path.endsWith(".d.ts"))) {
      assert(
        !fs.readFileSync(path.join(installed, entry.path), "utf8").includes("@/"),
        `Source alias leaked into ${entry.path}`
      );
    }
    fs.writeFileSync(
      path.join(consumer, "consumer.mts"),
      `
import { syncProvider, createForgejoSyncProvider, type ForgejoSyncProvider } from ${JSON.stringify(metadata.name)};
const provider: ForgejoSyncProvider = createForgejoSyncProvider();
const version: string = syncProvider.manifest.version;
void provider;
void version;
`
    );
    run(
      process.execPath,
      [
        path.join(root, "node_modules/typescript/lib/tsc.js"),
        "--noEmit",
        "--strict",
        "--module",
        "nodenext",
        "--target",
        "es2022",
        "consumer.mts",
      ],
      consumer
    );
    const integrity = `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
    assert.equal(integrity, packed.integrity);
    if (outputDirectory) {
      fs.mkdirSync(outputDirectory, { recursive: true });
      fs.copyFileSync(tarball, path.join(outputDirectory, packed.filename));
      fs.writeFileSync(
        path.join(outputDirectory, "package-verification.json"),
        JSON.stringify(
          {
            name: packed.name,
            version: packed.version,
            filename: packed.filename,
            integrity,
            apiVersion: 4,
            files: packed.files.map((entry) => entry.path),
          },
          null,
          2
        ) + "\n"
      );
    }
    console.log(
      `Verified packed installation, provider manifest, and consumer types: ${packed.name}@${packed.version}`
    );
    return { filename: packed.filename, integrity };
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { "pack-dir": { type: "string" } } });
  verifyPackage(process.cwd(), values["pack-dir"] && path.resolve(values["pack-dir"]));
}
