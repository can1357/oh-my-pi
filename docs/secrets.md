# Secret Obfuscation

Redacts sensitive values (API keys, tokens, passwords) in conversation messages sent to LLM providers. When enabled, configured secrets and built-in credential-shaped token patterns are replaced in supported message and replay text fields. Static system prompts, static tool definitions, and binary payloads are not redacted by this subsystem. Reversible placeholders are restored in model-authored tool arguments before execution and when local session context is rebuilt for display or resume.

## Enabling

Disabled by default. Toggle via `/settings` UI or directly in `config.yml`:

```yaml
secrets:
   enabled: true
```

## How it works

1. On session startup, secrets are collected from:
   - **Environment variables** whose names match common secret patterns (`KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASS`, `AUTH`, `CREDENTIAL`, `PRIVATE`, `OAUTH`) with values at least 8 characters long
   - **`secrets.yml` files** (see below)
   - Built-in reversible regexes for common credential shapes that appear only in session content or tool results: GitHub, GitLab, OpenAI, and Anthropic tokens, AWS access keys, Google API keys, Slack tokens, npm tokens, Stripe secret and restricted keys and webhook secrets, Hugging Face tokens, SendGrid keys, JWTs, Bearer header tokens, and PEM private key blocks
   - Passwords embedded in connection-URL environment values — any variable holding a `scheme://user:password@host`-style value (for example `DATABASE_URL`) has its password registered regardless of the variable name when it is at least 8 characters long. Both raw and percent-decoded forms are collected when they meet that limit.

2. Everything sent to the provider (messages of every role, native replay plaintext, compaction file lists) is encoded on its way out: matching values become deterministic placeholders such as `correctHorseStapleBattery` or `GitHubToken_correctHorseStapleBattery`, four or more camelCased words from a fixed list with an optional friendly-name prefix. Encoding is idempotent: regex rules never match inside a placeholder (configured literals are still found anywhere).

3. What the model writes from placeholders (assistant text, thinking, tool calls, and branch/compaction summaries) is stored as written and encodes to itself, so it replays byte-identical and thinking/tool-call signatures and prompt caches stay valid. Model output that still holds a value (written while redaction was off, or before the secret was configured) is encoded on replay, and the signature bound to the changed block is dropped. Placeholders are restored only where values are used or shown: before a tool executes, in the transcript display, and in exports. Replace-mode substitutions are one-way and are not restored.

Two modes control what happens to each secret:

| Mode                  | Behavior                                                                                      | Reversible |
| --------------------- | --------------------------------------------------------------------------------------------- | ---------- |
| `obfuscate` (default) | Replaced with a deterministic `words` or `FriendlyName_words` placeholder                     | Yes        |
| `replace`             | Replaced with the configured `replacement`, or a deterministic same-length value when omitted | No         |

Obfuscate-mode plain values and regex matches shorter than 8 characters are ignored to avoid redacting ordinary short words. Replace mode can handle short values; a replace-mode regex with no custom replacement is rejected only when every possible 1–2 character match would be impossible to redact to a distinct stable value.

## secrets.yml

Define custom secret entries in YAML. Two locations are checked:

| Level   | Path                                                                   | Purpose                                            |
| ------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| Global  | `<active-agent-dir>/secrets.yml` (normally `~/.omp/agent/secrets.yml`) | Secrets across projects using that agent directory |
| Project | `<cwd>/.omp/secrets.yml`                                               | Project-specific secrets                           |

Project entries override global entries with matching `content`. The global location follows the session's agent directory, including named profiles and explicit SDK agent-directory overrides.

### Schema

Each entry in the array has these fields:

| Field          | Type                         | Required | Description                                                   |
| -------------- | ---------------------------- | -------- | ------------------------------------------------------------- |
| `type`         | `"plain"` or `"regex"`       | Yes      | Match strategy                                                |
| `content`      | string                       | Yes      | The secret value (plain) or regex pattern (regex)             |
| `mode`         | `"obfuscate"` or `"replace"` | No       | Default: `"obfuscate"`                                        |
| `replacement`  | string                       | No       | Custom replacement (replace mode only)                        |
| `flags`        | string                       | No       | Regex flags (regex type only)                                 |
| `friendlyName` | string                       | No       | Sanitized model-visible label for obfuscate-mode placeholders |

### Examples

#### Plain secrets

```yaml
# Obfuscate a specific API key (default mode)
- type: plain
  content: sk-proj-abc123def456

# Replace a database password with a fixed string
- type: plain
  content: hunter2
  mode: replace
  replacement: "********"
```

#### Friendly names

`friendlyName` adds semantic context to reversible obfuscation placeholders without exposing the secret value:

```yaml
- type: plain
  content: github_pat_abc123def456
  friendlyName: GitHub Token
```

This produces placeholders shaped like `GitHubToken_correctHorseStapleBattery`. The friendly name keeps its letters and digits (case preserved), is capped at 32 characters, and is omitted if nothing remains. Invalid optional `friendlyName` metadata does not disable the secret entry; the secret still obfuscates with an unlabeled placeholder. The label is cosmetic: a placeholder is identified by its words. The label is shown to the model as written, so never put a secret in it; a label that spells out its own secret is dropped.

