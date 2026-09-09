# `omp.creds`

Use `omp.creds` for manifest-scoped credential operations. The host restricts requests to providers allowed by the extension manifest. Most operations return secret-free metadata or short-lived scoped tokens; `reveal()` is a separately granted, audited disclosure path.

```python
from omp import creds

for credential in await creds.list(provider="openai"):
    print(credential.id, credential.identity, credential.disabled)

token = await creds.mint_scoped("responses", provider="openai")
```

All functions are asynchronous control requests. They raise `omp.NotWiredError` when called without an installed host backend. Provider-side credential models are also described on the [`omp.provider`](omp.provider.md) page.

## Credential values

### `omp.creds.CredentialKind`

```python
class CredentialKind(StrEnum):
    API_KEY = "api_key"
    BEARER = "bearer"
    OAUTH = "oauth"
    AWS = "aws"
    SESSION = "session"
```

Identifies the material carried by a credential.

| Member | Wire value | Meaning |
|---|---|---|
| `API_KEY` | `"api_key"` | API-key material. |
| `BEARER` | `"bearer"` | Bearer-token material. |
| `OAUTH` | `"oauth"` | OAuth access and optional refresh material. |
| `AWS` | `"aws"` | AWS credential material. |
| `SESSION` | `"session"` | Provider session credential. |

### `omp.creds.Secret`

```python
class Secret:
    def __init__(self, bytes: bytes) -> None: ...
    def use(self) -> _omp.PySecretUse: ...
```

Wraps secret bytes in a redacting, immutable value. `str(secret)`, `repr(secret)`, and formatting never expose the bytes. Use the short-lived context manager returned by `use()` only at the boundary that needs the raw value.

**Parameters**

: **`bytes`** (`bytes`) — Secret bytes copied into the opaque value.

**Returns**

: `use()` returns a context manager whose `__enter__` value is `bytes` and whose `__exit__` does not suppress exceptions.

```python
secret = creds.Secret(b"provider-token")
with secret.use() as raw:
    send_to_provider(raw)
```

> **Warning** Keep the exposed `bytes` inside the `with` block and never log them. Redaction applies to the `Secret` wrapper, not to copies you make after exposure.

### `omp.creds.Credential`

```python
@dataclass(frozen=True, slots=True)
class Credential:
    kind: CredentialKind
    secret: Secret
    refresh_token: Secret | None = None
    expires_at_ms: int | None = None
    identity: str | None = None
    props: Mapping[str, int | str | bool] = _EMPTY_MAP
```

Carries credential material supplied to `store()` or returned by provider login and refresh callbacks.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `CredentialKind` | required | Credential material category. |
| `secret` | `Secret` | required | Primary secret. |
| `refresh_token` | `Secret | None` | `None` | Optional OAuth refresh token. |
| `expires_at_ms` | `int | None` | `None` | Expiration time in epoch milliseconds. |
| `identity` | `str | None` | `None` | Provider account identity. |
| `props` | `Mapping[str, int | str | bool]` | empty immutable mapping | Provider-specific scalar metadata. |

`store()` requires an actual `Credential` and seals each `Secret` into the host request.

```python
credential = creds.Credential(
    kind=creds.CredentialKind.API_KEY,
    secret=creds.Secret(b"key"),
    identity="build-bot",
)
metadata = await creds.store(credential, provider="acme")
```

### `omp.creds.CredentialMeta`

```python
@dataclass(frozen=True, slots=True)
class CredentialMeta:
    id: int
    provider: str
    identity: str | None
    kind: CredentialKind
    expires_at_ms: int | None = None
    disabled: bool = False
    disabled_cause: str | None = None
    blocks: tuple[Mapping[str, object], ...] = ()
```

Describes a stored credential without exposing secret material. Host-supplied block mappings are copied into immutable mappings during decoding.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `int` | required | Host credential identifier. |
| `provider` | `str` | required | Provider owning the credential. |
| `identity` | `str | None` | required | Provider account identity, if recorded. |
| `kind` | `CredentialKind` | required | Credential material category. |
| `expires_at_ms` | `int | None` | `None` | Expiration in epoch milliseconds. |
| `disabled` | `bool` | `False` | Whether selection is disabled. |
| `disabled_cause` | `str | None` | `None` | Recorded disable reason. |
| `blocks` | `tuple[Mapping[str, object], ...]` | `()` | Rate-limit or quota blocks reported by the host. |

