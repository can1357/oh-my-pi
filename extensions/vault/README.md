# vault — note graph queries

Soft device `vault_query` reads a configured vault through the host
`vault://` resolver. The scan, symlink confinement, and JSON result live in
`omp-envd`. This package only builds the URL and returns the host document.

`sv_vault_enabled` must be on, and the vault must be listed in `vaults.toml`.
These queries do not start the Obsidian CLI.

## Surface

- Device `vault_query` (family `vault`, rev 1, read tier)
- Arguments: `vault`, `op` (`info`, `section`, `backlinks`, `tag`, `map`),
  `path`, `heading`, `tag`
- Pure helper: `omp_vault.query.build_vault_url`

## How to test

```sh
PYTHONPATH=extensions/vault/src python3 -m unittest discover -s extensions/vault/tests -v
```
