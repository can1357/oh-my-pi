# Triage Command

Classify and label **newly opened** GitHub issues that are missing labels.

## Arguments

- `$ARGUMENTS`: Optional window flag `--days <n>` (default: `7`). Only open issues created within this window are triaged.

## Steps

### 1. Fetch Issues

Parse `$ARGUMENTS` to determine the new-issue window (`--days`, default `7`).

```bash
# Build cutoff date (UTC) for "new" issues
CUTOFF_DATE="$(python - <<'PY'
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc) - timedelta(days=7)).strftime('%Y-%m-%d'))
PY
 )"

# Fetch only newly created open issues (default 7-day window)
gh issue list --state open --search "created:>=${CUTOFF_DATE}" --json number,title,body,labels,comments,createdAt --limit 50

### 2. Filter New Candidates

- Skip any issue older than the cutoff window; this command only triages new issues.
- Skip issues with label `triaged` (already handled).
- For remaining issues, skip only when all required labels are already present:
  - Exactly one primary label present (`bug`/`enhancement`/`question`/`proposal`/`documentation`/`invalid`/`duplicate`)
  - If primary label is `bug`, exactly one `prio:*` label present
  - At least one functional label present when applicable (`agent`/`tool`/`tui`/`cli`/`prompting`/`sdk`/`auth`/`setup`/`ux`/`providers`)
  - If provider-specific, at least one matching `provider:*` label present
  - If platform-specific, at least one matching `platform:*` label present

### 3. Classify Each Issue

For each candidate issue, read the title, body, and **all comments** (comments often contain critical context). Apply labels from the categories below. Do not auto-apply provider/platform labels unless explicitly indicated by issue evidence.

**Primary labels** (pick exactly one):
| Label | Signals |
|---|---|
| `bug` | Existing behavior is broken: crashes, errors, regressions, "doesn't work" |
| `enhancement` | Feature request or improvement to existing behavior |
| `question` | How-to, clarification, or usage question |
| `proposal` | Design/process proposal requiring maintainer decision |
| `documentation` | Docs are missing, incorrect, or outdated |
| `invalid` | Spam, off-topic, or not actionable |
| `duplicate` | Clear duplicate of another issue (reference original in a comment) |

**Priority labels** (required only for `bug`, pick exactly one):
| Label | Signals |
|---|---|
| `prio:p0` | Critical blocker, data loss/security breakage, unusable workflow |
| `prio:p1` | High impact, common workflow broken, should be fixed soon |
| `prio:p2` | Medium impact, workaround exists, not blocking most users |
| `prio:p3` | Low impact, edge case or minor issue |

**Functional labels** (pick all that apply):
| Label | Signals |
|---|---|
| `agent` | Agent planning/execution loops, orchestration, runtime behavior |
| `tool` | Tool contracts/behavior, tool call protocol, integration errors |
| `tui` | Terminal UI rendering/layout/input/view state |
| `cli` | CLI commands, args/flags, command routing |
| `prompting` | System prompts/templates/prompt assembly behavior |
| `sdk` | SDK or extension integration APIs/surfaces |
| `auth` | Login, credentials, API keys, token/account management |
| `setup` | Installation/bootstrap/environment setup issues |
| `ux` | Workflow/ergonomics/usability improvements (non-rendering) |
| `providers` | Provider-related behavior (generic provider scope) |

**Provider labels** (apply only when a specific provider is explicitly involved):
`provider:anthropic`, `provider:bedrock`, `provider:brave`, `provider:cerebras`, `provider:cloudflare`, `provider:codex`, `provider:copilot`, `provider:cursor`, `provider:exa`, `provider:gemini`, `provider:gitlab`, `provider:groq`, `provider:huggingface`, `provider:jina`, `provider:kimi`, `provider:litellm`, `provider:minimax`, `provider:mistral`, `provider:moonshot`, `provider:nanogpt`, `provider:nvidia`, `provider:openai`, `provider:opencode`, `provider:openrouter`, `provider:perplexity`, `provider:qianfan`, `provider:qwen`, `provider:synthetic`, `provider:together`, `provider:venice`, `provider:vercel`, `provider:xai`, `provider:xiaomi`, `provider:zai`

**Platform labels** (apply only when platform materially affects reproduction/root cause):
| Label | Signals |
|---|---|
| `platform:linux` | Linux-specific behavior, distro/toolchain differences, Linux-only reproduction |
| `platform:macos` | macOS-specific behavior (Homebrew/Darwin-specific) |
| `platform:windows` | Native Windows behavior (PowerShell/cmd/Win32 specifics) |
| `platform:wsl` | WSL-specific behavior (do not also apply linux/windows unless separately confirmed) |

**Meta labels** (manual judgment only):
| Label | Signals |
|---|---|
| `good first issue` | Well-scoped, self-contained, good for new contributors |
| `help wanted` | Maintainers want community help |
| `wontfix` | Intentional behavior or explicitly out of scope |

### 4. Apply Labels

For each issue, apply the chosen labels. **Never remove existing labels.**
Do not add provider or platform labels without explicit evidence from issue body/comments.

```bash
gh issue edit <number> --add-label "bug,prio:p1,tool,providers,provider:openai"
```

### 5. Print Summary

After processing all issues, print a markdown summary table:

```
## Triage Summary

| # | Title | Added Labels | Skipped |
|---|-------|-------------|---------|
| 42 | Tool call stalls after retry | bug, prio:p1, agent, tool | |
| 38 | Add provider fallback routing | proposal, providers, provider:exa | |
| 35 | How to configure API key rotation | question, auth, providers, provider:minimax | |
| 30 | Existing labels complete | | Already labeled |
```

Include counts at the end: `Processed: X | Labeled: Y | Skipped: Z`

## Classification Tips

- Do not apply `platform:*` unless platform-specific behavior is explicit or reproduced as platform-bound.
- Do not apply `providers` or any `provider:*` label unless provider scope is explicit.
- If a specific provider is named, add both `providers` and the matching `provider:*` label.
- WSL issues get `platform:wsl` — not `platform:linux` or `platform:windows` unless separately confirmed.
- Don't apply `good first issue` or `help wanted` during automated triage — those require maintainer judgment.
- If body is sparse, comments decide classification; do not skip before reading them all.