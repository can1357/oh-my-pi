# omp-sync

Optional, portable snapshot/rollback wrapper around official
[`omp update`](https://github.com/can1357/oh-my-pi) / `omp update --check`.

Core `omp update` already installs updates. This contrib only adds fail-soft
behavior around that command: keep a copy of the previous launcher, restore it
if the update or an optional smoke check fails, and leave user config alone.

It is not part of the omp CLI. Nothing in `packages/coding-agent` calls it.

## Why

`omp update` talks to npm/GitHub and then replaces the active launcher. A
timeout, a truncated download, or a binary that no longer starts can leave you
without a working `omp`. This script:

1. Checks for an update first (`omp update --check`, including any `--`
   flags such as `--canary` / `--stable` / `--force`).
2. Copies the current launcher into a snapshot directory.
3. Runs `omp update` with those same flags.
4. Restores the snapshot if the updater exits non-zero, the new binary cannot
   run `--version`, or `OMP_SYNC_SMOKE_CMD` fails.

Network failures during the check never replace the binary. Network failures
after the updater has started restore the snapshot (when one exists) and still
exit 2.

## Install

The script is POSIX `sh` (Linux and macOS). Copy or symlink it somewhere on
`PATH`:

```sh
install -m 0755 contrib/omp-sync/omp-sync.sh ~/.local/bin/omp-sync
```

Or run it from a clone:

```sh
./contrib/omp-sync/omp-sync.sh --check
```

## Usage

```sh
omp-sync.sh --check                 # omp update --check only
omp-sync.sh --apply                 # snapshot, then omp update
omp-sync.sh --apply -- --canary     # extra args forwarded to check and update
omp-sync.sh --list                  # snapshots (newest last)
omp-sync.sh --rollback              # restore the latest snapshot
omp-sync.sh --rollback <id>         # restore a specific snapshot
```

`--check` is the safe default for cron: it never writes snapshots or replaces
the binary. `--apply` is the mutating path.

## Snapshot location

Snapshots live **only** under the sync root:

| Precedence | Path |
| --- | --- |
| 1 | `$OMP_SYNC_DIR` if set |
| 2 | `$OMP_HOME/sync` if `OMP_HOME` is set |
| 3 | `$HOME/$PI_CONFIG_DIR/sync` (default `~/.omp/sync`) |

`HOME` is required only for row 3 when `PI_CONFIG_DIR` is relative. An
absolute `$OMP_SYNC_DIR`, `$OMP_HOME`, or `$PI_CONFIG_DIR` is enough in
minimal environments that omit `HOME`.

Each snapshot is `$sync_root/snapshots/<utc>-<version>-<pid>/` with:

- `omp` — copy of the resolved launcher
- `meta` — version, source path, launcher path, UTC timestamp, sha256

A snapshot directory is published only after `omp` and `meta` are both
written (staging directory, then rename). Incomplete dirs without `meta` are
not restorable and are ignored (and removed on prune).

After a **successful** apply, older snapshots are pruned so at most
`OMP_SYNC_KEEP` remain (default 5, minimum 1). Failed applies do not prune.

## Safety guarantees

- **Never deletes user config.** The script does not remove or rewrite
  `config.yml`, `settings.json`, `agent/`, sessions, auth, or plugin state.
  The only paths it creates or deletes are under the sync root (`snapshots/`,
  the lock file, and `last-run.log`).
- **No machine-specific paths.** Home is `$HOME`. There are no hard-coded
  user home directories.
- **Locking.** Concurrent runs are rejected (`flock` when available, otherwise
  a directory lock). Exit code 5.
- **Fail-soft network.** Registry/DNS/TLS/timeouts during `--check` or apply
  exit 2 and leave the existing launcher in place (apply restores the snapshot
  if the updater had already started).
- **Restore on apply failure (binary/shim).** Non-zero `omp update`, a
  launcher that cannot run `--version`, or a failed smoke command restores the
  snapshot taken for that apply before exiting 3 — **when the install is a
  standalone binary or a shim-takeover launcher that `omp update` replaces in
  place.** bun/npm *managed* updates reinstall the package under
  `node_modules`; this wrapper only copies the resolved launcher file, so
  restore is partial there (the entry may revert while the rest of the tree
  stays new) even though the script still reports a successful restore.
- **Best-effort rollback target.** Restore overwrites the file `omp` on
  `PATH` currently resolves to (symlink targets are followed at restore time,
  so a retargeted launcher is not left pointing at the new binary).
  Homebrew/mise installs that `omp update` itself drives are unchanged; this
  wrapper does not fight those managers. Nix-managed installs are
  detection-only (`omp update` refuses to replace them).

### Rollback coverage

| Install method | What restore does |
| --- | --- |
| Standalone binary | Full — the resolved file is replaced in place |
| Shim takeover | Full — the PATH launcher file is replaced in place |
| bun / npm managed (`updateViaManager`) | Partial — only the resolved launcher file is snapshotted; the rest of `node_modules` is not reverted |
| Homebrew / mise | Unchanged — `omp update` uses the manager |
| Nix | Detection-only — `omp update` does not install; update the flake input or profile and rebuild |

## Optional environment

| Variable | Purpose |
| --- | --- |
| `OMP_SYNC_BIN` | Launcher to wrap (default: `omp` on `PATH`) |
| `OMP_SYNC_KEEP` | Snapshots to keep after a successful apply (default 5) |
| `OMP_SYNC_RELINK_EXT` | Colon-separated local plugin directories passed to `omp plugin link` after a successful apply. Missing paths are skipped; link failures are warnings and do **not** roll back. A `~/` prefix is treated as a literal tilde (not expanded by the matcher) and then replaced with `$HOME`. |
| `OMP_SYNC_SMOKE_CMD` | Shell command run after a successful `omp update`. Non-zero exit restores the previous binary. Keep this generic (for example `omp --version` or your own health check). |

`OMP_SYNC_RELINK_EXT` is for **your** local plugins. It is not a place to
hard-wire project-specific overlays.

Example:

```sh
export OMP_SYNC_SMOKE_CMD='omp --version'
export OMP_SYNC_RELINK_EXT="$HOME/src/my-omp-plugin"
./contrib/omp-sync/omp-sync.sh --apply
```

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Success, or already up to date |
| 1 | Usage error |
| 2 | Network / registry failure; binary unchanged (apply restores the snapshot if the updater had started) |
| 3 | Apply failed; previous binary restored when a snapshot existed |
| 4 | Rollback failed |
| 5 | Another omp-sync holds the lock |
| 6 | `omp` executable not found |
| 7 | Snapshot I/O error |

## What this is not

- Not a replacement for `omp update`.
- Not an auto-updater service or launchd plist.
- Not a plugin or skill pack.
- Not Windows-oriented (`flock` / POSIX `sh` / Unix launchers).

Official update behavior, channels, and install methods remain documented on
`omp update --help` and in [Safe binary update](../../docs/safe-binary-update.md).

## Tests

The wrapper is covered by a fake-`omp` contract script (no network, no real
install). It checks snapshot/rollback, network fail-soft (including apply),
smoke-command restore, snapshot prune, incomplete-snapshot rejection, and that
user config is never deleted:

```sh
sh contrib/omp-sync/omp-sync.test.sh
```
