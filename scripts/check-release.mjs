#!/usr/bin/env node
import fs from "node:fs";
import { parseArgs } from "node:util";
import semver from "semver";

import { checkVersion } from "./generate-version.mjs";

const { values } = parseArgs({
  options: { version: { type: "string" }, tag: { type: "string" } },
});
const metadata = checkVersion();
if (metadata.name !== "@todu/forgejo") {
  throw new Error("Release package must be @todu/forgejo");
}
if (!values.version || values.version !== metadata.version) {
  throw new Error("--version must explicitly match package.json");
}
if (values.tag !== "latest") {
  throw new Error("--tag must be latest");
}
if (semver.prerelease(metadata.version)) {
  throw new Error("Release versions must be stable SemVer without prerelease suffixes");
}
if (fs.existsSync(".changeset/pre.json")) {
  throw new Error("Exit Changesets prerelease mode and finish local versioning before publication");
}
if (metadata.private !== false)
  throw new Error("Release package must explicitly set private: false");
const pending = fs
  .readdirSync(".changeset")
  .filter((name) => name.endsWith(".md") && name !== "README.md");
if (pending.length) throw new Error(`Local versioning is pending: ${pending.join(", ")}`);
const notes = fs.readFileSync("CHANGELOG.md", "utf8").split("\n");
if (
  !notes.some(
    (line) => line === `## ${metadata.version}` || line.startsWith(`## ${metadata.version} - `)
  )
) {
  throw new Error("Prepare the exact release version's CHANGELOG.md section before publication");
}
console.log(`Release metadata verified: ${metadata.name}@${metadata.version} (${values.tag})`);
