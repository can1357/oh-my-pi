# Release

Release all packages at specified version.

## Arguments

`$ARGUMENTS`: semver version, e.g. `3.13.0`.

## Version

- Last release: latest git tag (`vX.Y.Z`); confirm matches `packages/*/package.json` versions.
- No version: review commits since last tag; choose major/minor/patch; bump.
- `major`/`minor`/`patch`: bump last tag — major `X+1.0.0`; minor `X.Y+1.0`; patch `X.Y.Z+1`.

## Run

```bash
bun scripts/release.ts $ARGUMENTS
```

Script automatically:
1. Pre-flight: clean working dir; main branch.
2. Update all `package.json` versions.
3. Regenerate `bun.lock`.
4. Update CHANGELOGs: `[Unreleased] → [version] - date`.
5. Commit and tag.
6. Push to origin.
7. Watch CI until all workflows pass.

## CI failures

CI failure → script exits with error. Fix, then repeat until CI passes:

```bash
git commit -m "fix: <brief description>"
git push origin main
git tag -f v$ARGUMENTS && git push origin v$ARGUMENTS --force
bun scripts/release.ts watch
```

`watch`: re-watches CI for current commit until all checks pass.
