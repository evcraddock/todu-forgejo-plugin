#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

import { checkVersion } from "./generate-version.mjs";

export async function lookupVersion(name, version) {
  const response = await globalThis.fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { signal: globalThis.AbortSignal.timeout(30_000) }
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry lookup failed: HTTP ${response.status}`);
  return response.json();
}

export async function planRelease(root = process.cwd(), lookup = lookupVersion) {
  const metadata = checkVersion(root);
  assert.equal(metadata.name, "@todu/forgejo", "Release package must be @todu/forgejo");
  assert.equal(metadata.private, false, "Release package must explicitly be public");
  assert.equal(semver.prerelease(metadata.version), null, "Release version must be stable");
  if (fs.existsSync(path.join(root, ".changeset/pre.json"))) {
    throw new Error("Exit Changesets prerelease mode before publication");
  }
  const pending = fs
    .readdirSync(path.join(root, ".changeset"))
    .filter((name) => name.endsWith(".md") && name !== "README.md");
  if (pending.length) {
    return {
      version: metadata.version,
      shouldPublish: false,
      reason: "Local versioning is pending",
    };
  }
  const registry = await lookup(metadata.name, metadata.version);
  if (registry === null) {
    return {
      version: metadata.version,
      shouldPublish: true,
      reason: "Version is not yet published",
    };
  }
  assert.equal(registry.name, metadata.name, "Registry returned an unexpected package");
  assert.equal(registry.version, metadata.version, "Registry returned an unexpected version");
  assert.equal(typeof registry.dist?.integrity, "string", "Registry integrity is missing");
  // Ordinary source merges may change package contents without versioning them.
  // Skip existing versions before packing; never claim a rebuilt artifact was published.
  return {
    version: metadata.version,
    shouldPublish: false,
    reason: "Version is already published",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = await planRelease();
  console.error(plan.reason);
  console.log(`version=${plan.version}`);
  console.log(`should_publish=${plan.shouldPublish}`);
}
