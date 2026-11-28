# Changelog

## [Unreleased]

### Fixed

- Fixed direct-auth runs (`--no-gateway`) for `github-copilot` models by forwarding `COPILOT_GITHUB_TOKEN` instead of `GITHUB_TOKEN`, and forwarding only the active credential alias without overriding explicit `--env` tokens ([#20624](https://github.com/can1357/oh-my-pi/pull/20624) by [@eggpeat](https://github.com/eggpeat))
