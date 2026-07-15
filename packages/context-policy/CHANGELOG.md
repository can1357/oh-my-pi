# Changelog

## [Unreleased]

### Added

- Added opt-in capture admission and default retention policy primitives for persistent context.
- Added a canonical remote-prefix mapping (`remotePrefixForCategory`, `staticallyExpiringCategories`) with a contract test that keeps the S3 lifecycle template in lockstep with the retention policy.
