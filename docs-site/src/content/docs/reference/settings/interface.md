---
title: Settings — Interface
description: Theme, display, status line, and terminal output.
coverage: A
sidebar:
  label: Settings — Interface
  order: 4
---

Settings that change the visual and interactive surface of the TUI. For the workflow and the layered config model, see [Settings](/oh-my-pi/configuration/settings/). For the exhaustive schema, run `omp config list`.

## Appearance and terminal

| Key | Type | Default | Description |
|---|---|---|---|
| `theme.dark` | string | `titanium` | Theme used on a dark terminal background. |
| `theme.light` | string | `light` | Theme used on a light terminal background. |
| `symbolPreset` | enum | `unicode` | One of `unicode`, `nerd`, `ascii`. |
| `colorBlindMode` | boolean | `false` | Use blue instead of green for diff additions. |
| `showHardwareCursor` | boolean | `true` | Show the terminal hardware cursor. |
| `statusLine.preset` | enum | `default` | One of `default`, `minimal`, `compact`, `full`, `nerd`, `ascii`, `custom`. |
| `statusLine.separator` | enum | `powerline-thin` | One of `powerline`, `powerline-thin`, `slash`, `pipe`, `block`, `none`, `ascii`. |
| `statusLine.sessionAccent` | boolean | `true` | Tint the editor border with the session color. |
| `statusLine.transparent` | boolean | `false` | Use the terminal background for the status line. |
| `statusLine.showHookStatus` | boolean | `true` | Show hook status messages. |
| `statusLine.compactThinkingLevel` | boolean | `false` | Show the thinking level as a single icon on the model name instead of a separate ` · <level>` suffix. |
| `terminal.showImages` | boolean | `true` | Render images inline (when the terminal supports it). |
| `images.autoResize` | boolean | `true` | Resize large images for model compatibility. |
| `images.blockImages` | boolean | `false` | Never send images to providers. |
| `images.describeForTextModels` | boolean | `true` | When an image is attached to a model without vision support, save it under `local://` and inject a description from a vision-capable model instead of dropping it. |
| `tui.hyperlinks` | enum | `auto` | One of `off`, `auto`, `always`. |

For a custom status line, set `statusLine.preset: custom` and configure `statusLine.leftSegments`, `statusLine.rightSegments`, and `statusLine.segmentOptions`. See [Themes](/oh-my-pi/configuration/themes/) for theme selection.

## Display

| Key | Type | Default | Description |
|---|---|---|---|
| `display.shimmer` | enum | `classic` | One of `classic`, `kitt`, `disabled`. Animation style for working/loading messages. |
| `display.smoothStreaming` | boolean | `true` | Reveal assistant text and streamed tool input smoothly while chunks arrive. |
| `display.hideToolActivity` | boolean | `false` | Hide model-initiated tool calls and results from the transcript. |
| `display.showTokenUsage` | boolean | `false` | Show per-turn token usage on assistant messages. |
| `display.cacheMissMarker` | boolean | `false` | Show a divider above an assistant turn whose request missed the prompt cache. |
| `display.collapseCompacted` | boolean | `true` | Collapse pre-compaction history behind the summary divider on the live transcript; disable to keep the full transcript inline with dividers at each compaction point. |
| `terminal.showProgress` | boolean | `false` | Emit OSC 9;4 indeterminate progress while the agent or context maintenance is running. |
| `tui.textSizing` | boolean | `false` | Render Markdown H1 headings at 2x scale using Kitty's OSC 66 text-sizing protocol; only takes effect on Kitty terminals. |
| `tui.renderMermaid` | boolean | `true` | Render Mermaid fenced code blocks as ASCII diagrams. |
| `tui.codexResetFireworks` | boolean | `false` | Celebrate unscheduled Codex weekly usage resets and newly banked saved resets with a top-third fireworks overlay that remains until Escape. |
| `tui.titleState` | boolean | `true` | Show the agent run state in the terminal title's separator: an animated spinner while working (a static `:` on Windows), `>` when it's your turn, `!` when the agent is waiting on you. |
| `tui.tight` | boolean | `false` | Remove the 1-character horizontal padding from the left and right of the terminal output. |
| `tui.scrollbackRebuild` | boolean | `false` | Erase and replay terminal scrollback when a block's final form replaces its live preview; when off, stale preview copies remain in history and the final content is appended below. |
| `tui.imeSafeCursor` | boolean | `false` | Move the prompt's bottom border to a separate row so macOS IME preedit cannot displace it. |

## Inline images

| Key | Type | Default | Description |
|---|---|---|---|
| `tui.maxInlineImageColumns` | number | `100` | Maximum width in terminal columns for inline images; `0` = unlimited (bounded only by terminal width). |
| `tui.maxInlineImageRows` | number | `20` | Maximum height in terminal rows for inline images; `0` = viewport-based limit only (60% of terminal height). |
| `tui.maxInlineImages` | number | `8` | Maximum number of inline images kept as live terminal graphics; older images fall back to a text placeholder once the limit is exceeded; `0` = no limit. |

