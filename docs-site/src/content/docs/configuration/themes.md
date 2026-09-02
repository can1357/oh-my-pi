---
title: Themes
description: Built-in themes and authoring your own.
coverage: A
---

A theme is a JSON file that drives omp's color tokens, symbol preset, and a few export colors used when rendering HTML. omp ships with built-in themes and looks in a custom-themes directory for any additional files you want to use.

## Selecting a theme

Open the settings UI (`/settings` or its keybinding) and pick a theme under **Appearance**. Themes occupy two slots:

- `theme.dark` — applied when omp detects a dark terminal.
- `theme.light` — applied when omp detects a light terminal.

The auto-detection order, used on startup and re-evaluated on `SIGWINCH`:

1. Terminal-reported OSC 11 background luminance, unless the macOS/Zellij fallback path is active.
2. `COLORFGBG` background index (`< 8` ⇒ dark, `>= 8` ⇒ light).
3. The macOS appearance fallback, only for the known-broken macOS/Zellij OSC 11 path.
4. The dark slot as the final fallback.

Persisted defaults from the settings schema:

| Setting | Default |
| --- | --- |
| `theme.dark` | `titanium` |
| `theme.light` | `light` |
| `symbolPreset` | `unicode` |
| `colorBlindMode` | `false` |

The Settings UI also exposes a live preview — it calls `previewTheme` (which does not persist) and restores the prior theme on cancel. `setTheme` failures fall back to the built-in `dark` theme and report `{ success: false, error }`; `previewTheme` failures report the error without swapping in a fallback.

## Where themes live

`getAvailableThemes()` returns the merged set of built-in and custom names, sorted. Built-in names take precedence on collision.

```text
Built-ins      dark.json, light.json, and every defaults/*.json compiled into the bundle
Custom         <customThemesDir>/<name>.json
```

The custom themes directory is `~/.omp/agent/themes` by default, or `$PI_CODING_AGENT_DIR/themes` when `PI_CODING_AGENT_DIR` is set (see [Environment Variables](/oh-my-pi/configuration/environment-variables/)).

## Theme file format

A theme file is a JSON object. The runtime schema (`themeJsonSchema` in the source) is the source of truth; `$schema` in the JSON is informational and is not consumed by the validator.

