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

## Separate publication gate

Source/version PR review and explicit human merge approval remain mandatory. Merging to `main` does **not** publish. Tags also do not publish. After merge, obtain separate explicit publication approval for the exact main commit SHA, package version, channel, and verified artifact.

The `NPM Release` workflow is manual-dispatch only. It:

1. Requires dispatch from `main`, a full 40-character commit SHA reachable from `main`, and an exact expected stable package version. The channel is fixed to `latest`.
2. Fails if local versioning is pending, source/generated/lockfile versions disagree, the changelog lacks an exact-version release section, or any prerelease version/state is present.
3. Requires an existing `npm-release` GitHub environment with human required reviewers before the publish job can be scheduled; missing/unprotected configuration fails closed rather than silently creating an unprotected publishing environment.
4. Runs checks, builds, verifies that generated files are committed, and uploads the exact isolated-install-tested tarball.
5. Waits for the separate environment approval before gaining OIDC publication permissions. The artifact, not a new build, is published with lifecycle scripts disabled.
6. Checks the registry first. An identical existing version is skipped; different integrity, unexpected lookup errors, or altered tarball bytes fail. After publishing, exact registry version and integrity must match the verified tarball. No git tags or GitHub releases are created.

After explicit approval and the one-time setup below, dispatch from `main`:

```bash
gh workflow run npm-release.yml --ref main \
  -f commit="$APPROVED_COMMIT" \
  -f version="$APPROVED_VERSION"
gh run list --workflow npm-release.yml
gh run view "$RUN_ID"
```

Record the workflow URL and `npm view @todu/forgejo@<version> version dist.integrity --json` result; verify the downloaded tarball integrity and `latest` tag as well. Allow bounded registry propagation checks after publication rather than republishing or bumping on an immediate 404. A successful local build or saved publisher configuration is not proof of publication. Changing installed software or restarting a live daemon needs separate approval.

## One-time maintainer setup — separately approved

The first package has been bootstrapped locally by the maintainer and publicly verified. This does not establish that npm trusted publishing or the protected GitHub environment is configured. Source/version preparation never configures publishers, creates GitHub environments, changes security settings, or dispatches publication.

1. Confirm package-name ownership/availability and the maintainer's permission to publish public packages in the `@todu` npm scope, then approve the exact `@todu/forgejo` artifact/version/channel. Do not create or alter scope membership/access opportunistically. An anonymous registry `E404` does not guarantee that a name can be claimed.
2. The maintainer must bootstrap the first public npm package if it does not yet exist, because npm trusted-publisher settings require an existing package. Use the verified tarball from `.release`, not an unverified checkout. The maintainer handles npm login/2FA personally and runs the separately approved `npm publish <verified-tarball> --access public --tag <approved-channel> --ignore-scripts --registry=https://registry.npmjs.org`. Never share credentials or one-time codes with an agent. The automated workflow intentionally requires the initial package to exist and does not perform this bootstrap.
3. With explicit approval for GitHub protection configuration, create the `npm-release` environment, add required human reviewer(s), and restrict deployment branches to `main`. The workflow checks reviewer presence before scheduling the publish job. Do not weaken or remove protections to recover a failure.
4. With explicit approval for npm publisher configuration, configure the package's trusted publisher for GitHub Actions: owner `evcraddock`, repository `todu-forgejo-plugin`, workflow filename `npm-release.yml`, environment `npm-release`, and direct npm publishing enabled. Keep package repository metadata matching this repository. The publish job uses GitHub-hosted runners, Node 24, and `id-token: write`; no long-lived npm token is used or stored.
5. Verify the bootstrap registry integrity against the verified tarball. Later versions can use the manually gated workflow. Do not treat local bootstrap as proof that OIDC works; successful automated publication establishes that.

## Dependency audit and release-path assessment

The October 10, 2026 release-process preparation audit reported **17 affected development packages: 1 low, 10 moderate, 6 high**, versus **18** in the earlier baseline, and **0 production findings**. That was a historical preparation snapshot, not a security waiver or the current candidate's audit result.

For the `0.1.1-next.0` candidate on October 11, 2026, scoped Vitest/coverage, esbuild, ESLint, and compatible transitive updates remediate the lint/test/build findings. Fresh audits report **6 moderate affected development packages, no low/high/critical findings, and 0 production findings**. All six remaining affected-package entries propagate a single advisory, [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), through unchanged host-test fixtures. The full development audit is **not clean**.

The remaining advisory concerns the `v3()`, `v5()`, and `v6()` identifier-generator APIs with caller-provided output buffers. Inspected installed fixture consumers use `v4()`, `validate()`, and `parse()`, not those affected APIs. Tests use reviewed inputs, in-process host fixtures, temporary storage, and no daemon process, networking, live Vite server, or Forgejo credentials. Host/core/storage dependency versions remain unchanged. This is a scoped release-path assessment, not an upstream repair or a blanket acceptance of host security risk.

An in-memory build dependency graph contains only plugin source and `@todu/core` runtime modules; host-test modules do not enter the shipped bundle. Package checks verify isolated installation/loading/types without provider initialization and strip inherited credentials/config/state. A zero production audit alone does not prove that build inputs or arbitrary host applications are safe. Preparation jobs have no npm publishing permission; the separate publication job installs no development dependencies and publishes the previously verified tarball. No affected path for the remaining advisory was identified in the plugin artifact or controlled fixture tests.

**Disposition:** re-run full and production audits before publication and assess any changed finding against the actual release environment. Remediate remaining **relevant** paths or obtain explicit narrowly scoped human acceptance identifying findings, exposure, and mitigations. An unchanged host-test finding does not by itself mandate a host-storage upgrade. No forced fixes, host downgrades, broad overrides, disabled checks, or blanket exceptions are authorized. Source merge, package verification, and publisher setup grant no security exception. Record fresh audits and the separately approved exact-artifact publication decision.

## Recovery and upgrades

Retry a failed publication only after explicit approval, using the same reviewed SHA/version/channel and without another version bump solely for an authentication failure. Fix the actual publisher/environment/workflow identity mismatch through a reviewed PR when needed. Keep the first approved artifact and compare registry integrity before retrying; never overwrite an existing npm version or change authentication/security settings opportunistically. If an existing version has different bytes, investigate and prepare a new reviewed release rather than claiming a successful retry.

For installation and upgrades, use the README and review the changelog plus [storage migration guide](FORGEJO-STORAGE-MIGRATION.md). Back up both Todu data and plugin state before a separately approved deployment. Retain pending pull batches and field snapshots; do not manually copy legacy cursor values into acknowledged checkpoints. Do not downgrade across a storage migration unless the old version is known to support the schema or a coordinated backup restore has been approved.

Current sync limitations are disclosed in the changelog and README. Package validation is not a real Forgejo integration test or a claim of production readiness; live smoke tests remain separately approved.
