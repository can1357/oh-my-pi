# Changelog

## [Unreleased]

### Fixed

- Fixed direct-auth runs (`--no-gateway`) for `github-copilot` models by forwarding `COPILOT_GITHUB_TOKEN` instead of `GITHUB_TOKEN`, and forwarding only the active credential alias without overriding explicit `--env` tokens ([#N](https://github.com/can1357/oh-my-pi/pull/N) by [@eggpeat](https://github.com/eggpeat))
