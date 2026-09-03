# Secret Obfuscation

Prevents sensitive values (API keys, tokens, passwords) from being sent to LLM providers. When enabled, configured secrets and built-in credential-shaped token patterns are replaced before provider-visible text leaves the process. Reversible placeholders are restored in model-authored tool arguments before execution and when local session context is rebuilt for display or resume.

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
   - A built-in reversible regex for common GitHub-, GitLab-, and OpenAI-style credential tokens that appear only in session content or tool results

2. Provider-visible text has matching values replaced with deterministic placeholders such as `$$3P8W5JH1TK2Q$$`, `$$3P8W5JH1TK2Q:L$$`, or `$$GITHUBTOKEN_3P8W5JH1TK2Q:L$$`.

3. Live model-authored tool arguments are deep-walked and placeholders are restored before the tool executes. Session context restores placeholders for local display/resume and re-obfuscates it before provider replay. Replace-mode substitutions are one-way and are not restored.

Two modes control what happens to each secret:

| Mode                  | Behavior                                                                                      | Reversible |
| --------------------- | --------------------------------------------------------------------------------------------- | ---------- |
| `obfuscate` (default) | Replaced with a deterministic `$$HASH(:hint)$$` or `$$FRIENDLY_HASH(:hint)$$` placeholder     | Yes        |
| `replace`             | Replaced with the configured `replacement`, or a deterministic same-length value when omitted | No         |

Obfuscate-mode plain values and regex matches shorter than 8 characters are ignored to avoid redacting ordinary short words. Replace mode can handle short values; a replace-mode regex with no custom replacement is rejected only when every possible 1–2 character match would be impossible to redact to a distinct stable value.

## secrets.yml

Define custom secret entries in YAML. Two locations are checked:

| Level   | Path                       | Purpose                     |
| ------- | -------------------------- | --------------------------- |
| Global  | `~/.omp/agent/secrets.yml` | Secrets across all projects |
| Project | `<cwd>/.omp/secrets.yml`   | Project-specific secrets    |

Project entries override global entries with matching `content`.

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

This produces placeholders shaped like `$$GITHUBTOKEN_3P8W5JH1TK2Q:L$$`. The friendly name is sanitized to uppercase letters and digits, capped at 32 characters, and omitted if it sanitizes to an empty value. Invalid optional `friendlyName` metadata does not disable the secret entry; the secret still obfuscates with an unlabeled placeholder. A label is also dropped for a particular placeholder if it would expose a configured literal secret or match a configured secret regex.

The 12-character hash base is an HMAC of the exact secret under a private per-install key (stored at `~/.omp/agent/secret-placeholder.key`, or `$XDG_STATE_HOME/omp/secret-placeholder.key` on XDG-enabled installs, never sent to a model). This prevents a transcript reader from dictionary-hashing a placeholder back to its secret. Secrets that differ only by case receive independent bases, so seeing one placeholder does not let a provider synthesize another by changing the case hint. If the key cannot be persisted on the lazy built-in-token path, the session warns and uses a process-ephemeral key; obfuscation remains reversible within that process but placeholders are not stable across restarts. A case-hint suffix labels the casing of the redacted value:

| Hint | Meaning                                        |
| ---- | ---------------------------------------------- |
| `:U` | all cased ASCII letters are uppercase          |
| `:L` | all cased ASCII letters are lowercase          |
| `:C` | first cased ASCII letter uppercase, rest lower |
| `:M` | mixed ASCII casing                             |

`friendlyName` on regex entries labels the configured regex entry, not the matched value. Keep regex labels broad enough to be true for every match.

#### Regex secrets

```yaml
# Obfuscate any AWS-style key
- type: regex
  content: "AKIA[0-9A-Z]{16}"

# Case-insensitive match with explicit flags
- type: regex
  content: "api[_-]?key\\s*=\\s*\\w+"
  flags: "i"

# Regex literal syntax (pattern and flags in one string)
- type: regex
  content: "/bearer\\s+[a-zA-Z0-9._~+\\/=-]+/i"
```

Regex entries always scan globally (the `g` flag is enforced automatically). The regex literal syntax `/pattern/flags` is supported as an alternative to separate `content` + `flags` fields. Escaped slashes within the pattern (`\\/`) are handled correctly.

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
- Invalid entries are skipped individually with a warning. `type` must be `plain` or `regex`; `content` must be a non-empty string; `mode`, `replacement`, `flags`, and regex syntax are validated as shown above.
- Invalid optional `friendlyName` metadata is dropped without dropping an otherwise valid entry.

## Interaction with automatic detection

Environment variables are collected first, file-defined entries follow, and the built-in credential regex runs last so configured entries see matching content before the generic detector. Duplicate environment values are collapsed within the environment scan. Environment and file entries are not deduplicated against each other, so a plain value present in both is registered twice; both placeholders restore to the same secret, so deobfuscation is unaffected.

## Key files

- `packages/coding-agent/src/secrets/index.ts` -- loading, merging, env var collection
- `packages/coding-agent/src/secrets/obfuscator.ts` -- `SecretObfuscator` class, placeholder generation, message obfuscation
- `packages/coding-agent/src/secrets/regex.ts` -- regex literal parsing and compilation
- `packages/coding-agent/src/config/settings-schema.ts` -- `secrets.enabled` setting definition

## See also

- [`auth-broker-gateway.md`](./auth-broker-gateway.md) -- remote credential vault and forward-proxy that keep provider OAuth refresh tokens and access tokens off developer hosts entirely (complementary to in-process obfuscation).
