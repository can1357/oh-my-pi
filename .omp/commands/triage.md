# Triage Command

Classify/label newly opened GitHub issues missing labels.

## Arguments

`$ARGUMENTS`: optional `--days <n>`; default `7`. Triage only open issues created within this window.

## Steps

### 1. Fetch

Parse `$ARGUMENTS` for `--days` (default `7`).

```bash
# Build cutoff date (UTC) for "new" issues
CUTOFF_DATE="$(python - <<'PY'
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc) - timedelta(days=7)).strftime('%Y-%m-%d'))
PY
 )"

# Fetch only newly created open issues (default 7-day window)
gh issue list --state open --search "created:>=${CUTOFF_DATE}" --json number,title,body,labels,comments,createdAt --limit 50
```

### 2. Candidates

Skip issues older than cutoff or labeled `triaged`. Of the rest, skip only if all applicable requirements hold:
- Exactly one primary: `bug`|`enhancement`|`question`|`proposal`|`documentation`|`invalid`|`duplicate`.
- `bug` → exactly one `prio:*`.
- Applicable functional scope → at least one: `agent`|`tool`|`tui`|`cli`|`prompting`|`sdk`|`auth`|`setup`|`ux`|`providers`.
- Provider-specific → matching `provider:*`; platform-specific → matching `platform:*`.

### 3. Classification

For every candidate, read title, body, and all comments; comments may contain critical context. Labels below; primary exactly one, priority exactly one only for `bug`, functional all applicable. Provider/platform labels require explicit issue evidence.

**Primary**
- `bug`: broken existing behavior—crash, error, regression, "doesn't work".
- `enhancement`: feature request/improvement to existing behavior.
- `question`: how-to, clarification, usage question.
- `proposal`: design/process proposal needing maintainer decision.
- `documentation`: missing, incorrect, outdated docs.
- `invalid`: spam, off-topic, not actionable.
- `duplicate`: clear duplicate; reference original in a comment.

**Bug priority**
- `prio:p0`: critical blocker, data loss/security breakage, unusable workflow.
- `prio:p1`: high impact, common workflow broken, fix soon.
- `prio:p2`: medium impact, workaround exists, not blocking most users.
- `prio:p3`: low impact, edge case/minor issue.

**Functional**
- `agent`: planning/execution loops, orchestration, runtime behavior.
- `tool`: contracts/behavior, call protocol, integration errors.
- `tui`: terminal UI rendering/layout/input/view state.
- `cli`: commands, args/flags, routing.
- `prompting`: system prompts/templates/assembly behavior.
- `sdk`: SDK/extension integration APIs/surfaces.
- `auth`: login, credentials, API keys, token/account management.
- `setup`: installation/bootstrap/environment setup.
- `ux`: non-rendering workflow/ergonomics/usability improvements.
- `providers`: generic provider-related behavior.

**Providers** — specific provider explicitly involved only:
`provider:anthropic`, `provider:bedrock`, `provider:brave`, `provider:cerebras`, `provider:cloudflare`, `provider:codex`, `provider:copilot`, `provider:cursor`, `provider:exa`, `provider:gemini`, `provider:gitlab`, `provider:groq`, `provider:huggingface`, `provider:jina`, `provider:kimi`, `provider:litellm`, `provider:minimax`, `provider:mistral`, `provider:moonshot`, `provider:nanogpt`, `provider:novita`, `provider:nvidia`, `provider:openai`, `provider:opencode`, `provider:openrouter`, `provider:perplexity`, `provider:qianfan`, `provider:qwen`, `provider:synthetic`, `provider:together`, `provider:venice`, `provider:vercel`, `provider:xai`, `provider:xiaomi`, `provider:zai`.

**Platforms** — only if material to reproduction/root cause:
- `platform:linux`: Linux-specific behavior, distro/toolchain difference, Linux-only reproduction.
- `platform:macos`: macOS-specific, including Homebrew/Darwin-specific.
- `platform:windows`: native Windows, including PowerShell/cmd/Win32 specifics.
- `platform:wsl`: WSL-specific; do not also apply linux/windows unless separately confirmed.

**Meta** — manual judgment only:
- `good first issue`: well-scoped, self-contained, suitable for new contributors.
- `help wanted`: maintainers want community help.
- `wontfix`: intentional behavior or explicitly out of scope.

### 4. Apply

Apply chosen labels; NEVER remove existing labels. Provider/platform labels require explicit evidence from body/comments.

```bash
gh issue edit <number> --add-label "bug,prio:p1,tool,providers,provider:openai"
```

### 5. Summary

After all issues, print:

```
## Triage Summary

|#|Title|Added Labels|Skipped|
|---|---|---|---|
|42|Tool call stalls after retry|bug, prio:p1, agent, tool||
|38|Add provider fallback routing|proposal, providers, provider:exa||
|35|How to configure API key rotation|question, auth, providers, provider:minimax||
|30|Existing labels complete||Already labeled|
```

Then: `Processed: X | Labeled: Y | Skipped: Z`

## Rules

- `platform:*`: only explicit platform-specific or platform-bound reproduced behavior.
- `providers`/`provider:*`: only explicit provider scope. Named provider → both `providers` and matching `provider:*`.
- WSL → `platform:wsl`, not `platform:linux`/`platform:windows` unless separately confirmed.
- Automated triage: do not apply `good first issue` or `help wanted`; maintainer judgment required.
- Sparse body → classify from all comments; do not skip before reading them.
