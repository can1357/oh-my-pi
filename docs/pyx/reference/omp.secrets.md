# `omp.secrets`

Use `omp.secrets` to declare masking rules and to request Core's masked projection of text. The extension supplies rules, but Core owns the secret bytes, masking key, and rule snapshot; masking does not disclose matched secret material to Python.

```python
from omp import secrets

secrets.declare(
    secrets.SecretRule(
        pattern="ACME_TOKEN",
        kind=secrets.SecretKind.ENV,
        label="Acme API token",
    )
)

safe_text = secrets.mask(command_output)
```

This module handles output masking rules. For stored provider credentials, use [`omp.creds`](omp.creds.md).

## Enums

### `omp.secrets.SecretKind`

```python
class SecretKind(StrEnum):
    LITERAL = "literal"
    REGEX = "regex"
    ENV = "env"
```

Selects how Core resolves a rule pattern.

| Member | Wire value | Meaning |
|---|---|---|
| `LITERAL` | `"literal"` | Match literal content. Sent to Core as `plain`. |
| `REGEX` | `"regex"` | Interpret the pattern as a regular expression. |
| `ENV` | `"env"` | Resolve the named environment value in Core. |

### `omp.secrets.SecretMode`

```python
class SecretMode(StrEnum):
    OBFUSCATE = "obfuscate"
    REDACT = "redact"
```

Selects whether Core creates a reversible placeholder or permanently replaces a match.

| Member | Wire value | Meaning |
|---|---|---|
| `OBFUSCATE` | `"obfuscate"` | Core emits its canonical obfuscated placeholder. |
| `REDACT` | `"redact"` | Core replaces the match; sent over the host bridge as mode `replace`. |

## Rule model

### `omp.secrets.SecretRule`

```python
@dataclass(frozen=True, slots=True)
class SecretRule:
    pattern: str
    kind: SecretKind = SecretKind.LITERAL
    mode: SecretMode = SecretMode.OBFUSCATE
    label: str = ""
    replacement: str | None = None
    flags: str | None = None
```

Declares one Core-owned matching and masking rule. The dataclass is immutable; enum fields must already be `SecretKind` and `SecretMode` values and are not converted from strings.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `pattern` | `str` | required | Non-empty literal, regex, or environment-variable name. |
| `kind` | `SecretKind` | `SecretKind.LITERAL` | Pattern interpretation. |
| `mode` | `SecretMode` | `SecretMode.OBFUSCATE` | Reversible obfuscation or permanent replacement. |
| `label` | `str` | `""` | Friendly name sent to Core; an empty label is sent as `None`. |
| `replacement` | `str | None` | `None` | Optional replacement text. |
| `flags` | `str | None` | `None` | Optional Core-understood matching flags. |

**Raises**

: `ValueError` — `pattern` is empty or not a string.
: `TypeError` — An enum or optional text field has the wrong type.

```python
rule = secrets.SecretRule(
    pattern=r"token=[A-Za-z0-9_-]+",
    kind=secrets.SecretKind.REGEX,
    mode=secrets.SecretMode.REDACT,
    label="query token",
    replacement="token=<redacted>",
)
```

## Operations

### `omp.secrets.declare`

```python
def declare(rule: SecretRule) -> None: ...
```

Publishes one rule through the invocation-scoped host declaration arm. `SecretKind.LITERAL` is lowered to Core's `plain` kind, and `SecretMode.REDACT` is lowered to Core's `replace` mode.

**Parameters**

: **`rule`** (`SecretRule`) — Valid masking declaration.

**Returns**

: `None`

**Raises**

: `TypeError` — `rule` is not `SecretRule`.
: `omp.NotWiredError` — No backend with a `declare_secret` operation is installed in the current context.

```python
secrets.declare(
    secrets.SecretRule("SERVICE_PASSWORD", kind=secrets.SecretKind.ENV)
)
```

### `omp.secrets.mask`

```python
def mask(text: str) -> str: ...
```

Asks Core to apply the active rule snapshot and returns the masked text. Python passes the input string to the host seam and receives only the masked projection.

**Parameters**

: **`text`** (`str`) — Text to mask.

**Returns**

: `str` — Core's masked projection.

**Raises**

: `TypeError` — `text` is not a string or the backend returns a non-string.
: `omp.NotWiredError` — No backend with a `mask_secret` operation is installed.

```python
safe_stderr = secrets.mask(stderr)
logger.warning("command failed: %s", safe_stderr)
```

### `omp.secrets.is_masked`

```python
def is_masked(text: str) -> bool: ...
```

Returns whether text contains a canonical reversible placeholder. The recognized form is `$$`, an optional uppercase alphanumeric prefix ending in `_`, twelve uppercase alphanumeric characters, an optional `:U`, `:L`, `:C`, or `:M` suffix, and closing `$$`.

This detects obfuscation placeholders only; arbitrary replacement text produced by `SecretMode.REDACT` is not recognized.

**Parameters**

: **`text`** (`str`) — Text to inspect.

**Returns**

: `bool` — `True` when at least one canonical placeholder occurs.

**Raises**

: `TypeError` — `text` is not a string.

```python
masked = secrets.mask(output)
if secrets.is_masked(masked):
    mark_output_as_sensitive()
```
