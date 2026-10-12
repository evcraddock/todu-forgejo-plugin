# Versioning and Release Process

## Distribution and independent versions

The approved distribution channel is the public npm package `@todu/forgejo`. This npm identity is separate from provider identity `forgejo` and repository `evcraddock/todu-forgejo-plugin`, both of which remain unchanged. The scoped tarball basename is `todu-forgejo-<version>.tgz`, and the installed entrypoint is `<npm-root>/@todu/forgejo/dist/index.js`. The distributable is an npm tarball containing the bundled ESM provider (`dist/index.js`), TypeScript declarations, README, license, changelog, release/migration/smoke-test guides, and standalone storage-migration helper. GitHub binary releases are not part of this process.

`package.json` is the release-version source of truth. `scripts/generate-version.mjs` generates the tracked `src/version.ts`; the provider and manifest use that compiled value, without needing source files or a runtime JSON import. `npm run version:check` rejects stale generated source and mismatched root lockfile metadata. Build regenerates the source; CI also requires generated changes to be committed. Never edit `src/version.ts` manually.

The npm package version, sync-provider API version, and storage schema versions are independent. This release tooling retains provider API **v4** and runtime checkpoint schema **2**. It does not opt into API v5 or change sync behavior. The host must support API v4 acknowledgment. Isolated host lifecycle tests use published `@todu/daemon@0.25.1`, `@todu/engine@0.24.1`, and `@todu/core@0.25.2`; these are verified development fixtures, not a claim of the oldest compatible host release.

Use Node.js **24** and npm **11.5.1 or later** for development/versioning and trusted publication. Changesets v3 requires a supported modern Node release; the installed plugin's runtime requirement remains Node.js 20 or newer. Check the host's own runtime requirements as well.

## Version rules

- **Patch:** compatible fixes, maintenance, and small internal changes.
- **Minor:** compatible new functionality.
- **Major:** incompatible public behavior, configuration, or installation changes. Before 1.0, explicitly document incompatible changes and use a minor bump; do not hide them in patches.
- **Release channel:** use stable `X.Y.Z` versions and npm's `latest` channel only. Do not enable Changesets prerelease mode or add `next`, beta, RC, or other prerelease suffixes. The publication guard rejects prerelease versions, leftover prerelease state, and channels other than `latest`.

Changing the provider API or storage schema is a compatibility decision, not an automatic package-version bump rule. Document required host upgrades, backups, and migration/rollback restrictions in the release notes. Package versions use canonical SemVer without build metadata.

## Prepare locally, review normally

Run the repository's `release` skill (`/skill:release` in Pi), or ask the assistant to release the plugin. The assistant manages Changesets and prepares one stable increment for each new release request, defaulting to patch: **0.1.1 → 0.1.2 → 0.1.3**. Compatible features can use minor; intentional breaking changes require an explicit compatibility decision. Retrying publication of an already prepared release reuses its version and verified artifact, without another bump.

The skill creates a patch Changeset when the requested release has none pending, summarizes the actual changes, and runs:

```bash
npm run version-packages
```

For manual preparation, `npm run changeset` selects `@todu/forgejo`, the appropriate bump, and a user-facing summary before the same versioning command. Versioning is local, never performed by CI. `version-packages` consumes pending changesets, updates the version/changelog, generates `src/version.ts`, and synchronizes the lockfile. Review all of those changes in a normal source/version PR.

Prerelease mode is not part of the release flow. If an old checkout still has `.changeset/pre.json`, the one-time transition is `npm run changeset -- pre exit`, then `npm run version-packages`; review the resulting stable version and removal of prerelease state. Never re-enter prerelease mode. Do not use `changeset publish`: our publication workflow publishes only the isolated-install-tested tarball with the approved stable version on `latest`.

Before review:

```bash
./scripts/pre-pr.sh
npm run build
npm run release:check
```

The package check uses temporary HOME/config/state and npm config/cache directories, packs with lifecycle scripts disabled, installs the tarball into an isolated consumer using the public registry without inherited credentials, loads the exported provider without initializing it, and compiles a strict NodeNext TypeScript consumer. It checks package contents and package/provider/manifest versions. It does not start a daemon, contact Forgejo, or register/configure a live plugin. Anonymous npm dependency reads are required. Unexpected files, source aliases in declarations, stale bundles, or version mismatches fail the check.

