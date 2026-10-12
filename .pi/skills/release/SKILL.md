---
name: release
description: Prepare and release @todu/forgejo with automatically incrementing stable versions. Use for "release", "cut a release", "new version", "publish to npm", or "ship it" in this repository.
---

# Release @todu/forgejo

Run all commands and resolve the repository paths below from the repository root (`../../..` relative to this skill directory). Read `docs/release.md` before starting. Follow the repository's plan, review and human merge gates. Merging a prepared version PR authorizes automatic OIDC publication; do not add a second publication approval prompt. The assistant handles Changesets; never ask the user to manage version files or prerelease state.

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

Commit the version/changelog/lockfile/generated-source changes and consumed Changeset removals. Open a normal source/version PR, run `todu-pr-review`, and stop for explicit human merge approval, clearly stating that merging the version PR publishes automatically. Complete the audit/release-path assessment before this merge gate. Versioning happens locally, never in CI.

## 4. Monitor automatic publication

After the approved version PR merges, `npm-release.yml` runs automatically on `main`. It skips pending Changesets and already-published versions, otherwise builds/verifies the exact event SHA and publishes only the isolated-install-tested tarball on **latest** using OIDC. No npm login/2FA, stored token, separate dispatch or environment-reviewer approval is required. Keep the `npm-release` environment main-only with no reviewers/wait timer; its name must match the existing npm trust identity. Tags do not publish.

Record the exact workflow SHA/version/channel/artifact integrity and outcome. For a failed run, retry the current workflow with `gh workflow run npm-release.yml --ref main`, without additional publication approval or another version bump. Unexpected registry errors and raced existing versions with different integrity fail closed. Do not replace trusted publishing with local npm login or broaden security settings to recover an error.

Verify the public registry's exact version, tarball SHA-512 and `latest` tag before reporting success. Allow bounded registry propagation checks; do not republish or bump merely because an immediate lookup returned 404. A saved publisher connection or successful skipped run does not prove OIDC works; successful publication of a new reviewed version does. Record evidence on the task when applicable. Live installation, daemon restart and task closure remain separate actions.
