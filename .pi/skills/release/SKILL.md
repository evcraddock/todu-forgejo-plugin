---
name: release
description: Prepare and release @todu/forgejo with automatically incrementing stable versions. Use for "release", "cut a release", "new version", "publish to npm", or "ship it" in this repository.
---

# Release @todu/forgejo

Run all commands and resolve the repository paths below from the repository root (`../../..` relative to this skill directory). Read `docs/release.md` before starting. Follow the repository's plan, review, human merge, and exact-artifact publication approval gates. The assistant handles Changesets; never ask the user to manage version files or prerelease state.

## Version policy

- Every **new release request** prepares an incremented stable version. Default to one patch bump: **0.1.1 → 0.1.2 → 0.1.3**.
- Use a minor bump for compatible new functionality. Ask before an intentional breaking change or major bump.
- Versions have no experimental, `next`, beta, RC, or other prerelease suffix. Publish to **latest** only.
- Never enable Changesets prerelease mode. Stop if `.changeset/pre.json` exists; diagnose it rather than silently creating another prerelease.
- A failed publication or authentication retry resumes the already reviewed version/artifact. It is not a new release request and must not increment the version again.
- A stable version number does not claim that known sync limitations are fixed. Keep those limitations disclosed.

## 1. Inspect and plan

Check task readiness when working on a tracked task. Inspect the current version, git status, current main, pending Changesets, changelog, and any existing release handoff. Start a new release from clean current main on a scoped branch. Do not discard the user's changes or silently abandon a prepared but unpublished release.

For a new release, summarize the changes since the last release and choose the bump. Show the scoped plan and obtain the repository-required approval before edits. Do not add a second Changeset/bump if this release is already prepared or the request is to retry publication.

## 2. Prepare the increment locally

Use existing pending Changesets if they already cover the requested release. Otherwise write `.changeset/forgejo-release.md`, using a factual user-facing summary:

```markdown
---
"@todu/forgejo": patch
---

Describe the changes included in this release.
```

Select the bump yourself; patch is the default even when the user simply asks for the next release. Then run:

```bash
npm run version-packages
npm run version:check
```

Changesets increments the stable version and updates the changelog; `version-packages` also generates `src/version.ts` and synchronizes the root lockfile. Never hand-edit the generated version source. Check that exactly the intended stable increment occurred, no prerelease state remains, and dependency entries have not changed.

## 3. Verify and review

```bash
./scripts/pre-pr.sh
npm run build
npm run release:guard -- --version "$VERSION" --tag latest
npm run release:check -- --pack-dir .release
```

Refresh full and production audits and assess findings against the actual release path as documented in `docs/release.md`. Do not apply forced fixes, invent unrelated host upgrades, or treat development findings as automatically exempt.

Commit the version/changelog/lockfile/generated-source changes and consumed Changeset removals. Open a normal source/version PR, run `todu-pr-review`, and stop for explicit human merge approval. Versioning happens locally, never in CI.

## 4. Publish the reviewed stable artifact

After merge, build and verify the merged source and record its exact main SHA, `@todu/forgejo` version, **latest** channel, tarball path, and SHA-512 integrity. Obtain separate exact-artifact publication approval. Prior approval for another version does not carry forward.

Use the manual `npm-release.yml` workflow only when its protected environment and npm trusted publisher are configured and approved. Dispatch with the approved commit/version; the workflow fixes the channel to `latest`. Merges and tags do not publish.

If the user explicitly chooses local exact-tarball publication, the maintainer handles any login/browser/2FA privately in an interactive terminal. Never read or request credentials or codes. Never change npm/GitHub security, access, publishers, or environment protection to recover an authentication failure.

Verify the public registry's exact version, tarball SHA-512, and `latest` tag before reporting success. Allow bounded registry propagation checks after publication; do not republish or bump merely because an immediate lookup returned 404. Record evidence on the task when applicable. Live installation, daemon restart, and task closure remain separate actions.
