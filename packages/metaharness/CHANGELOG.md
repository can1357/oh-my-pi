# Changelog

## [Unreleased]

### Changed

- Edit benchmark sessions now start no MCP servers in subprocess mode too (`--no-mcp`), matching the in-process mode; subprocess runs from before this change may have had the user's MCP tools available, so they are not comparable on tool set.