Top-level fields:

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | Display name of the theme |
| `colors` | yes | Every token listed in [Required color tokens](#required-color-tokens) must be present |
| `vars` | no | Named color variables reused inside `colors` |
| `export` | no | HTML export colors (`pageBg`, `cardBg`, `infoBg`) |
| `symbols` | no | Symbol preset and per-key overrides (see [Symbols](#symbols) and [Box-drawing borders](#box-drawing-borders)) |

Color values accept any of:

- A hex string (`"#RRGGBB"`).
- A 256-color index (`0`..`255`).
- A variable reference string (resolved through `vars`).
- An empty string (`""`), meaning the terminal default (`\x1b[39m` foreground, `\x1b[49m` background).

Validation behavior:

- Missing required tokens → explicit grouped error message.
- Bad token types/values → validation errors with JSON path.
- Unknown theme name (when switching) → `Theme not found: <name>`.

`vars` supports nested references and throws on missing or circular references.

## Required color tokens

All tokens below are required inside `colors`.

### Core text and borders (11)

`accent`, `border`, `borderAccent`, `borderMuted`, `success`, `error`, `warning`, `muted`, `dim`, `text`, `thinkingText`

### Background blocks (7)

`selectedBg`, `userMessageBg`, `customMessageBg`, `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `statusLineBg`

### Message and tool text (5)

`userMessageText`, `customMessageText`, `customMessageLabel`, `toolTitle`, `toolOutput`

### Markdown (10)

`mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet`

### Tool diff and syntax highlighting (12)

`toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`, `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation`

### Mode and thinking borders (8)

`thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh`, `bashMode`, `pythonMode`

### Status line segment colors (13)

`statusLineSep`, `statusLineModel`, `statusLinePath`, `statusLineGitClean`, `statusLineGitDirty`, `statusLineContext`, `statusLineSpend`, `statusLineStaged`, `statusLineDirty`, `statusLineUntracked`, `statusLineOutput`, `statusLineCost`, `statusLineSubagents`

## Optional sections

### `export`

Used by the HTML export helpers: `export.pageBg`, `export.cardBg`, `export.infoBg`. If omitted, the export code derives defaults from the resolved theme colors.

### `symbols`

- `symbols.preset` sets a theme-level default symbol set (`unicode`, `nerd`, or `ascii`).
- `symbols.overrides` can override individual `SymbolKey` values. Invalid override keys are ignored and logged at `debug` level.
- `symbols.spinnerFrames` overrides the loading spinner frames. Accepts either a flat `string[]` (applied to both spinner types) or an object `{ "status"?: string[], "activity"?: string[] }` to override each type independently. Any type not specified falls back to the symbol preset's default frames. `status` drives the ~12.5fps spinner used by loaders and tool-execution indicators; `activity` drives the ~30fps spinner used by markdown progress bars and similar high-frequency UI.

Symbol preset runtime precedence: `symbolPreset` setting override (if set) → `symbols.preset` in the theme JSON → `"unicode"` fallback.

### Box-drawing borders

All outlined chrome — tool-result frames, overlays, code fences, the editor, the welcome banner — draws with the `boxRound.*` tokens: rounded corners (`╭╮╰╯`) plus tee/cross junctions (`├┤┬┴┼`, which have no rounded Unicode form, so they are sourced from the `boxSharp.*` tokens). Markdown tables are the sole exception and keep the fully sharp `boxSharp.*` set (`┌┐└┘`).

Override behavior follows from that split:

- `boxRound.{topLeft,topRight,bottomLeft,bottomRight,horizontal,vertical}` restyle every border's corners and edges.
- `boxSharp.{cross,teeDown,teeUp,teeRight,teeLeft}` restyle dividers and junctions everywhere (rounded frames and tables alike).
- `boxSharp.{topLeft,topRight,bottomLeft,bottomRight}` affect markdown table corners only.

## Live reload and color mode

When the watcher is enabled (interactive init or `setTheme(..., true)`), omp watches `<customThemesDir>/<currentTheme>.json` only when that file exists. Built-ins are not watched and also take precedence over same-name custom files. Matching file changes schedule a debounced reload; reload errors or temporary file absence keep the last successfully loaded theme — the watcher does not perform a delete/rename fallback.

Color mode detection:

- `COLORTERM=truecolor|24bit` ⇒ truecolor.
- `WT_SESSION` ⇒ truecolor.
- `TERM` in `dumb`, `linux`, or empty ⇒ 256color.
- Otherwise ⇒ truecolor.

Hex values convert via `Bun.color(..., "ansi-16m" | "ansi-256")`; numeric values become `38;5` / `48;5` ANSI; `""` resets to the default foreground/background.

`colorBlindMode` changes only one token at runtime: `toolDiffAdded` is HSV-adjusted (green shifted toward blue), and only when the resolved value is a hex string. Every other token is unchanged.

## Authoring a custom theme

1. Create the file in the custom themes directory, e.g. `~/.omp/agent/themes/my-theme.json`.
2. Include `name`, optional `vars`, and every required `colors` token.
3. Optionally add `symbols` and `export`.
4. Select the theme in Settings under **Appearance → Dark Theme** or **Appearance → Light Theme** depending on which auto slot you want it to fill.

Minimal skeleton:

```json
{
  "name": "my-theme",
  "vars": {
    "accent": "#7aa2f7",
    "muted": 244
  },
  "colors": {
    "accent": "accent",
    "border": "#4c566a",
    "borderAccent": "accent",
    "borderMuted": "muted",
    "success": "#9ece6a",
    "error": "#f7768e",
    "warning": "#e0af68",
    "muted": "muted",
    "dim": 240,
    "text": "",
    "thinkingText": "muted",

    "selectedBg": "#2a2f45",
    "userMessageBg": "#1f2335",
    "userMessageText": "",
    "customMessageBg": "#24283b",
    "customMessageText": "",
    "customMessageLabel": "accent",
    "toolPendingBg": "#1f2335",
    "toolSuccessBg": "#1f2d2a",
    "toolErrorBg": "#2d1f2a",
    "toolTitle": "",
    "toolOutput": "muted",

    "mdHeading": "accent",
    "mdLink": "accent",
    "mdLinkUrl": "muted",
    "mdCode": "#c0caf5",
    "mdCodeBlock": "#c0caf5",
    "mdCodeBlockBorder": "muted",
    "mdQuote": "muted",
    "mdQuoteBorder": "muted",
    "mdHr": "muted",
    "mdListBullet": "accent",

    "toolDiffAdded": "#9ece6a",
    "toolDiffRemoved": "#f7768e",
    "toolDiffContext": "muted",

    "syntaxComment": "#565f89",
    "syntaxKeyword": "#bb9af7",
    "syntaxFunction": "#7aa2f7",
    "syntaxVariable": "#c0caf5",
    "syntaxString": "#9ece6a",
    "syntaxNumber": "#ff9e64",
    "syntaxType": "#2ac3de",
    "syntaxOperator": "#89ddff",
    "syntaxPunctuation": "#9aa5ce",

    "thinkingOff": 240,
    "thinkingMinimal": 244,
    "thinkingLow": "#7aa2f7",
    "thinkingMedium": "#2ac3de",
    "thinkingHigh": "#bb9af7",
    "thinkingXhigh": "#f7768e",

    "bashMode": "#2ac3de",
    "pythonMode": "#bb9af7",

    "statusLineBg": "#16161e",
    "statusLineSep": 240,
    "statusLineModel": "#bb9af7",
    "statusLinePath": "#7aa2f7",
    "statusLineGitClean": "#9ece6a",
    "statusLineGitDirty": "#e0af68",
    "statusLineContext": "#2ac3de",
    "statusLineSpend": "#7dcfff",
    "statusLineStaged": "#9ece6a",
    "statusLineDirty": "#e0af68",
    "statusLineUntracked": "#f7768e",
    "statusLineOutput": "#c0caf5",
    "statusLineCost": "#ff9e64",
    "statusLineSubagents": "#bb9af7"
  }
}
```

## Testing a custom theme

1. Start interactive mode (the watcher is enabled from startup).
2. Open settings and preview theme values (live `previewTheme`).
3. Edit the JSON while running and confirm the auto-reload on save.
4. Exercise the critical surfaces:
   - markdown rendering
   - tool blocks (pending / success / error)
   - diff rendering (added / removed / context)
   - status line readability
   - thinking level border changes
   - bash / python mode border colors
5. Validate both symbol presets if your theme depends on glyph width or appearance.

## Caveats

- All `colors` tokens are required for custom themes; `export` and `symbols` are optional.
- `setTheme` failure falls back to `dark`; `previewTheme` failure does not replace the current theme.
- File-watcher reload errors or temporary missing files keep the current loaded theme until a successful reload or explicit theme switch.
