---
title: Quickstart
description: Go from install to your first agent session in a few minutes.
coverage: B
---

This page is the shortest path from a fresh install to a working session. Three steps: install, connect a model provider, send a prompt. See the [Installation page](/oh-my-pi/getting-started/installation/) for every install method, and the [CLI reference](/oh-my-pi/reference/cli/) for the full flag set.

## 1. Install omp

The one-liner is fine for most desktops:

```bash
curl -fsSL https://omp.sh/install | sh
```

Other install methods (Homebrew, Bun, Windows PowerShell, pinned via mise) are on the [Installation page](/oh-my-pi/getting-started/installation/). Confirm the binary is reachable:

```bash
omp --version
```

## 2. Connect a model provider

omp ships wired for 40+ providers, but a fresh install still needs to know which one to call. Pick the path that matches your provider.

**Run the onboarding wizard.** `omp setup` walks you through initial configuration, including a step to pick the model that will be the default for new sessions:

```bash
omp setup
```

**Sign in to a subscription coding plan or oauth provider.** Inside a session, `/login` attaches the session to a subscription coding plan. Providers tagged `oauth` sign in with your provider account.

**Set an API key in the environment.** For direct API access, export the matching variable before launching `omp`. Common keys (from `omp --help`):

| Variable              | Provider                |
| --------------------- | ----------------------- |
| `ANTHROPIC_API_KEY`   | Anthropic Claude        |
| `OPENAI_API_KEY`      | OpenAI                  |
| `GEMINI_API_KEY`      | Google Gemini           |
| `XAI_API_KEY`         | xAI Grok                |
| `OPENROUTER_API_KEY`  | OpenRouter              |
| `GROQ_API_KEY`        | Groq                    |
| `MISTRAL_API_KEY`     | Mistral                 |

A `COPILOT_GITHUB_TOKEN` covers GitHub Copilot; the full provider list is in [Providers](/oh-my-pi/models/providers/).

**Self-hosted or custom endpoints.** Anything speaking the OpenAI, Anthropic, Google, or Vertex APIs can be declared in `~/.omp/agent/models.yml`; local instances can skip the key entirely. Verify a custom provider is discovered with `omp models <provider>`, then choose it in the `omp setup` default-model step or assign it to a role in a session with `/model`.

:::tip
On first run, omp imports rules, skills, and MCP servers it finds on disk under `.claude`, `.cursor`, `.windsurf`, `.gemini`, `.codex`, `.cline`, `.github/copilot`, and `.vscode`. If you've used another agent in this project, that config is in effect before you type anything.
:::

## 3. Send your first prompt

Launch the TUI in the project you want to work on:

```bash
cd your-project
omp
```

Type a prompt and press Enter. Tool calls render as cards, edits preview before they land, and ambiguous decisions surface as an option picker.

**One-shot mode.** If you only need a single answer and don't want the TUI, pass the prompt to `omp -p` and the answer is printed to stdout:

```bash
omp -p "list .ts files"
```

**Pass the prompt on the command line.** Anything after the flags that isn't recognized as a flag is treated as the initial prompt for the TUI, so:

```bash
omp "summarize this repository"
```

opens the TUI and starts a turn with that prompt.

## Where to go next

- [Your first session](/oh-my-pi/getting-started/first-session/) — the keyboard shortcuts, model cycling, and how to resume.
- [Model roles](/oh-my-pi/models/model-roles/) — `default`, `smol`, `slow`, and `plan` routes and the role flags.
- [CLI reference](/oh-my-pi/reference/cli/) — every launch flag.
