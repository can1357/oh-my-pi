# Changelog

## [Unreleased]

### Fixed

- Windows `/dev/null` redirections and `test -e /dev/null` now use the null device, so stdout and stderr redirects discard their output and the path exists. `test -r` and `test -w` succeed on that device too; `test -x` does not.
- Windows `cat`, `head`, and `ls` now treat `/dev/null` as the null device, through one shared `pi-vfs` predicate (`pi-vfs` gained `windows_null_device` plus null-device `metadata`/`access`; `pi-builtins` maps the exact spelling to `NUL`): `cat`/`head` print nothing and exit 0, `ls` lists `/dev/null` and exits 0.