### `omp.creds.ScopedToken`

```python
@dataclass(frozen=True, slots=True)
class ScopedToken:
    token: str
    expires_at_ms: int
```

Carries a short-lived token restricted to one provider-defined facet.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `token` | `str` | required | Scoped bearer value. |
| `expires_at_ms` | `int` | required | Expiration in epoch milliseconds. |

### `omp.creds.UsageScope`

```python
class UsageScope(StrEnum):
    CURRENT = "current"
    BILLING = "billing"
    RATE_LIMIT = "rate_limit"
    ALL = "all"
```

Selects which provider usage data to request.

| Member | Wire value | Meaning |
|---|---|---|
| `CURRENT` | `"current"` | Current usage view. |
| `BILLING` | `"billing"` | Billing view. |
| `RATE_LIMIT` | `"rate_limit"` | Rate-limit view. |
| `ALL` | `"all"` | All available views. |

### `omp.creds.UsageReport`

```python
@dataclass(frozen=True, slots=True)
class UsageReport:
    windows: tuple[UsageWindow, ...]
    balance_nanos_usd: int | None = None
    plan: str | None = None
    observed_at_ms: int | None = None
```

Aggregates provider quota windows and optional account metadata.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `windows` | `tuple[UsageWindow, ...]` | required | Quota or billing windows. |
| `balance_nanos_usd` | `int | None` | `None` | Balance in billionths of a US dollar. |
| `plan` | `str | None` | `None` | Provider plan name. |
| `observed_at_ms` | `int | None` | `None` | Observation time in epoch milliseconds. |

`UsageWindow` and its `UsageUnit` enum are defined by [`omp.provider`](omp.provider.md). The credential decoder accepts host mappings and converts fractional usage through `Decimal`.

## Inventory and mutation

### `omp.creds.list`

```python
async def list(provider: str | None = None) -> tuple[CredentialMeta, ...]: ...
```

Returns secret-free metadata for stored credentials.

**Parameters**

: **`provider`** (`str | None`) — Optional provider filter.

**Returns**

: `tuple[CredentialMeta, ...]` — Decoded metadata in host order.

**Raises**

: `TypeError` — The host response is not a sequence or contains malformed metadata.

### `omp.creds.store`

```python
async def store(
    cred: Credential, *, provider: str | None = None
) -> CredentialMeta: ...
```

Atomically persists credential material through the host and returns secret-free metadata.

**Parameters**

: **`cred`** (`Credential`) — Credential to seal and store.
: **`provider`** (`str | None`) — Optional provider selector.

**Returns**

: `CredentialMeta` — Stored record metadata.

**Raises**

: `TypeError` — `cred` is not a `Credential`, its secret fields are not `Secret` values, or the host metadata is malformed.

### `omp.creds.refresh`

```python
async def refresh(
    *, id: int | None = None, provider: str | None = None
) -> CredentialMeta: ...
```

Refreshes one credential through the host's single-flight refresh lease.

**Parameters**

: **`id`** (`int | None`) — Optional credential id.
: **`provider`** (`str | None`) — Optional provider selector.

**Returns**

: `CredentialMeta` — Refreshed metadata.

**Raises**

: `TypeError` — The host response is malformed.

### `omp.creds.clear`

```python
async def clear(
    *, id: int | None = None, provider: str | None = None
) -> None: ...
```

Deletes the credential selected by id and/or provider.

**Parameters**

: **`id`** (`int | None`) — Optional credential id.
: **`provider`** (`str | None`) — Optional provider selector.

**Returns**

: `None`

### `omp.creds.disable`

```python
async def disable(id: int, cause: str) -> CredentialMeta: ...
```

Disables a stored credential without deleting it.

**Parameters**

: **`id`** (`int`) — Credential id.
: **`cause`** (`str`) — Reason recorded by the host.

**Returns**

: `CredentialMeta` — Updated metadata.

**Raises**

: `TypeError` — The host response is malformed.

### `omp.creds.enable`

```python
async def enable(id: int) -> CredentialMeta: ...
```

Re-enables a disabled credential.

**Parameters**

: **`id`** (`int`) — Credential id.

**Returns**

: `CredentialMeta` — Updated metadata.

**Raises**

: `TypeError` — The host response is malformed.

### `omp.creds.report_block`

