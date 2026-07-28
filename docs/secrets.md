# Secret Obfuscation

Prevents sensitive values (API keys, tokens, passwords) from being sent to LLM providers. When enabled, secrets are replaced before outbound text content leaves the process. Reversible obfuscation placeholders are restored when session context is rebuilt for display or resume.

## Enabling

Disabled by default. Toggle via `/settings` UI or directly in `config.yml`:

```yaml
secrets:
  enabled: true
```

## How it works

1. On session startup, secrets are collected from two sources:
   - **Environment variables** whose names match common secret patterns (`KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASS`, `AUTH`, `CREDENTIAL`, `PRIVATE`, `OAUTH`) with values >= 8 characters
   - **`secrets.yml` files** (see below)

2. Outbound text messages to the LLM have secret values replaced with deterministic placeholders like `#AB12#`.

3. Session context is deep-walked and obfuscation placeholders are restored when building display/resume context. Replace-mode substitutions are one-way and are not restored.

Two modes control what happens to each secret:

| Mode                  | Behavior                                                | Reversible                                   |
| --------------------- | ------------------------------------------------------- | -------------------------------------------- |
| `obfuscate` (default) | Replaced with deterministic placeholder `#[A-Z0-9]{4}#` | Yes (deobfuscated in display/resume context) |
| `replace`             | Replaced with deterministic same-length string          | No (one-way)                                 |

## secrets.yml

Define custom secret entries in YAML. Two locations are checked:

| Level   | Path                        | Purpose                     |
| ------- | --------------------------- | --------------------------- |
| Global  | `~/.ompk/agent/secrets.yml` | Secrets across all projects |
| Project | `<cwd>/.ompk/secrets.yml`   | Project-specific secrets    |

Project entries override global entries with matching `content`.

### Schema

Each entry in the array has these fields:

| Field         | Type                         | Required | Description                                       |
| ------------- | ---------------------------- | -------- | ------------------------------------------------- |
| `type`        | `"plain"` or `"regex"`       | Yes      | Match strategy                                    |
| `content`     | string                       | Yes      | The secret value (plain) or regex pattern (regex) |
| `mode`        | `"obfuscate"` or `"replace"` | No       | Default: `"obfuscate"`                            |
| `replacement` | string                       | No       | Custom replacement (replace mode only)            |
| `flags`       | string                       | No       | Regex flags (regex type only)                     |

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

## Interaction with env var detection

Environment variables are collected first, then file-defined entries are appended. File entries can cover secrets that don't live in env vars (config files, hardcoded values, etc.). Env and file entries are not deduplicated against each other, so a plain value present in both is registered twice; both placeholders restore to the same secret, so deobfuscation is unaffected.

## Key files

- `packages/coding-agent/src/secrets/index.ts` -- loading, merging, env var collection
- `packages/coding-agent/src/secrets/obfuscator.ts` -- `SecretObfuscator` class, placeholder generation, message obfuscation
- `packages/coding-agent/src/secrets/regex.ts` -- regex literal parsing and compilation
- `packages/coding-agent/src/config/settings-schema.ts` -- `secrets.enabled` setting definition

## See also

- [`auth-broker-gateway.md`](./auth-broker-gateway.md) -- remote credential vault and forward-proxy that keep provider OAuth refresh tokens and access tokens off developer hosts entirely (complementary to in-process obfuscation).
