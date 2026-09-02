---
title: Installation
description: Install omp on macOS, Linux, or Windows, keep it updated, and set up shell completions.
coverage: A
---

omp is a coding agent that runs in your terminal. The same `omp` binary runs natively on macOS, Linux, and Windows — no WSL bridge on Windows. This page covers the install methods, updating, shell completions, and first-run setup.

## Requirements

- macOS, Linux, or Windows
- Bun 1.3.14 or newer

## Install with the setup script (macOS and Linux)

```bash
curl -fsSL https://omp.sh/install | sh
```

Verify the install:

```bash
omp --version
```

## Other install methods

**Homebrew**

```bash
brew install can1357/tap/omp
```

**Bun (recommended)**

```bash
bun install -g @oh-my-pi/pi-coding-agent
```

**Windows (PowerShell)**

```powershell
irm https://omp.sh/install.ps1 | iex
```

**Pinned versions (mise)**

```bash
mise use -g github:can1357/oh-my-pi
```

## Updating

`omp update` checks for and installs updates:

```bash
omp update          # check and install
omp update --check  # report without installing
```

| Flag           | Description                          |
| -------------- | ------------------------------------ |
| `-c, --check`  | Check for updates without installing |
| `-f, --force`  | Force update                         |
| `-l, --plugins` | Update installed plugins            |

:::note
If GitHub rate-limits release metadata during an update, set `GITHUB_TOKEN` or `GH_TOKEN` and retry.
:::

## Shell completions

`omp completions` prints a completion script for **bash**, **zsh**, or **fish**. The script is generated from the live command/flag metadata, so it never drifts from the actual CLI: subcommands, flags, and enum values complete statically, model names (`--model`, `--smol`, `--slow`, `--plan`) resolve against the bundled model catalog, and `--resume` completes against your on-disk sessions.

```bash
# zsh — add to ~/.zshrc (or write the output into a file on your $fpath)
eval "$(omp completions zsh)"

# bash — add to ~/.bashrc
eval "$(omp completions bash)"

# fish
omp completions fish > ~/.config/fish/completions/omp.fish
```

## Onboarding and optional dependencies

`omp setup` runs the onboarding wizard, which walks you through initial configuration including a default-model step:

```bash
omp setup
```

It can also install dependencies for optional features:

```bash
omp setup python   # required by the python code-execution tool
omp setup speech   # speech-to-text support
```

| Flag      | Description                        |
| --------- | ---------------------------------- |
| `--check` | Check if dependencies are installed |
| `--json`  | Output status as JSON              |

:::caution
`omp setup` requires an interactive terminal. Run it from a real TTY, not from a script or CI job.
:::

## First run: your existing config is inherited

On first run, omp inherits whatever is already on disk: rules, skills, and MCP servers from `.claude`, `.cursor`, `.windsurf`, `.gemini`, `.codex`, `.cline`, `.github/copilot`, and `.vscode`. There is no migration script — the config your team already wrote keeps working.

## Sharp edges

:::caution
`omp install <target>` does **not** install omp itself — it installs or links an extension package (an alias of `omp plugin install` / `omp plugin link`). Local paths (`./foo`, `/abs/foo`, `~/foo`) are symlinked into the plugin set; anything else (`pkg`, `pkg@1.2.3`, `name@marketplace`) is installed from a package source.
:::

Next: [Quickstart](/oh-my-pi/getting-started/quickstart/) to go from install to your first prompt, or the [CLI reference](/oh-my-pi/reference/cli/) for every flag.