```python
async def report_block(
    *,
    until_ms: int,
    scope: str | None = None,
    id: int | None = None,
    provider: str | None = None,
) -> None: ...
```

Persists a rate-limit or quota block for a credential scope.

**Parameters**

: **`until_ms`** (`int`) — Block expiry in epoch milliseconds.
: **`scope`** (`str | None`) — Optional provider-defined scope.
: **`id`** (`int | None`) — Optional credential id.
: **`provider`** (`str | None`) — Optional provider selector.

**Returns**

: `None`

```python
await creds.report_block(
    provider="acme",
    scope="requests",
    until_ms=retry_at_ms,
)
```

## Usage and scoped access

### `omp.creds.usage`

```python
async def usage(
    *,
    scope: UsageScope = UsageScope.ALL,
    allow_stale: bool = True,
    provider: str | None = None,
) -> UsageReport | None: ...
```

Returns the provider usage report when one is available.

**Parameters**

: **`scope`** (`UsageScope`) — Requested usage view.
: **`allow_stale`** (`bool`) — Whether the host may use cached provider data.
: **`provider`** (`str | None`) — Optional provider selector.

**Returns**

: `UsageReport | None` — Decoded report, or `None` when unavailable.

**Raises**

: `TypeError` — `scope` is not `UsageScope` or the host response is malformed.

```python
report = await creds.usage(
    provider="acme",
    scope=creds.UsageScope.RATE_LIMIT,
    allow_stale=False,
)
```

### `omp.creds.mint_scoped`

```python
async def mint_scoped(
    facet: str,
    *,
    ttl: Duration | None = None,
    provider: str | None = None,
) -> ScopedToken: ...
```

Mints a short-lived token restricted to one provider-defined facet. A non-`None` duration is serialized using its canonical string form.

**Parameters**

: **`facet`** (`str`) — Provider-defined scope or operation name.
: **`ttl`** (`omp.Duration | None`) — Optional requested lifetime.
: **`provider`** (`str | None`) — Optional provider selector.

**Returns**

: `ScopedToken` — Token and expiration.

**Raises**

: `TypeError` — The host response is not a valid token mapping.

### `omp.creds.import_oauth`

```python
async def import_oauth(
    *,
    refresh_token: Secret,
    access_token: Secret | None = None,
    expires_at_ms: int | None = None,
    identity: str | None = None,
    props: Mapping[str, int | str | bool] = _FROZEN_EMPTY,
    provider: str | None = None,
) -> CredentialMeta: ...
```

Imports OAuth material obtained outside omp through the audited host control arm. Secret values are base64-sealed only for the control request; returned metadata contains no secret bytes.

**Parameters**

: **`refresh_token`** (`Secret`) — Required refresh token.
: **`access_token`** (`Secret | None`) — Optional current access token.
: **`expires_at_ms`** (`int | None`) — Optional access-token expiration.
: **`identity`** (`str | None`) — Optional provider account identity.
: **`props`** (`Mapping[str, int | str | bool]`) — Provider-specific scalar metadata.
: **`provider`** (`str | None`) — Optional provider selector.

**Returns**

: `CredentialMeta` — Imported record metadata.

**Raises**

: `TypeError` — A secret argument is not `Secret` or the host metadata is malformed.

```python
meta = await creds.import_oauth(
    provider="acme",
    refresh_token=creds.Secret(refresh_token_bytes),
    access_token=creds.Secret(access_token_bytes),
    expires_at_ms=expires_at_ms,
)
```

### `omp.creds.reveal`

```python
async def reveal(
    *, id: int | None = None, provider: str | None = None
) -> Secret: ...
```

Reveals one credential through the separately granted and audited host operation. The response must use the module's sealed base64 envelope and is returned as a redacting `Secret`.

**Parameters**

: **`id`** (`int | None`) — Optional credential id.
: **`provider`** (`str | None`) — Optional provider selector.

**Returns**

: `Secret` — Opaque revealed material.

**Raises**

: `TypeError` — The host response is not a valid sealed credential.
: `omp.NotWiredError` — No control backend is installed.

```python
secret = await creds.reveal(id=credential_id)
with secret.use() as raw:
    configure_client(raw)
```

> **Warning** Prefer `mint_scoped()` whenever the provider supports it. `reveal()` discloses the stored credential to extension Python and requires a distinct host grant.
