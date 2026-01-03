# Release Command

Release all packages with the specified version.

## Arguments

- `$ARGUMENTS`: The version number (semver)

## Pre-flight Checks

1. Ensure working directory is clean: `git status --porcelain`
2. Ensure on main branch: `git branch --show-current`

## Release Steps

### 1. Update Package Versions

Update all `package.json` files to the new version:

```bash
sd '"version": "[^"]+"' '"version": "$ARGUMENTS"' packages/*/package.json
```

Verify:
```bash
grep -h '"version"' packages/*/package.json
```

### 2. Update Changelogs

Replace `[Unreleased]` with the version and date in all changelogs:

```bash
sd '## \[Unreleased\]' '## [$ARGUMENTS] - $(date +%Y-%m-%d)' packages/*/CHANGELOG.md
```

Then add new `[Unreleased]` sections for the next cycle:

```bash
sd '^(# Changelog\n\n)' '$1## [Unreleased]\n\n' packages/*/CHANGELOG.md
```

If the multiline replace doesn't work, use sed:
```bash
for f in packages/*/CHANGELOG.md; do
  sed -i 's/^# Changelog$/# Changelog\n\n## [Unreleased]/' "$f"
done
```

Fix any duplicate `[Unreleased]` sections:
```bash
sd '## \[Unreleased\]\n\n## \[Unreleased\]' '## [Unreleased]' packages/*/CHANGELOG.md
```

### 3. Commit and Tag

```bash
git add .
git commit -m "chore: bump version to $ARGUMENTS"
git tag v$ARGUMENTS
```

### 4. Push

```bash
git push origin main
git push origin v$ARGUMENTS
```

### 5. Watch CI

Monitor the GitHub Actions workflow:

```bash
# Get the latest run ID
gh run list --limit 1 --json databaseId,status

# Watch until completion
gh run watch <RUN_ID> --exit-status
```

### 6. Handle CI Failures

If CI fails:

1. Read the error from the workflow output
2. Fix the issue locally
3. Amend the commit: `git commit --amend --no-edit`
4. Force push: `git push origin main --force`
5. Update the tag: `git tag -f v$ARGUMENTS && git push origin v$ARGUMENTS --force`
6. Watch CI again until it passes

Repeat until CI is green.

## Post-Release

After CI passes, the release is complete. The tag `v$ARGUMENTS` points to the final commit.

If publishing to npm is needed:
```bash
npm run publish
```
