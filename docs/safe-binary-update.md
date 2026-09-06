# Safe binary update

Official updates are `omp update` and `omp update --check`. Those commands
detect the active install (standalone binary, bun, npm, Homebrew, mise, Nix)
and install the selected channel. See `omp update --help` and the `update`
row in the [CLI reference](./cli-reference.md).

This repository also ships an **optional** contrib wrapper that adds
snapshot/rollback around that same CLI. It does not change core update
behavior:

- [`contrib/omp-sync/omp-sync.sh`](../contrib/omp-sync/omp-sync.sh) — portable
  fail-soft wrapper (`--check`, `--apply`, `--rollback`, `--list`)
- [`contrib/omp-sync/README.md`](../contrib/omp-sync/README.md) — usage, exit
  codes, snapshot location, and safety guarantees

Use the wrapper when you want a copy of the previous launcher kept under
`~/.omp/sync/` (or `$OMP_HOME/sync`) and restored if `omp update` or an
optional smoke command fails. User config is never deleted by the wrapper.