`npm run release:check -- --pack-dir .release` retains that exact tested tarball plus `package-verification.json` with its SHA-512 integrity. This directory is ignored by git.

The first public package, `@todu/forgejo@0.1.1-next.0`, was published and its registry tarball verified against the approved SHA-512. That historical npm version cannot be renamed or overwritten; its changelog section remains intact. Current source exits that prerelease state and prepares stable **0.1.1**. This source preparation does not publish 0.1.1. Subsequent new releases increment from the stable version using Changesets, normally to 0.1.2, then 0.1.3. Stable numbering does not remove the known sync limitations or imply production-hardening work was performed. Old-name tarballs and old exact-artifact approvals are not reusable for new releases. The guard requires release notes for the exact candidate version, such as `## 0.1.1`.

## Automatic publication after merge

Source/version PR review and explicit human merge approval remain mandatory. **Merging a prepared version PR to `main` authorizes automatic npm publication.** There is no additional manual release dispatch, npm login/2FA, exact-artifact approval prompt or environment-reviewer wait. Tags do not trigger publication. Installation and live daemon changes remain separately approved.

The `NPM Release` workflow runs on every push to `main` and supports a parameter-free manual retry from `main`. It:

1. Checks out the immutable event SHA and requires it to be reachable from `main`. It reads the version from committed package metadata, never versions in CI, and fixes the channel to `latest`.
2. Skips pending local Changesets and versions already on npm **before packing**. Existing-version skips do not claim that changed source or a recompressed candidate matches the published artifact. Invalid identity/private/prerelease state, generated/lockfile drift, unexpected registry errors and malformed metadata fail closed.
3. For an unpublished version, validates exact-version release notes and runs quality/build checks. It verifies generated files are committed, tests the package in an isolated consumer, and uploads only the verified tgz and verification JSON. `.release/` stays git-ignored; hidden-file inclusion is confined to these narrow upload paths.
4. Automatically publishes that exact verified artifact with lifecycle scripts disabled and OIDC permissions only in the publication job. The `npm-release` environment retains the existing npm identity and main-only deployment policy but has **no required reviewers or wait timer**. No long-lived publishing tokens are used.
5. Checks registry/tarball integrity again immediately before publication. If another publisher races this run, only identical existing bytes are accepted; different bytes or unexpected errors fail without overwriting a version. After publication, bounded propagation checks verify the exact version, SHA-512 metadata and `latest` tag. No git tags or GitHub releases are created.

For a failed run, retry the current workflow from `main` without another version bump or interactive npm login:

```bash
gh workflow run npm-release.yml --ref main
gh run list --workflow npm-release.yml
gh run view "$RUN_ID"
```

Record the workflow URL and `npm view @todu/forgejo@<version> version dist.integrity --json` result; verify the downloaded tarball integrity and `latest` tag as well. Allow bounded registry propagation checks after publication rather than republishing or bumping on an immediate 404. A successful local build or saved publisher configuration is not proof of publication. Changing installed software or restarting a live daemon needs separate approval.

## One-time maintainer setup — separately approved

The first package has been bootstrapped locally by the maintainer and publicly verified. This does not establish successful OIDC publication. Configuring package trust or GitHub deployment policy requires maintainer authorization; routine source/version preparation never changes those security settings. After one-time setup, merged version PRs publish without interactive maintainer authentication.

