#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export function publicationNeeded(registry, verified, tarball) {
  assert.equal(verified.name, "todu-forgejo-plugin");
  assert.equal(
    verified.integrity,
    `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    "Verified tarball has changed"
  );
  if (registry.error) {
    assert.equal(registry.error.code, "E404", "Registry lookup failed; do not attempt publication");
    return true;
  }
  assert.equal(registry.version, verified.version, "Registry returned an unexpected version");
  assert.equal(
    registry["dist.integrity"],
    verified.integrity,
    "Existing npm version differs from the verified artifact; never overwrite it"
  );
  return false;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verified = JSON.parse(fs.readFileSync(".release/package-verification.json", "utf8"));
  assert.equal(verified.version, process.env.EXPECTED_VERSION, "Publication version mismatch");
  assert.equal(verified.filename, `todu-forgejo-plugin-${verified.version}.tgz`);
  const registry = JSON.parse(fs.readFileSync(".release/registry.json", "utf8"));
  const needed = publicationNeeded(
    registry,
    verified,
    fs.readFileSync(path.join(".release", verified.filename))
  );
  console.log(`should_publish=${needed}`);
}
