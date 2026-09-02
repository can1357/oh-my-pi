---
title: Settings — Interaction
description: Input, startup, notifications, collab, share, and speech-to-text behaviour.
coverage: A
sidebar:
  label: Settings — Interaction
  order: 5
---

Settings that control prompt input, queued messages, interrupts, startup, notifications, collaboration, sharing, and speech-to-text. For the workflow and the layered config model, see [Settings](/oh-my-pi/configuration/settings/). For the exhaustive schema, run `omp config list`.

## Interaction

| Key | Type | Default | Description |
|---|---|---|---|
| `steeringMode` | enum | `one-at-a-time` | One of `all`, `one-at-a-time`. How queued steering messages are delivered. |
| `followUpMode` | enum | `one-at-a-time` | One of `all`, `one-at-a-time`. |
| `interruptMode` | enum | `immediate` | One of `immediate`, `wait`. |
| `doubleEscapeAction` | enum | `tree` | One of `branch`, `tree`, `none`. |
| `autoResume` | boolean | `false` | Auto-resume the most recent session in the cwd. |
| `ask.timeout` | number | `0` | Seconds before an `ask` prompt times out; `0` = no timeout. (Legacy ms values are migrated to seconds.) |
| `ask.notify` | enum | `on` | One of `on`, `off`. |
| `loop.mode` | enum | `prompt` | One of `prompt`, `compact`, `reset`. What happens between `/loop` iterations before re-submitting the prompt. |
| `treeFilterMode` | enum | `default` | One of `default`, `no-tools`, `user-only`, `labeled-only`, `all`. Default filter mode when opening the session tree. |
| `autocompleteMaxVisible` | number | `5` | Max visible items in the autocomplete dropdown (3-20). |
| `emojiAutocomplete` | boolean | `true` | Suggest emojis from `:name:` shortcodes and expand text emoticons like `:D` or `:-)`. |
| `paste.largeMenuThreshold` | number | `100` | When a paste reaches this many lines, offer a menu to wrap it in a code block, wrap it in XML tags, or save it to a file. `0` disables the menu (large pastes still collapse to a `[Paste]` marker). |

See [Loop mode](/oh-my-pi/modes/loop-mode/) for what the loop mode setting controls between `/loop` iterations.

## Startup and updates

| Key | Type | Default | Description |
|---|---|---|---|
| `startup.quiet` | boolean | `false` | Skip the welcome screen and startup status messages. |
| `startup.showSplash` | boolean | `false` | Show the full animated setup splash on normal interactive startup without rerunning setup; `startup.quiet` still suppresses it. |
| `startup.setupWizard` | boolean | `true` | Show newly added onboarding steps once per setup version. |
| `startup.checkUpdate` | boolean | `true` | Check for omp updates on startup. |
| `startup.changelogMode` | enum | `summary` | One of `summary`, `expanded`, `hidden`. Whether update notes start as a summary, full details, or stay hidden. |
| `marketplace.autoUpdate` | enum | `notify` | One of `off`, `notify`, `auto`. Check for plugin updates on startup: don't check, notify when updates are available, or auto-install them. |

## Magic keywords

| Key | Type | Default | Description |
|---|---|---|---|
| `magicKeywords.enabled` | boolean | `true` | Enable hidden notices for standalone `ultrathink`, `orchestrate`, and `workflowz` keywords. |
| `magicKeywords.ultrathink` | boolean | `true` | Let standalone `ultrathink` request maximum automatic thinking and append its hidden notice. |
| `magicKeywords.orchestrate` | boolean | `true` | Let standalone `orchestrate` append its hidden multi-agent orchestration notice. |
| `magicKeywords.workflow` | boolean | `true` | Let standalone `workflowz` append its hidden eval workflow notice. |

See [Magic keywords](/oh-my-pi/features/magic-keywords/) for the standalone keywords and their effects.

## Notifications

| Key | Type | Default | Description |
|---|---|---|---|
| `completion.notify` | enum | `on` | One of `on`, `off`. Notify when the agent finishes a turn. |
| `error.notify` | enum | `off` | One of `on`, `off`. Notify when the agent stops with an error. |
| `recap.enabled` | boolean | `true` | Generate a brief LLM recap of where things stand after the terminal has been idle. |
| `recap.idleSeconds` | number | `240` | Seconds to wait while idle before showing the recap. |

## Collab

| Key | Type | Default | Description |
|---|---|---|---|
| `collab.relayUrl` | string | `wss://my.omp.sh` | Relay used by `/collab` (`wss://host[:port]`). |
| `collab.webUrl` | string | `` | Browser UI used by `/collab` links; empty derives from `collab.relayUrl`, and an explicit `http://` is localhost-only. |
| `collab.displayName` | string | `` | Name shown to other collab participants (default: OS username). |

See [Collab](/oh-my-pi/features/collab/) for shared-session collaboration.

## Share

| Key | Type | Default | Description |
|---|---|---|---|
| `share.serverUrl` | string | `https://my.omp.sh/s` | Share viewer/upload base used by `/share` (encrypted blob upload + viewer; links are `<base>/<id>#<key>`). |
| `share.store` | enum | `blob` | One of `blob`, `gist`. Where `/share` uploads the encrypted session blob: the share server, or a secret GitHub gist (falling back to the share server). |
| `share.redactSecrets` | boolean | `true` | Run the secret obfuscator over `/share` snapshots before upload (uses the `secrets.*` config). |

See [Sessions](/oh-my-pi/features/sessions/) for how shared session links work.

## Speech-to-text

| Key | Type | Default | Description |
|---|---|---|---|
| `stt.enabled` | boolean | `false` | Enable speech-to-text input via microphone. |
| `stt.language` | string | `en` | Language code used as the source-language hint for speech recognition; auto-detected when omitted. |
| `stt.modelName` | enum | `parakeet` | One of `fast`, `balanced`, `turbo`, `parakeet`. Local on-device speech model: Parakeet TDT v3 (sherpa-onnx) is the default; Whisper base/small/large-v3-turbo tiers (transformers.js) trade size for multilingual coverage. Downloaded on first use. |
| `stt.submitTrigger` | enum | `never` | One of `never`, `release`, `release-complete`, `say-submit`. When speech dictation automatically submits: never, release (2+ words), release with complete sentence, or when you say "submit". |

See [Voice](/oh-my-pi/features/voice/) for enabling and using speech-to-text.
