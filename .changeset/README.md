# Changesets

Use `npm run changeset` to record a user-visible change and its patch, minor, or major bump. Prepare versions locally with `npm run version-packages`, then review the resulting version, generated source, changelog, and lockfile in a PR.

The repository's `release` skill manages these steps automatically for each new release, defaulting to one stable patch increment (0.1.1 → 0.1.2 → 0.1.3). Do not enable prerelease mode or add version suffixes. A publication retry reuses the prepared version instead of incrementing again.

Nothing in this directory authorizes publication. Releases use stable versions on `latest`; see [the release process](../docs/release.md) for verification and the separate publication gate.
