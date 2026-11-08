# Changelog

## [Unreleased]

### Fixed

- Windows `/dev/null` redirections and `test -e /dev/null` now use the null device, so stdout and stderr redirects discard their output and the path exists. `test -r` and `test -w` succeed on that device too; `test -x` does not.