Native Responses replay plaintext is obfuscated too, including message text, tool arguments/results, and file/web-search text. Dynamic definitions in `mcp_list_tools`, `tool_search_output`, and `additional_tools` also redact tool/namespace descriptions, shell skill descriptions, MCP annotations, and schema descriptive annotations and examples. Schema constraints (including `enum`/`const`), execution defaults, unknown schema extensions, identifiers, authentication/routing settings, and grammars remain unchanged and outside text redaction. Static `context.tools`, system prompts, and image/file bytes are unchanged.

Encrypted replay and unknown protocol variants remain opaque.

The words are drawn from the BIP-39 English list by an HMAC of the exact secret under a private per-install key (stored at `~/.omp/agent/secret-placeholder.key`, or `$XDG_STATE_HOME/omp/secret-placeholder.key` on XDG-enabled installs, never sent to a model). Four words carry 44 bits; the rare collision between two secrets is resolved by drawing more words. The key prevents a transcript reader from dictionary-hashing a placeholder back to its secret, and keeps a secret's placeholder the same across sessions. No placeholder map is persisted: when a session loads, the map is rebuilt from every entry in its file, including content compacted out of the context, so placeholders restore after a restart too. If the key cannot be persisted on the lazy built-in-token path, the session warns and uses a process-ephemeral key; obfuscation remains reversible within that process but placeholders are not stable across restarts.

Placeholders in the earlier `$$HASH:CASE$$` format are no longer recognized. In sessions written before this format they stay literal text: the transcript shows them as tokens, and a tool call the model copies one into receives the token, not the value. Start a new session, or ask the model to use the secret's current placeholder.

`friendlyName` on regex entries labels the configured regex entry, not the matched value. Keep regex labels broad enough to be true for every match.

#### Regex secrets

Regex rules use Rust [`regex`](https://docs.rs/regex/latest/regex/#syntax) syntax and run in the native engine, in time linear in the text. Lookarounds (`(?=`, `(?!`, `(?<=`, `(?<!`) and backreferences are not supported. To match a secret only in context, name the part to redact `secret`: the text around the group must be present but is not redacted. Without a `secret` group the whole match is redacted. A rule has at most one `secret` group; when several alternatives need it, share the group (`api=(?P<secret>[0-9]{8}|[A-Z]{8})`).

```yaml
# Obfuscate any AWS-style key
- type: regex
  content: "AKIA[0-9A-Z]{16}"

# Redact only the value after `api_key=`, case-insensitively
- type: regex
  content: "api[_-]?key\\s*=\\s*(?P<secret>\\w+)"
  flags: "i"

# Regex literal syntax (pattern and flags in one string)
- type: regex
  content: "/bearer\\s+(?P<secret>[a-zA-Z0-9._~+\\/=-]+)/i"
```

Flags: `i` (case-insensitive), `m` (`^`/`$` match at line boundaries), `s` (`.` matches newlines); `g` and `u` are accepted and ignored. Character classes follow Rust: `\d`, `\w` and `\s` are Unicode-aware. The regex literal syntax `/pattern/flags` is supported as an alternative to separate `content` + `flags` fields. Escaped slashes within the pattern (`\\/`) are handled correctly.

Migrating a JavaScript-syntax rule: `(?<=password=)\S+` becomes `password=(?P<secret>\S+)`, `\S+(?=")` becomes `(?P<secret>\S+)"`, and a word boundary written as `(?<![A-Za-z0-9])` becomes `(?:^|[^A-Za-z0-9])` before the group.

#### Replace mode with regex

```yaml
# One-way replace connection strings (not reversible)
- type: regex
  content: "postgres://[^\\s]+"
  mode: replace
  replacement: "postgres://***"
```

## Invalid entries and files

- A missing `secrets.yml` is treated as no entries.
- A parse failure or non-array document is ignored with a warning.
- A regex entry whose pattern or flags the engine rejects stops startup with an error naming the file and entry, so a rule is never silently dropped while its secrets reach the provider.
- Other invalid entries are skipped individually with a warning. `type` must be `plain` or `regex`; `content` must be a non-empty string; `mode`, `replacement`, and `flags` are validated as shown above.
- Invalid optional `friendlyName` metadata is dropped without dropping an otherwise valid entry.

## Interaction with automatic detection

Environment variables are collected first, file-defined entries follow, and the built-in credential regex runs last so configured entries see matching content before the generic detector. Duplicate environment values are collapsed within the environment scan. Environment and file entries are not deduplicated against each other, so a plain value present in both is registered twice; both placeholders restore to the same secret, so deobfuscation is unaffected.

## Key files

- `packages/coding-agent/src/secrets/index.ts` -- loading, merging, env var collection
- `packages/coding-agent/src/secrets/obfuscator.ts` -- `SecretObfuscator` class, placeholder generation, message obfuscation
- `packages/coding-agent/src/secrets/regex.ts` -- regex literal parsing and compilation
- `packages/coding-agent/src/secrets/message-transform.ts` -- provider-context and local-context transforms
- `packages/coding-agent/src/secrets/patterns.ts` -- built-in credential patterns
- `packages/coding-agent/src/secrets/settings.ts` -- `secrets.enabled` setting definition

## See also

- [`auth-broker-gateway.md`](./auth-broker-gateway.md) -- remote credential vault and forward-proxy that keep provider OAuth refresh tokens and access tokens off developer hosts entirely (complementary to in-process obfuscation).