1. Confirm package-name ownership/availability and the maintainer's permission to publish public packages in the `@todu` npm scope, then approve the exact `@todu/forgejo` artifact/version/channel. Do not create or alter scope membership/access opportunistically. An anonymous registry `E404` does not guarantee that a name can be claimed.
2. The maintainer must bootstrap the first public npm package if it does not yet exist, because npm trusted-publisher settings require an existing package. Use the verified tarball from `.release`, not an unverified checkout. The maintainer handles npm login/2FA personally and runs the separately approved `npm publish <verified-tarball> --access public --tag <approved-channel> --ignore-scripts --registry=https://registry.npmjs.org`. Never share credentials or one-time codes with an agent. The automated workflow intentionally requires the initial package to exist and does not perform this bootstrap.
3. Configure the `npm-release` GitHub environment with exactly the `main` deployment branch, no required reviewers and no wait timer. Keep administrator bypass disabled. This is the maintainer-selected automatic release policy, not an authentication workaround. Retain the environment name because it is part of the existing npm trusted-publisher identity.
4. With explicit approval for npm publisher configuration, configure the package's trusted publisher for GitHub Actions: owner `evcraddock`, repository `todu-forgejo-plugin`, workflow filename `npm-release.yml`, environment `npm-release`, and direct npm publishing enabled. Keep package repository metadata matching this repository. The publish job uses GitHub-hosted runners, Node 24, and `id-token: write`; no long-lived npm token is used or stored.
5. Verify the bootstrap registry integrity against the verified tarball. Later unpublished versions use the automatic workflow. A saved npm connection or local publication does not validate OIDC: only a successful trusted-publisher publication establishes that. If npm shows a pending-validation deadline, complete a reviewed new release before that deadline; do not republish an existing version or manufacture a bump solely to bypass an error.

## Dependency audit and release-path assessment

The October 10, 2026 release-process preparation audit reported **17 affected development packages: 1 low, 10 moderate, 6 high**, versus **18** in the earlier baseline, and **0 production findings**. That was a historical preparation snapshot, not a security waiver or the current candidate's audit result.

For the `0.1.1-next.0` candidate on October 11, 2026, scoped Vitest/coverage, esbuild, ESLint, and compatible transitive updates remediate the lint/test/build findings. Fresh audits report **6 moderate affected development packages, no low/high/critical findings, and 0 production findings**. All six remaining affected-package entries propagate a single advisory, [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), through unchanged host-test fixtures. The full development audit is **not clean**.

The remaining advisory concerns the `v3()`, `v5()`, and `v6()` identifier-generator APIs with caller-provided output buffers. Inspected installed fixture consumers use `v4()`, `validate()`, and `parse()`, not those affected APIs. Tests use reviewed inputs, in-process host fixtures, temporary storage, and no daemon process, networking, live Vite server, or Forgejo credentials. Host/core/storage dependency versions remain unchanged. This is a scoped release-path assessment, not an upstream repair or a blanket acceptance of host security risk.

An in-memory build dependency graph contains only plugin source and `@todu/core` runtime modules; host-test modules do not enter the shipped bundle. Package checks verify isolated installation/loading/types without provider initialization and strip inherited credentials/config/state. A zero production audit alone does not prove that build inputs or arbitrary host applications are safe. Preparation jobs have no npm publishing permission; the separate publication job installs no development dependencies and publishes the previously verified tarball. No affected path for the remaining advisory was identified in the plugin artifact or controlled fixture tests.

**Disposition:** re-run full and production audits before publication and assess any changed finding against the actual release environment. Remediate remaining **relevant** paths or obtain explicit narrowly scoped human acceptance identifying findings, exposure, and mitigations. An unchanged host-test finding does not by itself mandate a host-storage upgrade. No forced fixes, host downgrades, broad overrides, disabled checks, or blanket exceptions are authorized. Source merge, package verification, and publisher setup grant no security exception. Record fresh audits and the release-path assessment in the version PR before merge, since merge authorizes automatic publication.

## Recovery and upgrades

Retry a failed publication using the current workflow on `main`, keeping the already prepared version and `latest` channel; do not increment solely for an authentication failure. Fix actual publisher/environment/workflow identity mismatches through reviewed changes, not a local npm login or broad token. Preserve release evidence and never overwrite an existing npm version. Already-published versions are skipped before packing; if publication races an independently produced artifact with different integrity, the publication job fails closed. Investigate rather than claiming a successful retry or weakening unrelated security settings.

For installation and upgrades, use the README and review the changelog plus [storage migration guide](FORGEJO-STORAGE-MIGRATION.md). Back up both Todu data and plugin state before a separately approved deployment. Retain pending pull batches and field snapshots; do not manually copy legacy cursor values into acknowledged checkpoints. Do not downgrade across a storage migration unless the old version is known to support the schema or a coordinated backup restore has been approved.

Current sync limitations are disclosed in the changelog and README. Package validation is not a real Forgejo integration test or a claim of production readiness; live smoke tests remain separately approved.
