# Changelog

## [Unreleased]

### Fixed

- Windows `/dev/null` redirections and `test -e /dev/null` now use the null device, so stdout and stderr redirects discard their output and the path exists.
