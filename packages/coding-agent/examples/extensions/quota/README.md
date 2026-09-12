# OMP Quota Dashboard (`omp-quota`)

An interactive, theme-aware quota dashboard extension for [Oh My Pi (OMP)](https://omp.sh).

Provides the `/quota` slash command to inspect your remaining rate limits and quota windows across all authenticated providers, accounts, and model pools in an attention-first, collapsible TUI interface.

```text
QUOTA                                                                      refreshed now
✓ 12 healthy   ⚠ 1 low   ✕ 2 exhausted

ATTENTION
──────────────────────────────────────────────────

⚠ Anthropic · alice@example.com · Claude 7 Day
  28%                                           ↻ 2d

✕ Google Antigravity · bob@example.com · Google · Weekly
  0%                                            ↻ 6d

✕ OpenAI Codex · carol@example.com · 7 days
  0%                                            ↻ 5d


ANTHROPIC                                                                      1 account
────────────────────────────────────────────────────
❯ ▾ ● alice@example.com                                                     ACTIVE
    Organization
    Claude 5 Hour           ███████████░   91%   ✓   ↻ 4h
    Claude 7 Day            ███░░░░░░░░░   28%   ⚠   ↻ 2d
    Claude 7 Day (Fable)    ████████████  100%   ✓

GOOGLE ANTIGRAVITY                                                            3 accounts
────────────────────────────────────────────────────
  ▾ bob@example.com
    ▾ Google
      Weekly                  ░░░░░░░░░░░░    0%   ✕   ↻ 6d
      Daily                   ████████████  100%   ✓
    ▾ OpenAI
      Weekly                  ████████████  100%   ✓   ↻ 7d
    ▾ Anthropic
      Weekly                  ████████████  100%   ✓   ↻ 7d

  ▸ dave@example.com                                                   all healthy

  ▸ erin@example.com                                                  all healthy

OPENAI CODEX                                                                   1 account
────────────────────────────────────────────────────
  ▾ carol@example.com                                                          PLUS
    7 days                  ░░░░░░░░░░░░    0%   ✕   ↻ 5d

↑↓ navigate   enter expand   a attention   h healthy   r refresh   q close
```

---

## Installation

### Option 1: Direct Extension Install (Recommended)

Clone directly into your OMP extensions directory:

```bash
git clone https://github.com/osamam-eid/omp-quota.git ~/.omp/agent/extensions/quota
```

Start or restart `omp`, then type `/quota`.

### Option 2: Via npm (when published to npm registry)

```bash
omp plugin install omp-quota
```

---

## Usage

### Interactive Dashboard
```text
/quota
```
Launches the full-screen interactive TUI dashboard.

#### Keyboard Controls
| Key | Action |
| --- | --- |
| `↑` / `↓` / `k` / `j` | Navigate selectable accounts and pools |
| `Enter` | Expand / collapse selected account or pool |
| `a` | Toggle **Attention-only mode** (filter out all healthy accounts) |
| `h` | Toggle **Hide/Show healthy quotas** |
| `r` | Live re-fetch from OMP's `AuthStorage` |
| `q` / `Esc` | Close dashboard and return to prompt |

### Snapshot Mode (Text Transcript)
```text
/quota snapshot
```
Prints a compact, non-interactive plain-text quota summary directly into your chat transcript. This mode is also used automatically as a headless fallback when running in non-interactive environments.

---

## Key Features

* **Account-First Hierarchy**: Clean `Provider → Account → Pool → Window` nesting. Accounts never get mixed horizontally across columns.
* **Remaining Quota Semantics**: Bars and percentages represent **remaining capacity** (not used capacity), with filled cells indicating available quota.
* **4-Tier Health Palette**:
  * `51–100%`: **Healthy** (`✓`, theme success color)
  * `21–50%`: **Low** (`⚠`, theme warning color)
  * `1–20%`: **Critical** (`!`, theme error color)
  * `0%` / Exhausted: **Exhausted** (`✕`, theme error color / empty bar)
  * Unknown: `?` with dotted placeholder
* **Attention Section**: Surfaces low, critical, and exhausted quotas at the top of the dashboard for instant triage. Automatically omitted when everything is healthy.
* **Google Antigravity Multi-Pool Support**: Preserves independent `Google`, `Anthropic`, and `OpenAI` backend quota pools per account.
* **Clean Organization Formatting**: Eliminates redundant metadata like `user@example.com's Organization` while preserving real team/workspace names.
* **Zero Core Modifications**: Pure standalone runtime extension using OMP's built-in `AuthStorage` and `UsageReport` APIs.

---

## Development & Testing

Run the test suite with [Bun](https://bun.sh):

```bash
bun test
```

All 29 unit tests run standalone with zero external runtime dependencies.

---

## License

[MIT](LICENSE) © Osama Eid
