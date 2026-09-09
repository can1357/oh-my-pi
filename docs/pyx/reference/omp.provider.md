# `omp.provider`

`omp.provider` is the catalog, provider-integration, typed media, and model-update surface. Use it to declare supported routes and models, inspect resolved cards, subscribe to catalog changes, or implement provider cold paths; use [`omp.agents`](omp.agents.md) to request text completions.

```python
from omp.provider import Facet, models

cards = await models()
chat_models = [card for card in cards if Facet.CHAT in card.facets]
```

> **Warning** Provider CONTROL payloads must be JSON-compatible public data. A `Secret` cannot be encoded into them.

The 132 names in `provider.__all__`, plus the public direct callback dispatcher, are grouped below by task.

## Registration and lifecycle

### omp.provider.provider

```python
def provider(spec: ProviderSpec, /, *, priority: int = 0, extends: str | None = None, replaces: str | None = None) -> ProviderHandle
```

Register a provider declaration and return its lifecycle handle.

Registration occurs immediately. The module itself is also callable, so `omp.provider(spec)` delegates to this function. Supply `extends` for an overlay; model overlays without a base extension are rejected.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `spec` | `ProviderSpec` | The spec value. |
| `priority` | `int` | The relative arbitration priority. |
| `extends` | `str \| None` | The extends value. |
| `replaces` | `str \| None` | The replaces value. |

**Returns**

`ProviderHandle`
: A `ProviderHandle` value.

**Raises**

`SpecError`
: Raised when an argument or host result violates the operation contract.

**Example**

```python
SPEC = ProviderSpec(id="acme", name="Acme", routes=(route,))
handle = provider(SPEC)
```

### omp.provider.ProviderHandle

```python
ProviderHandle(spec: ProviderSpec, *, priority: int = 0, extends: str | None = None, replaces: str | None = None)
```

`ProviderHandle` provides the public provider handle behavior.

The handle refers to the declaration registered at import time and sends runtime operations through host CONTROL. It is also a class decorator for binding cold-path callbacks.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `spec` | `ProviderSpec` | The spec value. |
| `priority` | `int` | The relative arbitration priority. |
| `extends` | `str \| None` | The extends value. |
| `replaces` | `str \| None` | The replaces value. |

#### omp.provider.ProviderHandle.__call__

```python
handle(implementation: type) -> type
```

Binds a provider callback implementation class and returns that class unchanged.

#### omp.provider.ProviderHandle.id

```python
ProviderHandle.id: str
```

Read the stable provider identifier.

**Returns**

`str`
: A `str` value.

#### omp.provider.ProviderHandle.retract

```python
async def ProviderHandle.retract() -> None
```

Remove the declaration through host CONTROL.

**Returns**

`None`
: No value.

#### omp.provider.ProviderHandle.replace

```python
async def ProviderHandle.replace(spec: ProviderSpec) -> None
```

Atomically replace the provider specification.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `spec` | `ProviderSpec` | The spec value. |

**Returns**

`None`
: No value.

**Raises**

`TypeError`
: Raised when an argument or host result violates the operation contract.
`ValueError`
: Raised when an argument or host result violates the operation contract.

**Example**

```python
await handle.replace(updated_spec)
```

#### omp.provider.ProviderHandle.models

```python
async def ProviderHandle.models() -> tuple[ModelCard, ...]
```

Read this provider’s resolved model cards.

**Returns**

`tuple[ModelCard, ...]`
: An immutable tuple of results.

**Raises**

`TypeError`
: Raised when an argument or host result violates the operation contract.

#### omp.provider.ProviderHandle.is_authenticated

```python
async def ProviderHandle.is_authenticated() -> bool
```

Check whether an eligible provider principal exists.

**Returns**

`bool`
: The requested truth value.

**Raises**

`TypeError`
: Raised when an argument or host result violates the operation contract.

#### omp.provider.ProviderHandle.request

```python
async def ProviderHandle.request(operation: Operation, request: ImageRequest | SpeechRequest | TranscriptionRequest | RealtimeRequest) -> ImageResult | SpeechResult | TranscriptionResult | RealtimeSession
```

Run one supported typed media or realtime operation.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `operation` | `Operation` | The requested provider operation. |
| `request` | `ImageRequest \| SpeechRequest \| TranscriptionRequest \| RealtimeRequest` | Per-request pricing or typed request value. |

**Returns**

`ImageResult | SpeechResult | TranscriptionResult | RealtimeSession`
: A `ImageResult | SpeechResult | TranscriptionResult | RealtimeSession` value.

**Raises**

`ValueError`
: Raised when an argument or host result violates the operation contract.
`TypeError`
: Raised when an argument or host result violates the operation contract.

**Example**

```python
result = await handle.request(
    Operation.GENERATE_IMAGE,
    ImageRequest("A line drawing", Dimensions(512, 512), ImageFormat.PNG),
)
```

### omp.provider.dispatch_provider_callback

```python
async def dispatch_provider_callback(
    provider_id: str,
    callback_name: str,
    *args: object,
    **kwargs: object,
) -> object
```

Dispatch a host-selected callback on a registered provider implementation.

The implementation is activated only after the declaration registry is frozen. The dispatcher locates the method by its registered hook name, invokes it, and awaits an awaitable result. This direct module attribute is intentionally absent from `provider.__all__`.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `provider_id` | `str` | The registered provider identifier. |
| `callback_name` | `str` | The hook callback name selected by the host. |
| `*args` | `object` | Positional arguments forwarded to the callback. |
| `**kwargs` | `object` | Keyword arguments forwarded to the callback. |

**Returns**

`object`
: The callback result, after awaiting it when necessary.

**Raises**

`RuntimeError`
: The declaration registry has not reached FREEZE.

`LookupError`
: The provider is unknown, has no implementation, or does not expose the named callback.

### omp.provider.ProviderSpec

```python
@dataclass(frozen=True, slots=True)
class ProviderSpec:
    id: str
    name: str
    routes: tuple[RouteSpec, ...]
    models: tuple[ModelSpec, ...] = ()
    management: ManagementSpec = ManagementSpec()
    discovery_defaults: DiscoveryDefaults | None = None
    mapping: object = 'concrete'
    aliases: tuple[ScopedAlias, ...] = ()
    model_overlays: tuple[ModelOverlay, ...] = ()
```

`ProviderSpec` carries typed provider spec data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `str` | — | The stable identifier. |
| `name` | `str` | — | The display or protocol name. |
| `routes` | `tuple[RouteSpec, ...]` | — | Route identifiers in preference order. |
| `models` | `tuple[ModelSpec, ...]` | `()` | Model declarations returned by the operation. |
| `management` | `ManagementSpec` | `ManagementSpec()` | Provider management capabilities. |
| `discovery_defaults` | `DiscoveryDefaults \| None` | `None` | The discovery defaults value. |
| `mapping` | `object` | `'concrete'` | The provider model-mapping mode. |
| `aliases` | `tuple[ScopedAlias, ...]` | `()` | Provider-scoped aliases. |
| `model_overlays` | `tuple[ModelOverlay, ...]` | `()` | Provider-scoped model additions and patches. |

**Raises**

`SpecError`
: Raised when the field combination violates the value’s invariants.

### omp.provider.ManagementSpec

```python
@dataclass(frozen=True, slots=True)
class ManagementSpec:
    operations: frozenset[Operation] = frozenset()
    multiple_accounts: bool = False
    refresh: bool = False
    principal_quota: bool = False
```

`ManagementSpec` carries typed management spec data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `operations` | `frozenset[Operation]` | `frozenset()` | The operations supported by the declaration. |
| `multiple_accounts` | `bool` | `False` | Whether more than one account may be active. |
| `refresh` | `bool` | `False` | Refresh behavior or support. |
| `principal_quota` | `bool` | `False` | Whether quota is tracked per principal. |

### omp.provider.SpecError

```python
class SpecError(ExtensionError): ...
```

`SpecError` reports an invalid provider declaration.

Catch it when constructing or registering provider data that may be supplied dynamically.

## Routes, codecs, and trust

### omp.provider.Api

```python
class Api(StrEnum): ...
```

`Api` is the closed vocabulary for api values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `OPENAI_CHAT` | `'openai_chat'` | Selects the `openai_chat` api variant. |
| `OPENAI_RESPONSES` | `'openai_responses'` | Selects the `openai_responses` api variant. |
| `OPENAI_CODEX` | `'openai_codex'` | Selects the `openai_codex` api variant. |
| `ANTHROPIC_MESSAGES` | `'anthropic_messages'` | Selects the `anthropic_messages` api variant. |
| `GEMINI` | `'gemini'` | Selects the `gemini` api variant. |
| `GOOGLE_CCA` | `'google_cca'` | Selects the `google_cca` api variant. |
| `BEDROCK` | `'bedrock'` | Selects the `bedrock` api variant. |
| `OLLAMA` | `'ollama'` | Selects the `ollama` api variant. |
| `GITLAB_DUO` | `'gitlab_duo'` | Selects the `gitlab_duo` api variant. |
| `CURSOR` | `'cursor'` | Selects the `cursor` api variant. |
| `DEVIN` | `'devin'` | Selects the `devin` api variant. |
| `OPENAI_EMBEDDING` | `'openai_embedding'` | Selects the `openai_embedding` api variant. |
| `OPENAI_MEDIA` | `'openai_media'` | Selects the `openai_media` api variant. |
| `OPENAI_REALTIME` | `'openai_realtime'` | Selects the `openai_realtime` api variant. |
| `SEARCH_EXA` | `'search_exa'` | Selects the `search_exa` api variant. |
| `SEARCH_HTTP` | `'search_http'` | Selects the `search_http` api variant. |
| `SEARCH_TAVILY` | `'search_tavily'` | Selects the `search_tavily` api variant. |
| `SEARCH_KAGI` | `'search_kagi'` | Selects the `search_kagi` api variant. |
| `SEARCH_PERPLEXITY` | `'search_perplexity'` | Selects the `search_perplexity` api variant. |
| `SEARCH_PARALLEL` | `'search_parallel'` | Selects the `search_parallel` api variant. |
| `OMP_NATIVE` | `'omp_native'` | Selects the `omp_native` api variant. |
| `LOCAL` | `'local'` | Selects the `local` api variant. |

### omp.provider.Transport

```python
class Transport(StrEnum): ...
```

`Transport` is the closed vocabulary for transport values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `HTTP` | `'http'` | Selects the `http` transport variant. |
| `WEBSOCKET` | `'websocket'` | Selects the `websocket` transport variant. |
| `WEBRTC` | `'webrtc'` | Selects the `webrtc` transport variant. |
| `AWS_EVENT_STREAM` | `'aws_event_stream'` | Selects the `aws_event_stream` transport variant. |
| `CONNECT` | `'connect'` | Selects the `connect` transport variant. |
| `LOCAL` | `'local'` | Selects the `local` transport variant. |

### omp.provider.CodecProfile

```python
class CodecProfile(StrEnum): ...
```

`CodecProfile` is the closed vocabulary for codec profile values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `STANDARD` | `'standard'` | Selects the `standard` codec profile variant. |
| `GOOGLE_CCA_GEMINI_CLI` | `'google-cca-gemini-cli'` | Selects the `google-cca-gemini-cli` codec profile variant. |
| `GOOGLE_CCA_ANTIGRAVITY` | `'google-cca-antigravity'` | Selects the `google-cca-antigravity` codec profile variant. |
| `APPLE_FM` | `'apple-fm'` | Selects the `apple-fm` codec profile variant. |

### omp.provider.Operation

```python
class Operation(StrEnum): ...
```

`Operation` is the closed vocabulary for operation values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `CHAT` | `'chat'` | Selects the `chat` operation variant. |
| `COUNT_TOKENS` | `'count_tokens'` | Selects the `count_tokens` operation variant. |
| `TOKENIZE` | `'tokenize'` | Selects the `tokenize` operation variant. |
| `DETOKENIZE` | `'detokenize'` | Selects the `detokenize` operation variant. |
| `EMBED` | `'embed'` | Selects the `embed` operation variant. |
| `GENERATE_IMAGE` | `'generate_image'` | Selects the `generate_image` operation variant. |
| `GENERATE_VIDEO` | `'generate_video'` | Selects the `generate_video` operation variant. |
| `SPEAK` | `'speak'` | Selects the `speak` operation variant. |
| `TRANSCRIBE` | `'transcribe'` | Selects the `transcribe` operation variant. |
| `REALTIME` | `'realtime'` | Selects the `realtime` operation variant. |
| `SEARCH` | `'search'` | Selects the `search` operation variant. |
| `USAGE` | `'usage'` | Selects the `usage` operation variant. |
| `DISCOVER_MODELS` | `'discover_models'` | Selects the `discover_models` operation variant. |
| `AUTH` | `'auth'` | Selects the `auth` operation variant. |
| `NATIVE` | `'native'` | Selects the `native` operation variant. |

### omp.provider.RouteSpec

```python
@dataclass(frozen=True, slots=True)
class RouteSpec:
    id: str
    base_url: str
    api: Api
    transport: Transport = Transport.HTTP
    auth: AuthSpec = AuthSpec(AuthMode.NONE, header=None, prefix=None, sources=())
    headers: Mapping[str, str] = field(default_factory=lambda: _EMPTY_MAP)
    region: str | None = None
    discovery: DiscoverySpec | None = None
    trust: TrustDomain = TrustDomain.https()
    limits: RouteLimits = RouteLimits()
    compat: CompatFlags = CompatFlags()
    codec_profile: CodecProfile = CodecProfile.STANDARD
    priority: int | None = None
```

`RouteSpec` carries typed route spec data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `str` | — | The stable identifier. |
| `base_url` | `str` | — | The absolute route URL or Unix socket path. |
| `api` | `Api` | — | The selected codec family. |
| `transport` | `Transport` | `Transport.HTTP` | The request transport. |
| `auth` | `AuthSpec` | `AuthSpec(AuthMode.NONE, header=None, prefix=None, sources=())` | The route authentication declaration. |
| `headers` | `Mapping[str, str]` | `field(default_factory=lambda: _EMPTY_MAP)` | Static request headers. |
| `region` | `str \| None` | `None` | The optional provider region. |
| `discovery` | `DiscoverySpec \| None` | `None` | Remote model-discovery settings. |
| `trust` | `TrustDomain` | `TrustDomain.https()` | The credential-forwarding trust boundary. |
| `limits` | `RouteLimits` | `RouteLimits()` | Route-specific capability reductions. |
| `compat` | `CompatFlags` | `CompatFlags()` | Wire-compatibility overrides. |
| `codec_profile` | `CodecProfile` | `CodecProfile.STANDARD` | The codec construction profile. |
| `priority` | `int \| None` | `None` | The relative arbitration priority. |

**Raises**

`SpecError`
: Raised when the field combination violates the value’s invariants.

### omp.provider.RouteLimits

```python
@dataclass(frozen=True, slots=True)
class RouteLimits:
    operations: frozenset[Operation] | None = None
    max_context_tokens: int | None = None
    max_output_tokens: int | None = None
    disable_server_state: bool = False
    disable_prompt_caching: bool = False
```

`RouteLimits` carries typed route limits data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `operations` | `frozenset[Operation] \| None` | `None` | The operations supported by the declaration. |
| `max_context_tokens` | `int \| None` | `None` | The upper bound for context tokens. |
| `max_output_tokens` | `int \| None` | `None` | The maximum generated tokens, if known. |
| `disable_server_state` | `bool` | `False` | Whether the server state is enabled. |
| `disable_prompt_caching` | `bool` | `False` | Whether the prompt caching is enabled. |

### omp.provider.CompatFlags

```python
@dataclass(frozen=True, slots=True)
class CompatFlags:
    schema_flavor: ToolSchemaFlavor | None = None
    watchdog: StreamWatchdog | None = None
```

`CompatFlags` carries typed compat flags data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `schema_flavor` | `ToolSchemaFlavor \| None` | `None` | The schema flavor value. |
| `watchdog` | `StreamWatchdog \| None` | `None` | The watchdog value. |

### omp.provider.StreamWatchdog

```python
@dataclass(frozen=True, slots=True)
class StreamWatchdog:
    first_event: Duration
    inter_event: Duration | None = None
```

`StreamWatchdog` carries typed stream watchdog data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `first_event` | `Duration` | — | The maximum wait for the first stream event. |
| `inter_event` | `Duration \| None` | `None` | The maximum wait between later events. |

**Raises**

`SpecError`
: Raised when the field combination violates the value’s invariants.

### omp.provider.TrustDomain

```python
@dataclass(frozen=True, slots=True)
class TrustDomain:
    origin: str
    redirects: RedirectTrust = RedirectTrust.SAME_ORIGIN
    allow_plaintext: bool = False
```

`TrustDomain` carries typed trust domain data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `origin` | `str` | — | The trusted route origin. |
| `redirects` | `RedirectTrust` | `RedirectTrust.SAME_ORIGIN` | The redirect trust policy. |
| `allow_plaintext` | `bool` | `False` | Whether loopback or Unix-socket plaintext is allowed. |

**Raises**

`SpecError`
: Raised when the field combination violates the value’s invariants.

**Example**

```python
route = RouteSpec(
    id="local", base_url="http://127.0.0.1:11434",
    api=Api.OLLAMA, trust=TrustDomain.loopback(),
)
```

#### omp.provider.TrustDomain.https

```python
def TrustDomain.https(*, redirects: RedirectTrust = RedirectTrust.SAME_ORIGIN) -> 'TrustDomain'
```

Create a TLS-only trust template derived from the route URL.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `redirects` | `RedirectTrust` | The redirect trust policy. |

**Returns**

`'TrustDomain'`
: A `'TrustDomain'` value.

#### omp.provider.TrustDomain.loopback

```python
def TrustDomain.loopback(*, redirects: RedirectTrust = RedirectTrust.SAME_ORIGIN) -> 'TrustDomain'
```

Create a trust template that permits loopback or Unix-socket plaintext.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `redirects` | `RedirectTrust` | The redirect trust policy. |

**Returns**

`'TrustDomain'`
: A `'TrustDomain'` value.

### omp.provider.RedirectTrust

```python
class RedirectTrust(StrEnum): ...
```

`RedirectTrust` is the closed vocabulary for redirect trust values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `DENY` | `'deny'` | Selects the `deny` redirect trust variant. |
| `SAME_ORIGIN` | `'same_origin'` | Selects the `same_origin` redirect trust variant. |
| `PUBLIC_ONLY` | `'public_only'` | Selects the `public_only` redirect trust variant. |

## Authentication and signing

### omp.provider.AccountScope

```python
class AccountScope(StrEnum): ...
```

`AccountScope` is the closed vocabulary for account scope values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `PROVIDER` | `'provider'` | Selects the `provider` account scope variant. |
| `ROUTE` | `'route'` | Selects the `route` account scope variant. |
| `REGION` | `'region'` | Selects the `region` account scope variant. |

### omp.provider.AuthMode

```python
class AuthMode(StrEnum): ...
```

`AuthMode` is the closed vocabulary for auth mode values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `NONE` | `'none'` | Selects the `none` auth mode variant. |
| `API_KEY` | `'api_key'` | Selects the `api_key` auth mode variant. |
| `BEARER` | `'bearer'` | Selects the `bearer` auth mode variant. |
| `OAUTH` | `'oauth'` | Selects the `oauth` auth mode variant. |
| `AWS_SIGV4` | `'aws_sigv4'` | Selects the `aws_sigv4` auth mode variant. |
| `GCP_ADC` | `'gcp_adc'` | Selects the `gcp_adc` auth mode variant. |
| `AZURE_AD` | `'azure_ad'` | Selects the `azure_ad` auth mode variant. |
| `GITHUB_APP` | `'github_app'` | Selects the `github_app` auth mode variant. |
| `OMP_SESSION` | `'omp_session'` | Selects the `omp_session` auth mode variant. |

### omp.provider.AuthSpec

```python
@dataclass(frozen=True, slots=True)
class AuthSpec:
    mode: AuthMode
    header: str | None = 'authorization'
    prefix: str | None = 'Bearer '
    query: str | None = None
    scopes: tuple[str, ...] = ()
    audience: str | None = None
    account_scope: AccountScope = AccountScope.PROVIDER
    sources: tuple[CredentialSource, ...] = (CredentialSource('stored'),)
    oauth: OAuthSpec | None = None
    signing: object | None = None
```

`AuthSpec` carries typed auth spec data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `AuthMode` | — | The selected mode. |
| `header` | `str \| None` | `'authorization'` | The header name. |
| `prefix` | `str \| None` | `'Bearer '` | The value prefix. |
| `query` | `str \| None` | `None` | The query text or parameter name. |
| `scopes` | `tuple[str, ...]` | `()` | OAuth scopes. |
| `audience` | `str \| None` | `None` | The authentication audience. |
| `account_scope` | `AccountScope` | `AccountScope.PROVIDER` | The principal and quota sharing boundary. |
| `sources` | `tuple[CredentialSource, ...]` | `(CredentialSource('stored'),)` | Credential acquisition sources in order. |
| `oauth` | `OAuthSpec \| None` | `None` | The OAuth declaration, if used. |
| `signing` | `object \| None` | `None` | Provider-specific signing metadata. |

### omp.provider.CredentialSource

```python
@dataclass(frozen=True, slots=True)
class CredentialSource:
    kind: str
    ordered_names: tuple[str, ...] = ()
    options: Mapping[str, object] = field(default_factory=lambda: _EMPTY_MAP)
```

`CredentialSource` carries typed credential source data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `str` | — | The typed variant discriminator. |
| `ordered_names` | `tuple[str, ...]` | `()` | Candidate names in acquisition order. |
| `options` | `Mapping[str, object]` | `field(default_factory=lambda: _EMPTY_MAP)` | Public source-specific options. |

**Example**

```python
auth = AuthSpec(
    AuthMode.BEARER,
    sources=(CredentialSource.env("ACME_TOKEN"), CredentialSource.stored()),
)
```

#### omp.provider.CredentialSource.env

```python
def CredentialSource.env(*names: str) -> 'CredentialSource'
```

Build a source that checks environment variables in the supplied order.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `*names` | `str` | The names value. |

**Returns**

`'CredentialSource'`
: A `'CredentialSource'` value.

**Raises**

`SpecError`
: Raised when an argument or host result violates the operation contract.

#### omp.provider.CredentialSource.stored

```python
def CredentialSource.stored() -> 'CredentialSource'
```

Build a source backed by the encrypted account store.

**Returns**

`'CredentialSource'`
: A `'CredentialSource'` value.

#### omp.provider.CredentialSource.oauth

```python
def CredentialSource.oauth() -> 'CredentialSource'
```

Build a source that runs the enclosing OAuth declaration.

**Returns**

`'CredentialSource'`
: A `'CredentialSource'` value.

#### omp.provider.CredentialSource.application_default

```python
def CredentialSource.application_default(*, api_key_env: str = 'GOOGLE_API_KEY', project_env: str = 'GOOGLE_CLOUD_PROJECT', location_env: str = 'GOOGLE_CLOUD_LOCATION') -> 'CredentialSource'
```

Build a Google application-default credential source.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `api_key_env` | `str` | The api key env value. |
| `project_env` | `str` | The project env value. |
| `location_env` | `str` | The location env value. |

**Returns**

`'CredentialSource'`
: A `'CredentialSource'` value.

**Raises**

`SpecError`
: Raised when an argument or host result violates the operation contract.

#### omp.provider.CredentialSource.aws_chain

```python
def CredentialSource.aws_chain() -> 'CredentialSource'
```

Build a source that follows the standard AWS chain.

**Returns**

`'CredentialSource'`
: A `'CredentialSource'` value.

#### omp.provider.CredentialSource.session

```python
def CredentialSource.session() -> 'CredentialSource'
```

Build an interactive session credential source.

**Returns**

`'CredentialSource'`
: A `'CredentialSource'` value.

### omp.provider.CredentialKind

```python
class CredentialKind(StrEnum): ...
```

`CredentialKind` is the closed vocabulary for credential kind values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `API_KEY` | `'api_key'` | Selects the `api_key` credential kind variant. |
| `BEARER` | `'bearer'` | Selects the `bearer` credential kind variant. |
| `OAUTH` | `'oauth'` | Selects the `oauth` credential kind variant. |
| `AWS` | `'aws'` | Selects the `aws` credential kind variant. |
| `SESSION` | `'session'` | Selects the `session` credential kind variant. |

### omp.provider.Credential

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

`Credential` carries typed credential data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `CredentialKind` | — | The typed variant discriminator. |
| `secret` | `Secret` | — | The secret value. |
| `refresh_token` | `Secret \| None` | `None` | The callback-scoped refresh token. |
| `expires_at_ms` | `int \| None` | `None` | The Unix-epoch expiration time in milliseconds. |
| `identity` | `str \| None` | `None` | The stable account or principal identifier. |
| `props` | `Mapping[str, int \| str \| bool]` | `_EMPTY_MAP` | Additional provider-defined public metadata. |

### omp.provider.OAuthFlowKind

```python
class OAuthFlowKind(StrEnum): ...
```

`OAuthFlowKind` is the closed vocabulary for o auth flow kind values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `PKCE` | `'pkce'` | Selects the `pkce` o auth flow kind variant. |
| `DEVICE_CODE` | `'device_code'` | Selects the `device_code` o auth flow kind variant. |
| `PASTE` | `'paste'` | Selects the `paste` o auth flow kind variant. |
| `CUSTOM` | `'custom'` | Selects the `custom` o auth flow kind variant. |

### omp.provider.Completion

```python
class Completion(StrEnum): ...
```

`Completion` is the closed vocabulary for completion values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `CALLBACK_URL` | `'callback_url'` | Selects the `callback_url` completion variant. |
| `PASTE_CALLBACK_URL` | `'paste_callback_url'` | Selects the `paste_callback_url` completion variant. |
| `PASTE_CODE` | `'paste_code'` | Selects the `paste_code` completion variant. |

### omp.provider.RefreshBehavior

```python
class RefreshBehavior(StrEnum): ...
```

`RefreshBehavior` is the closed vocabulary for refresh behavior values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `UNSUPPORTED` | `'unsupported'` | Selects the `unsupported` refresh behavior variant. |
| `TOKEN_ENDPOINT` | `'token_endpoint'` | Selects the `token_endpoint` refresh behavior variant. |

### omp.provider.OAuthFlow

```python
@dataclass(frozen=True, slots=True)
class OAuthFlow:
    kind: OAuthFlowKind
    url: str
    redirect_uri: str | None = None
    completion: Completion | None = None
    parameters: Mapping[str, str] = field(default_factory=lambda: _EMPTY_MAP)
    max_polls: int | None = None
    interval: object | None = None
    max_interval: object | None = None
    prompt: str | None = None
```

`OAuthFlow` carries typed o auth flow data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `OAuthFlowKind` | — | The typed variant discriminator. |
| `url` | `str` | — | The absolute endpoint or result URL. |
| `redirect_uri` | `str \| None` | `None` | The redirect uri value. |
| `completion` | `Completion \| None` | `None` | The completion value. |
| `parameters` | `Mapping[str, str]` | `field(default_factory=lambda: _EMPTY_MAP)` | A mapping containing parameters. |
| `max_polls` | `int \| None` | `None` | The upper bound for polls. |
| `interval` | `object \| None` | `None` | The interval value. |
| `max_interval` | `object \| None` | `None` | The upper bound for interval. |
| `prompt` | `str \| None` | `None` | The user or model instruction text. |

**Example**

```python
flow = OAuthFlow.device_code(
    "https://auth.example/device",
    max_polls=120,
)
```

#### omp.provider.OAuthFlow.pkce

```python
def OAuthFlow.pkce(authorize_url: str, redirect_uri: str, *, completion: Completion = Completion.CALLBACK_URL, params: Mapping[str, str] = _EMPTY_MAP) -> 'OAuthFlow'
```

Create an S256 PKCE authorization-code flow.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `authorize_url` | `str` | The authorize url value. |
| `redirect_uri` | `str` | The redirect uri value. |
| `completion` | `Completion` | The completion value. |
| `params` | `Mapping[str, str]` | A mapping containing params. |

**Returns**

`'OAuthFlow'`
: A `'OAuthFlow'` value.

#### omp.provider.OAuthFlow.device_code

```python
def OAuthFlow.device_code(device_authorization_url: str, *, max_polls: int = 180, interval: object = None, max_interval: object = None) -> 'OAuthFlow'
```

Create an RFC 8628 device-code flow.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `device_authorization_url` | `str` | The device authorization url value. |
| `max_polls` | `int` | The upper bound for polls. |
| `interval` | `object` | The interval value. |
| `max_interval` | `object` | The upper bound for interval. |

**Returns**

`'OAuthFlow'`
: A `'OAuthFlow'` value.

#### omp.provider.OAuthFlow.paste

```python
def OAuthFlow.paste(authorization_url: str, prompt: str) -> 'OAuthFlow'
```

Create a browser-assisted pasted-input flow.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `authorization_url` | `str` | The authorization url value. |
| `prompt` | `str` | The user or model instruction text. |

**Returns**

`'OAuthFlow'`
: A `'OAuthFlow'` value.

### omp.provider.OAuthSpec

```python
@dataclass(frozen=True, slots=True)
class OAuthSpec:
    client_id: str
    token_url: str
    flow: OAuthFlow
    scopes: tuple[str, ...] = ()
    audience: str | None = None
    placement: TokenPlacement = TokenPlacement('header', 'authorization', 'Bearer ')
    token_params: Mapping[str, str] = field(default_factory=lambda: _EMPTY_MAP)
    refresh: RefreshBehavior = RefreshBehavior.TOKEN_ENDPOINT
    principal: PrincipalResolution | None = None
```

`OAuthSpec` carries typed o auth spec data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `client_id` | `str` | — | The public OAuth client identifier. |
| `token_url` | `str` | — | The OAuth token endpoint. |
| `flow` | `OAuthFlow` | — | The authorization flow. |
| `scopes` | `tuple[str, ...]` | `()` | OAuth scopes. |
| `audience` | `str \| None` | `None` | The authentication audience. |
| `placement` | `TokenPlacement` | `TokenPlacement('header', 'authorization', 'Bearer ')` | Where the access token is placed. |
| `token_params` | `Mapping[str, str]` | `field(default_factory=lambda: _EMPTY_MAP)` | Public token-endpoint parameters. |
| `refresh` | `RefreshBehavior` | `RefreshBehavior.TOKEN_ENDPOINT` | Refresh behavior or support. |
| `principal` | `PrincipalResolution \| None` | `None` | Stable-principal resolution rules. |

### omp.provider.TokenPlacement

```python
@dataclass(frozen=True, slots=True)
class TokenPlacement:
    kind: str
    name: str | None = None
    prefix: str | None = None
```

`TokenPlacement` carries typed token placement data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `str` | — | The typed variant discriminator. |
| `name` | `str \| None` | `None` | The display or protocol name. |
| `prefix` | `str \| None` | `None` | The value prefix. |

#### omp.provider.TokenPlacement.header

```python
def TokenPlacement.header(name: str, prefix: str = '') -> 'TokenPlacement'
```

Place an access token in a request header.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `name` | `str` | The display or protocol name. |
| `prefix` | `str` | The value prefix. |

**Returns**

`'TokenPlacement'`
: A `'TokenPlacement'` value.

#### omp.provider.TokenPlacement.query

```python
def TokenPlacement.query(parameter: str) -> 'TokenPlacement'
```

Place an access token in a query parameter.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `parameter` | `str` | The parameter value. |

**Returns**

`'TokenPlacement'`
: A `'TokenPlacement'` value.

### omp.provider.PrincipalResolution

```python
@dataclass(frozen=True, slots=True)
class PrincipalResolution:
    kind: str
    values: tuple[str, ...]
```

`PrincipalResolution` carries typed principal resolution data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `str` | — | The typed variant discriminator. |
| `values` | `tuple[str, ...]` | — | Candidate claim fields or static values. |

#### omp.provider.PrincipalResolution.id_token_claim

```python
def PrincipalResolution.id_token_claim(claim: str) -> 'PrincipalResolution'
```

Resolve a principal from a verified ID-token claim.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `claim` | `str` | The claim value. |

**Returns**

`'PrincipalResolution'`
: A `'PrincipalResolution'` value.

#### omp.provider.PrincipalResolution.access_token_claims

```python
def PrincipalResolution.access_token_claims(*claims: str) -> 'PrincipalResolution'
```

Try stable access-token claims in order.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `*claims` | `str` | The claims value. |

**Returns**

`'PrincipalResolution'`
: A `'PrincipalResolution'` value.

#### omp.provider.PrincipalResolution.token_response_field

```python
def PrincipalResolution.token_response_field(pointer: str) -> 'PrincipalResolution'
```

Resolve a principal from a JSON Pointer in a token response.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `pointer` | `str` | The pointer value. |

**Returns**

`'PrincipalResolution'`
: A `'PrincipalResolution'` value.

#### omp.provider.PrincipalResolution.userinfo

```python
def PrincipalResolution.userinfo(url: str, field: str) -> 'PrincipalResolution'
```

Resolve a principal from a user-information endpoint.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `url` | `str` | The absolute endpoint or result URL. |
| `field` | `str` | The field value. |

**Returns**

`'PrincipalResolution'`
: A `'PrincipalResolution'` value.

#### omp.provider.PrincipalResolution.static_label

```python
def PrincipalResolution.static_label(label: str) -> 'PrincipalResolution'
```

Use a reviewed constant principal label.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `label` | `str` | The label value. |

**Returns**

`'PrincipalResolution'`
: A `'PrincipalResolution'` value.

### omp.provider.AuthMethod

```python
class AuthMethod(StrEnum): ...
```

`AuthMethod` is the closed vocabulary for auth method values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `API_KEY` | `'api_key'` | Selects the `api_key` auth method variant. |
| `OAUTH_PKCE` | `'oauth_pkce'` | Selects the `oauth_pkce` auth method variant. |
| `OAUTH_DEVICE` | `'oauth_device'` | Selects the `oauth_device` auth method variant. |
| `OAUTH_PASTE` | `'oauth_paste'` | Selects the `oauth_paste` auth method variant. |
| `AWS_PROFILE` | `'aws_profile'` | Selects the `aws_profile` auth method variant. |
| `ADC` | `'adc'` | Selects the `adc` auth method variant. |
| `SESSION` | `'session'` | Selects the `session` auth method variant. |

### omp.provider.LoginUi

```python
class LoginUi:
```

`LoginUi` provides the public login ui behavior.

The host supplies user interaction during provider login. Dismissed prompts and selections raise `RuntimeError`.

#### omp.provider.LoginUi.prompt

```python
async def LoginUi.prompt(text: str) -> str
```

Collect a text value through the login UI.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `text` | `str` | The text input or result. |

**Returns**

`str`
: A `str` value.

**Raises**

`RuntimeError`
: Raised when an argument or host result violates the operation contract.

**Example**

```python
account = await request.ui.prompt("Account name")
```

#### omp.provider.LoginUi.select

```python
async def LoginUi.select(text: str, options: Sequence[str]) -> str
```

Collect one value from an ordered option list.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `text` | `str` | The text input or result. |
| `options` | `Sequence[str]` | Public source-specific options. |

**Returns**

`str`
: A `str` value.

**Raises**

`RuntimeError`
: Raised when an argument or host result violates the operation contract.

#### omp.provider.LoginUi.open_url

```python
async def LoginUi.open_url(url: str) -> None
```

Open an authentication URL for the user.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `url` | `str` | The absolute endpoint or result URL. |

**Returns**

`None`
: No value.

#### omp.provider.LoginUi.notify

```python
async def LoginUi.notify(text: str, level: str) -> None
```

Display a login notification.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `text` | `str` | The text input or result. |
| `level` | `str` | The level value. |

**Returns**

`None`
: No value.

### omp.provider.LoginRequest

```python
@dataclass(frozen=True, slots=True)
class LoginRequest:
    provider: str
    method: AuthMethod
    ui: LoginUi
```

`LoginRequest` carries typed login request data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `str` | — | The provider identifier. |
| `method` | `AuthMethod` | — | The HTTP or authentication method. |
| `ui` | `LoginUi` | — | The ui value. |

### omp.provider.RefreshReason

```python
class RefreshReason(StrEnum): ...
```

`RefreshReason` is the closed vocabulary for refresh reason values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `EXPIRING` | `'expiring'` | Selects the `expiring` refresh reason variant. |
| `REJECTED_401` | `'rejected_401'` | Selects the `rejected_401` refresh reason variant. |
| `MANUAL` | `'manual'` | Selects the `manual` refresh reason variant. |
| `SCHEDULED` | `'scheduled'` | Selects the `scheduled` refresh reason variant. |

### omp.provider.RefreshRequest

```python
@dataclass(frozen=True, slots=True)
class RefreshRequest:
    provider: str
    identity: str | None
    refresh_token: Secret | None
    expires_at_ms: int | None
    props: Mapping[str, int | str | bool]
    reason: RefreshReason
```

`RefreshRequest` carries typed refresh request data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `str` | — | The provider identifier. |
| `identity` | `str \| None` | — | The stable account or principal identifier. |
| `refresh_token` | `Secret \| None` | — | The callback-scoped refresh token. |
| `expires_at_ms` | `int \| None` | — | The Unix-epoch expiration time in milliseconds. |
| `props` | `Mapping[str, int \| str \| bool]` | — | Additional provider-defined public metadata. |
| `reason` | `RefreshReason` | — | The reason for a refresh, failure, or recovery choice. |

### omp.provider.Signer

```python
class Signer:
```

`Signer` provides the public signer behavior.

The protocol lets callback code request signatures while key material remains outside Python.

#### omp.provider.Signer.hmac_sha256

```python
async def Signer.hmac_sha256(message: bytes) -> bytes
```

Compute an HMAC-SHA256 digest without exposing the key.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `message` | `bytes` | A safe diagnostic message. |

**Returns**

`bytes`
: A `bytes` value.

#### omp.provider.Signer.jwt

```python
async def Signer.jwt(claims: Mapping[str, object], algorithm: str) -> str
```

Sign JWT claims with the named algorithm.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `claims` | `Mapping[str, object]` | A mapping containing claims. |
| `algorithm` | `str` | The algorithm value. |

**Returns**

`str`
: A `str` value.

#### omp.provider.Signer.attest

```python
async def Signer.attest(challenge: bytes) -> bytes
```

Answer a platform-attestation challenge.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `challenge` | `bytes` | The challenge value. |

**Returns**

`bytes`
: A `bytes` value.

### omp.provider.SignRequest

```python
@dataclass(frozen=True, slots=True)
class SignRequest:
    provider: str
    route: str
    method: str
    url: str
    headers: Mapping[str, str]
    body_sha256: bytes
    signer: Signer
```

`SignRequest` carries typed sign request data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `str` | — | The provider identifier. |
| `route` | `str` | — | The route identifier. |
| `method` | `str` | — | The HTTP or authentication method. |
| `url` | `str` | — | The absolute endpoint or result URL. |
| `headers` | `Mapping[str, str]` | — | Static request headers. |
| `body_sha256` | `bytes` | — | The request-body SHA-256 digest. |
| `signer` | `Signer` | — | A host-provided keyed signing handle. |

### omp.provider.Signature

```python
@dataclass(frozen=True, slots=True)
class Signature:
    headers: Mapping[str, str]
    query: Mapping[str, str] = _EMPTY_MAP
```

`Signature` carries typed signature data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `headers` | `Mapping[str, str]` | — | Static request headers. |
| `query` | `Mapping[str, str]` | `_EMPTY_MAP` | The query text or parameter name. |

## Model declarations and capabilities

### omp.provider.ModelSpec

```python
@dataclass(frozen=True, slots=True)
class ModelSpec:
    id: str
    display_name: str
    routes: tuple[str, ...]
    wire_ids: Mapping[str, str] = field(default_factory=lambda: _EMPTY_MAP)
    operations: frozenset[Operation] = frozenset({Operation.CHAT})
    family: str | None = None
    context_window: int | None = None
    max_input_tokens: int | None = None
    max_output_tokens: int | None = None
    max_batch: int | None = None
    input_modalities: frozenset[Modality] = frozenset({Modality.TEXT})
    thinking: ThinkingSpec | None = None
    thinking_routing: object | None = None
    cost: Cost = Cost()
    premium_multiplier: object | None = None
    compat: CompatFlags = CompatFlags()
    context: ContextSpec = ContextSpec('replay')
    availability: object | None = None
    context_promotion_target: str | None = None
    remote_compaction: object | None = None
    chat: ChatCaps = ChatCaps()
    embeddings: object | None = None
    image: ImageCaps | None = None
    video: object | None = None
    speech: SpeechCaps | None = None
    transcription: TranscriptionCaps | None = None
    realtime: RealtimeCaps | None = None
    search: object | None = None
    tokenization: object | None = None
```

`ModelSpec` carries typed model spec data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `str` | — | The stable identifier. |
| `display_name` | `str` | — | The user-facing model name. |
| `routes` | `tuple[str, ...]` | — | Route identifiers in preference order. |
| `wire_ids` | `Mapping[str, str]` | `field(default_factory=lambda: _EMPTY_MAP)` | Route-to-wire model identifiers. |
| `operations` | `frozenset[Operation]` | `frozenset({Operation.CHAT})` | The operations supported by the declaration. |
| `family` | `str \| None` | `None` | The model family. |
| `context_window` | `int \| None` | `None` | The maximum context size in tokens, if known. |
| `max_input_tokens` | `int \| None` | `None` | The upper bound for input tokens. |
| `max_output_tokens` | `int \| None` | `None` | The maximum generated tokens, if known. |
| `max_batch` | `int \| None` | `None` | The upper bound for batch. |
| `input_modalities` | `frozenset[Modality]` | `frozenset({Modality.TEXT})` | Accepted model input modalities. |
| `thinking` | `ThinkingSpec \| None` | `None` | Reasoning-control declaration. |
| `thinking_routing` | `object \| None` | `None` | The thinking routing value. |
| `cost` | `Cost` | `Cost()` | The declared price schedule. |
| `premium_multiplier` | `object \| None` | `None` | The optional premium pricing multiplier. |
| `compat` | `CompatFlags` | `CompatFlags()` | Wire-compatibility overrides. |
| `context` | `ContextSpec` | `ContextSpec('replay')` | Conversation-history delivery settings. |
| `availability` | `object \| None` | `None` | The model selection state. |
| `context_promotion_target` | `str \| None` | `None` | The context promotion target value. |
| `remote_compaction` | `object \| None` | `None` | The remote compaction value. |
| `chat` | `ChatCaps` | `ChatCaps()` | Chat capability facts. |
| `embeddings` | `object \| None` | `None` | The embeddings value. |
| `image` | `ImageCaps \| None` | `None` | Per-image pricing. |
| `video` | `object \| None` | `None` | The video value. |
| `speech` | `SpeechCaps \| None` | `None` | The speech value. |
| `transcription` | `TranscriptionCaps \| None` | `None` | The transcription value. |
| `realtime` | `RealtimeCaps \| None` | `None` | The realtime value. |
| `search` | `object \| None` | `None` | The search value. |
| `tokenization` | `object \| None` | `None` | The tokenization value. |

### omp.provider.ModelRef

```python
@dataclass(frozen=True, slots=True)
class ModelRef:
    provider: str
    api: str
    model: str
```

`ModelRef` carries typed model ref data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `str` | — | The provider identifier. |
| `api` | `str` | — | The selected codec family. |
| `model` | `str` | — | The provider model identifier. |

### omp.provider.ModelOverlay

```python
@dataclass(frozen=True, slots=True)
class ModelOverlay:
    selector: ModelRef
    added: ModelSpec | None = None
    patch: ModelPatch = ModelPatch()
```

`ModelOverlay` carries typed model overlay data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `selector` | `ModelRef` | — | The model selected by an overlay. |
| `added` | `ModelSpec \| None` | `None` | A complete model addition, if this overlay adds one. |
| `patch` | `ModelPatch` | `ModelPatch()` | Field-granular model changes. |

### omp.provider.ModelPatch

```python
@dataclass(frozen=True, slots=True)
class ModelPatch:
    class_: str | None = None
    display_name: str | None = None
    wire_ids: Mapping[str, str] | None = None
    routes: tuple[str, ...] | None = None
    capabilities: object | None = None
    limits: object | None = None
    thinking: object | None = None
    thinking_routing: object | None = None
    wire_policy: object | None = None
    context: ContextSpec | None = None
    pricing: Cost | None = None
    availability: Availability | None = None
    context_promotion_target: str | None = None
    remote_compaction: object | None = None
    premium_multiplier_millionths: int | None = None
    updated_at_ms: int | None = None
    blocked_until_ms: int | None = None
    deprecated: bool | None = None
```

`ModelPatch` carries typed model patch data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `class_` | `str \| None` | `None` | The class  value. |
| `display_name` | `str \| None` | `None` | The user-facing model name. |
| `wire_ids` | `Mapping[str, str] \| None` | `None` | Route-to-wire model identifiers. |
| `routes` | `tuple[str, ...] \| None` | `None` | Route identifiers in preference order. |
| `capabilities` | `object \| None` | `None` | The capabilities value. |
| `limits` | `object \| None` | `None` | Route-specific capability reductions. |
| `thinking` | `object \| None` | `None` | Reasoning-control declaration. |
| `thinking_routing` | `object \| None` | `None` | The thinking routing value. |
| `wire_policy` | `object \| None` | `None` | The wire policy value. |
| `context` | `ContextSpec \| None` | `None` | Conversation-history delivery settings. |
| `pricing` | `Cost \| None` | `None` | Exact resolved price components. |
| `availability` | `Availability \| None` | `None` | The model selection state. |
| `context_promotion_target` | `str \| None` | `None` | The context promotion target value. |
| `remote_compaction` | `object \| None` | `None` | The remote compaction value. |
| `premium_multiplier_millionths` | `int \| None` | `None` | The premium multiplier millionths value. |
| `updated_at_ms` | `int \| None` | `None` | The updated at ms value. |
| `blocked_until_ms` | `int \| None` | `None` | The blocked until ms value. |
| `deprecated` | `bool \| None` | `None` | Whether deprecated is enabled. |

### omp.provider.CatalogAlias

```python
@dataclass(frozen=True, slots=True)
class CatalogAlias:
    alias: str
    target: str
    rationale: str
    provenance: str
```

`CatalogAlias` carries typed catalog alias data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `alias` | `str` | — | The alias name. |
| `target` | `str` | — | The successor identity or model target. |
| `rationale` | `str` | — | The reason the alias exists. |
| `provenance` | `str` | — | The origin of the alias decision. |

### omp.provider.ScopedAlias

```python
@dataclass(frozen=True, slots=True)
class ScopedAlias:
    provider: str
    definition: CatalogAlias
```

`ScopedAlias` carries typed scoped alias data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `str` | — | The provider identifier. |
| `definition` | `CatalogAlias` | — | The scoped alias definition. |

### omp.provider.ChatCaps

```python
@dataclass(frozen=True, slots=True)
class ChatCaps:
    roles: Cap | frozenset[Role] = Cap.UNKNOWN
    mid_session_roles: Cap | frozenset[Role] = Cap.UNKNOWN
    tools: Cap | ToolCaps = Cap.UNKNOWN
    structured_output: Cap | frozenset[str] = Cap.UNKNOWN
    grammar: Cap | frozenset[str] = Cap.UNKNOWN
    text_verbosity: Cap | frozenset[str] = Cap.UNKNOWN
    reasoning: Cap | ReasoningCaps = Cap.UNKNOWN
    input_modalities: Cap | frozenset[Modality] = Cap.UNKNOWN
    hosted_tools: Cap | frozenset[HostedTool] = Cap.UNKNOWN
    prompt_caching: Cap | PromptCacheCaps = Cap.UNKNOWN
    service_tiers: Cap | tuple[ServiceTier, ...] = Cap.UNKNOWN
    sampling: Cap | frozenset[str] = Cap.UNKNOWN
    safety: Cap | frozenset[str] = Cap.UNKNOWN
    determinism: Cap | frozenset[str] = Cap.UNKNOWN
    server_state: Cap | ServerStateCaps = Cap.UNKNOWN
    logprobs: Cap | LogprobCaps = Cap.UNKNOWN
```

`ChatCaps` carries typed chat caps data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `roles` | `Cap \| frozenset[Role]` | `Cap.UNKNOWN` | The roles value. |
| `mid_session_roles` | `Cap \| frozenset[Role]` | `Cap.UNKNOWN` | The mid session roles value. |
| `tools` | `Cap \| ToolCaps` | `Cap.UNKNOWN` | Enabled tool identifiers or tool capabilities. |
| `structured_output` | `Cap \| frozenset[str]` | `Cap.UNKNOWN` | The structured output value. |
| `grammar` | `Cap \| frozenset[str]` | `Cap.UNKNOWN` | The grammar value. |
| `text_verbosity` | `Cap \| frozenset[str]` | `Cap.UNKNOWN` | The text verbosity value. |
| `reasoning` | `Cap \| ReasoningCaps` | `Cap.UNKNOWN` | Whether reasoning is supported. |
| `input_modalities` | `Cap \| frozenset[Modality]` | `Cap.UNKNOWN` | Accepted model input modalities. |
| `hosted_tools` | `Cap \| frozenset[HostedTool]` | `Cap.UNKNOWN` | The hosted tools value. |
| `prompt_caching` | `Cap \| PromptCacheCaps` | `Cap.UNKNOWN` | The prompt caching value. |
| `service_tiers` | `Cap \| tuple[ServiceTier, ...]` | `Cap.UNKNOWN` | The service tiers value. |
| `sampling` | `Cap \| frozenset[str]` | `Cap.UNKNOWN` | The sampling value. |
| `safety` | `Cap \| frozenset[str]` | `Cap.UNKNOWN` | The safety value. |
| `determinism` | `Cap \| frozenset[str]` | `Cap.UNKNOWN` | The determinism value. |
| `server_state` | `Cap \| ServerStateCaps` | `Cap.UNKNOWN` | The server state value. |
| `logprobs` | `Cap \| LogprobCaps` | `Cap.UNKNOWN` | The logprobs value. |

### omp.provider.Cap

```python
class Cap(StrEnum): ...
```

`Cap` is the closed vocabulary for cap values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `UNKNOWN` | `'unknown'` | Selects the `unknown` cap variant. |
| `UNSUPPORTED` | `'unsupported'` | Selects the `unsupported` cap variant. |

### omp.provider.ToolCaps

```python
@dataclass(frozen=True, slots=True)
class ToolCaps:
    features: frozenset[ToolFeature] = frozenset()
    maximum_tools: int | None = None
```

`ToolCaps` carries typed tool caps data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `features` | `frozenset[ToolFeature]` | `frozenset()` | Supported independent features. |
| `maximum_tools` | `int \| None` | `None` | The maximum declared tools, if bounded. |

### omp.provider.ToolFeature

```python
class ToolFeature(StrEnum): ...
```

`ToolFeature` is the closed vocabulary for tool feature values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `PARALLEL` | `'parallel'` | Selects the `parallel` tool feature variant. |
| `STRICT_SCHEMA` | `'strict_schema'` | Selects the `strict_schema` tool feature variant. |
| `NAMED_CHOICE` | `'named_choice'` | Selects the `named_choice` tool feature variant. |
| `REQUIRED_CHOICE` | `'required_choice'` | Selects the `required_choice` tool feature variant. |
| `DISABLED_CHOICE` | `'disabled_choice'` | Selects the `disabled_choice` tool feature variant. |

### omp.provider.ToolSchemaFlavor

```python
class ToolSchemaFlavor(StrEnum): ...
```

`ToolSchemaFlavor` is the closed vocabulary for tool schema flavor values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `JSON_SCHEMA` | `'json_schema'` | Selects the `json_schema` tool schema flavor variant. |
| `ANTHROPIC` | `'anthropic'` | Selects the `anthropic` tool schema flavor variant. |
| `GOOGLE` | `'google'` | Selects the `google` tool schema flavor variant. |
| `MOONSHOT_MFJS` | `'moonshot_mfjs'` | Selects the `moonshot_mfjs` tool schema flavor variant. |
| `GRAMMAR` | `'grammar'` | Selects the `grammar` tool schema flavor variant. |
| `CCA` | `'cca'` | Selects the `cca` tool schema flavor variant. |

### omp.provider.HostedTool

```python
class HostedTool(StrEnum): ...
```

`HostedTool` is the closed vocabulary for hosted tool values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `WEB_SEARCH` | `'web_search'` | Selects the `web_search` hosted tool variant. |
| `CODE_EXECUTION` | `'code_execution'` | Selects the `code_execution` hosted tool variant. |
| `RETRIEVAL` | `'retrieval'` | Selects the `retrieval` hosted tool variant. |
| `URL_CONTEXT` | `'url_context'` | Selects the `url_context` hosted tool variant. |
| `DEEP_RESEARCH` | `'deep_research'` | Selects the `deep_research` hosted tool variant. |

### omp.provider.ReasoningCaps

```python
@dataclass(frozen=True, slots=True)
class ReasoningCaps:
    features: frozenset[str] = frozenset()
    efforts: tuple[Effort, ...] = ()
    minimum_budget_tokens: int | None = None
    maximum_budget_tokens: int | None = None
```

`ReasoningCaps` carries typed reasoning caps data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `features` | `frozenset[str]` | `frozenset()` | Supported independent features. |
| `efforts` | `tuple[Effort, ...]` | `()` | Supported reasoning effort levels in order. |
| `minimum_budget_tokens` | `int \| None` | `None` | The smallest reasoning token budget. |
| `maximum_budget_tokens` | `int \| None` | `None` | The largest reasoning token budget. |

### omp.provider.ThinkingMode

```python
class ThinkingMode(StrEnum): ...
```

`ThinkingMode` is the closed vocabulary for thinking mode values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `EFFORT` | `'effort'` | Selects the `effort` thinking mode variant. |
| `BUDGET` | `'budget'` | Selects the `budget` thinking mode variant. |
| `GOOGLE_LEVEL` | `'google-level'` | Selects the `google-level` thinking mode variant. |
| `ANTHROPIC_ADAPTIVE` | `'anthropic-adaptive'` | Selects the `anthropic-adaptive` thinking mode variant. |
| `ANTHROPIC_BUDGET_EFFORT` | `'anthropic-budget-effort'` | Selects the `anthropic-budget-effort` thinking mode variant. |

### omp.provider.ThinkingSpec

```python
@dataclass(frozen=True, slots=True)
class ThinkingSpec:
    mode: ThinkingMode
    efforts: tuple[Effort, ...]
    default: Effort | None = None
    budgets: Mapping[Effort, int] = field(default_factory=lambda: _EMPTY_MAP)
    supports_display: bool | None = None
    suppress_when_off: bool | None = None
    requires_effort: bool | None = None
```

`ThinkingSpec` carries typed thinking spec data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `ThinkingMode` | — | The selected mode. |
| `efforts` | `tuple[Effort, ...]` | — | Supported reasoning effort levels in order. |
| `default` | `Effort \| None` | `None` | The default effort or value. |
| `budgets` | `Mapping[Effort, int]` | `field(default_factory=lambda: _EMPTY_MAP)` | Effort-to-token-budget mappings. |
| `supports_display` | `bool \| None` | `None` | Whether reasoning text may be shown. |
| `suppress_when_off` | `bool \| None` | `None` | Whether disabled reasoning controls are omitted. |
| `requires_effort` | `bool \| None` | `None` | Whether the wire requires an effort value. |

**Raises**

`SpecError`
: Raised when the field combination violates the value’s invariants.

### omp.provider.Effort

```python
class Effort(StrEnum): ...
```

`Effort` is the closed vocabulary for effort values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `OFF` | `'off'` | Selects the `off` effort variant. |
| `MINIMAL` | `'minimal'` | Selects the `minimal` effort variant. |
| `LOW` | `'low'` | Selects the `low` effort variant. |
| `MEDIUM` | `'medium'` | Selects the `medium` effort variant. |
| `HIGH` | `'high'` | Selects the `high` effort variant. |
| `XHIGH` | `'xhigh'` | Selects the `xhigh` effort variant. |
| `MAX` | `'max'` | Selects the `max` effort variant. |

### omp.provider.PromptCacheCaps

```python
@dataclass(frozen=True, slots=True)
class PromptCacheCaps:
    retention: frozenset[CacheRetention] = frozenset()
    min_prefix_tokens: int | None = None
    max_breakpoints: int | None = None
```

`PromptCacheCaps` carries typed prompt cache caps data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `retention` | `frozenset[CacheRetention]` | `frozenset()` | Supported prompt-cache retention classes. |
| `min_prefix_tokens` | `int \| None` | `None` | The minimum cacheable prefix length. |
| `max_breakpoints` | `int \| None` | `None` | The maximum explicit cache boundaries. |

### omp.provider.CacheRetention

```python
class CacheRetention(StrEnum): ...
```

`CacheRetention` is the closed vocabulary for cache retention values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `REQUEST` | `'request'` | Selects the `request` cache retention variant. |
| `SESSION` | `'session'` | Selects the `session` cache retention variant. |
| `SHORT` | `'short'` | Selects the `short` cache retention variant. |
| `LONG` | `'long'` | Selects the `long` cache retention variant. |

### omp.provider.ServiceTier

```python
@dataclass(frozen=True, slots=True)
class ServiceTier:
    name: str
    priority: int
```

`ServiceTier` carries typed service tier data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str` | — | The display or protocol name. |
| `priority` | `int` | — | The relative arbitration priority. |

### omp.provider.ServerStateCaps

```python
@dataclass(frozen=True, slots=True)
class ServerStateCaps:
    continuation: bool
    expiry_evidence: bool
    fork_requires_reseed: bool
```

`ServerStateCaps` carries typed server state caps data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `continuation` | `bool` | — | Whether server-side continuation is supported. |
| `expiry_evidence` | `bool` | — | Whether expiry is reported explicitly. |
| `fork_requires_reseed` | `bool` | — | Whether a fork must reseed state. |

### omp.provider.LogprobCaps

```python
@dataclass(frozen=True, slots=True)
class LogprobCaps:
    maximum_top_logprobs: int
    prompt_logprobs: bool
```

`LogprobCaps` carries typed logprob caps data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `maximum_top_logprobs` | `int` | — | The largest top-logprob count. |
| `prompt_logprobs` | `bool` | — | Whether prompt token log probabilities are available. |

### omp.provider.Role

```python
class Role(StrEnum): ...
```

`Role` is the closed vocabulary for role values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `SYSTEM` | `'system'` | Selects the `system` role variant. |
| `DEVELOPER` | `'developer'` | Selects the `developer` role variant. |
| `USER` | `'user'` | Selects the `user` role variant. |
| `ASSISTANT` | `'assistant'` | Selects the `assistant` role variant. |
| `TOOL` | `'tool'` | Selects the `tool` role variant. |

### omp.provider.Modality

```python
class Modality(StrEnum): ...
```

`Modality` is the closed vocabulary for modality values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `TEXT` | `'text'` | Selects the `text` modality variant. |
| `IMAGE` | `'image'` | Selects the `image` modality variant. |
| `AUDIO` | `'audio'` | Selects the `audio` modality variant. |
| `VIDEO` | `'video'` | Selects the `video` modality variant. |
| `DOCUMENT` | `'document'` | Selects the `document` modality variant. |

### omp.provider.ContextSpec

```python
@dataclass(frozen=True, slots=True)
class ContextSpec:
    mode: str
    retention: frozenset[CacheRetention] = frozenset()
    min_prefix_tokens: int | None = None
    max_breakpoints: int | None = None
```

`ContextSpec` carries typed context spec data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `str` | — | The selected mode. |
| `retention` | `frozenset[CacheRetention]` | `frozenset()` | Supported prompt-cache retention classes. |
| `min_prefix_tokens` | `int \| None` | `None` | The minimum cacheable prefix length. |
| `max_breakpoints` | `int \| None` | `None` | The maximum explicit cache boundaries. |

**Example**

```python
context = ContextSpec.prefix_cache(
    retention=frozenset({CacheRetention.SESSION}),
    max_breakpoints=4,
)
```

#### omp.provider.ContextSpec.replay

```python
def ContextSpec.replay() -> 'ContextSpec'
```

Create a context policy that resends canonical history.

**Returns**

`'ContextSpec'`
: A `'ContextSpec'` value.

#### omp.provider.ContextSpec.prefix_cache

```python
def ContextSpec.prefix_cache(*, retention: frozenset[CacheRetention], min_prefix_tokens: int | None = None, max_breakpoints: int | None = None) -> 'ContextSpec'
```

Create a deterministic prefix-cache policy.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `retention` | `frozenset[CacheRetention]` | Supported prompt-cache retention classes. |
| `min_prefix_tokens` | `int \| None` | The minimum cacheable prefix length. |
| `max_breakpoints` | `int \| None` | The maximum explicit cache boundaries. |

**Returns**

`'ContextSpec'`
: A `'ContextSpec'` value.

### omp.provider.Cost

```python
@dataclass(frozen=True, slots=True)
class Cost:
    input: object = 0
    output: object = 0
    cache_read: object = 0
    cache_write: object = 0
    image: object = 0
    video_second: object = 0
    audio_second: object = 0
    char_input: object = 0
    request: object = 0
    tiers: tuple[CostTier, ...] = ()
```

`Cost` carries typed cost data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `input` | `object` | `0` | Input-token pricing. |
| `output` | `object` | `0` | Output-token pricing. |
| `cache_read` | `object` | `0` | Cache-read token pricing. |
| `cache_write` | `object` | `0` | Cache-write token pricing. |
| `image` | `object` | `0` | Per-image pricing. |
| `video_second` | `object` | `0` | Per-video-second pricing. |
| `audio_second` | `object` | `0` | Per-audio-second pricing. |
| `char_input` | `object` | `0` | Character-input pricing. |
| `request` | `object` | `0` | Per-request pricing or typed request value. |
| `tiers` | `tuple[CostTier, ...]` | `()` | Threshold pricing tiers. |

#### omp.provider.Cost.free

```python
def Cost.free() -> 'Cost'
```

Create a zero-price schedule.

**Returns**

`'Cost'`
: A `'Cost'` value.

### omp.provider.CostTier

```python
@dataclass(frozen=True, slots=True)
class CostTier:
    prompt_tokens_above: int
    cost: Cost
```

`CostTier` carries typed cost tier data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `prompt_tokens_above` | `int` | — | The exclusive prompt-token threshold. |
| `cost` | `Cost` | — | The declared price schedule. |

## Images, audio, and realtime

### omp.provider.Dimensions

```python
@dataclass(frozen=True, slots=True)
class Dimensions:
    width: int
    height: int
```

`Dimensions` carries typed dimensions data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `width` | `int` | — | Raster width in pixels. |
| `height` | `int` | — | Raster height in pixels. |

**Raises**

`SpecError`
: Raised when the field combination violates the value’s invariants.

**Example**

```python
size = Dimensions(width=1024, height=1024)
```

### omp.provider.ImageFeature

```python
class ImageFeature(StrEnum): ...
```

`ImageFeature` is the closed vocabulary for image feature values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `GENERATE` | `'generate'` | Selects the `generate` image feature variant. |
| `EDIT` | `'edit'` | Selects the `edit` image feature variant. |
| `MASK` | `'mask'` | Selects the `mask` image feature variant. |
| `REFERENCE_IMAGES` | `'reference_images'` | Selects the `reference_images` image feature variant. |
| `TRANSPARENCY` | `'transparency'` | Selects the `transparency` image feature variant. |

### omp.provider.ImageFormat

```python
class ImageFormat(StrEnum): ...
```

`ImageFormat` is the closed vocabulary for image format values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `PNG` | `'png'` | Selects the `png` image format variant. |
| `JPEG` | `'jpeg'` | Selects the `jpeg` image format variant. |
| `WEBP` | `'webp'` | Selects the `webp` image format variant. |

### omp.provider.ImageCaps

```python
@dataclass(frozen=True, slots=True)
class ImageCaps:
    features: frozenset[ImageFeature]
    sizes: tuple[Dimensions, ...]
    formats: frozenset[ImageFormat]
    max_references: int | None = None
```

`ImageCaps` carries typed image caps data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `features` | `frozenset[ImageFeature]` | — | Supported independent features. |
| `sizes` | `tuple[Dimensions, ...]` | — | Supported raster dimensions. |
| `formats` | `frozenset[ImageFormat]` | — | Supported media encodings. |
| `max_references` | `int \| None` | `None` | The maximum reference images. |

### omp.provider.ImageRequest

```python
@dataclass(frozen=True, slots=True)
class ImageRequest:
    prompt: str
    dimensions: Dimensions
    format: ImageFormat
    count: int = 1
```

`ImageRequest` carries typed image request data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `prompt` | `str` | — | The user or model instruction text. |
| `dimensions` | `Dimensions` | — | The requested raster dimensions. |
| `format` | `ImageFormat` | — | The media encoding. |
| `count` | `int` | `1` | The requested result count. |

### omp.provider.ImageResult

```python
@dataclass(frozen=True, slots=True)
class ImageResult:
    images: tuple[BlobRef, ...]
    cost_nanos_usd: int
```

`ImageResult` carries typed image result data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `images` | `tuple[BlobRef, ...]` | — | Generated image blob references. |
| `cost_nanos_usd` | `int` | — | The settled operation cost in nano-USD. |

### omp.provider.AudioFormat

```python
class AudioFormat(StrEnum): ...
```

`AudioFormat` is the closed vocabulary for audio format values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `PCM16` | `'pcm16'` | Selects the `pcm16` audio format variant. |
| `PCM24` | `'pcm24'` | Selects the `pcm24` audio format variant. |
| `F32` | `'f32'` | Selects the `f32` audio format variant. |
| `MP3` | `'mp3'` | Selects the `mp3` audio format variant. |
| `AAC` | `'aac'` | Selects the `aac` audio format variant. |
| `OPUS` | `'opus'` | Selects the `opus` audio format variant. |
| `FLAC` | `'flac'` | Selects the `flac` audio format variant. |
| `WAV` | `'wav'` | Selects the `wav` audio format variant. |

### omp.provider.SpeechFeature

```python
class SpeechFeature(StrEnum): ...
```

`SpeechFeature` is the closed vocabulary for speech feature values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `STREAMING` | `'streaming'` | Selects the `streaming` speech feature variant. |
| `TIMESTAMPS` | `'timestamps'` | Selects the `timestamps` speech feature variant. |
| `SPEED` | `'speed'` | Selects the `speed` speech feature variant. |
| `VOICE_SELECTION` | `'voice_selection'` | Selects the `voice_selection` speech feature variant. |

### omp.provider.SpeechCaps

```python
@dataclass(frozen=True, slots=True)
class SpeechCaps:
    features: frozenset[SpeechFeature]
    voices: tuple[str, ...]
    formats: frozenset[AudioFormat]
    sample_rates_hz: tuple[int, ...]
```

`SpeechCaps` carries typed speech caps data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `features` | `frozenset[SpeechFeature]` | — | Supported independent features. |
| `voices` | `tuple[str, ...]` | — | Supported provider voice identifiers. |
| `formats` | `frozenset[AudioFormat]` | — | Supported media encodings. |
| `sample_rates_hz` | `tuple[int, ...]` | — | Supported audio sample rates in hertz. |

### omp.provider.SpeechRequest

```python
@dataclass(frozen=True, slots=True)
class SpeechRequest:
    model: str
    text: str
    voice: str
    format: AudioFormat | None = None
```

`SpeechRequest` carries typed speech request data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `model` | `str` | — | The provider model identifier. |
| `text` | `str` | — | The text input or result. |
| `voice` | `str` | — | The provider voice identifier. |
| `format` | `AudioFormat \| None` | `None` | The media encoding. |

### omp.provider.SpeechResult

```python
@dataclass(frozen=True, slots=True)
class SpeechResult:
    audio: BlobRef
    format: AudioFormat
    cost_nanos_usd: int
```

`SpeechResult` carries typed speech result data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `audio` | `BlobRef` | — | The audio blob or environment path. |
| `format` | `AudioFormat` | — | The media encoding. |
| `cost_nanos_usd` | `int` | — | The settled operation cost in nano-USD. |

### omp.provider.TranscriptionFeature

```python
class TranscriptionFeature(StrEnum): ...
```

`TranscriptionFeature` is the closed vocabulary for transcription feature values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `STREAMING` | `'streaming'` | Selects the `streaming` transcription feature variant. |
| `TIMESTAMPS` | `'timestamps'` | Selects the `timestamps` transcription feature variant. |
| `DIARIZATION` | `'diarization'` | Selects the `diarization` transcription feature variant. |
| `TRANSLATION` | `'translation'` | Selects the `translation` transcription feature variant. |
| `LANGUAGE_HINT` | `'language_hint'` | Selects the `language_hint` transcription feature variant. |

### omp.provider.TranscriptionCaps

```python
@dataclass(frozen=True, slots=True)
class TranscriptionCaps:
    features: frozenset[TranscriptionFeature]
    formats: frozenset[AudioFormat]
    max_duration: Duration | None
```

`TranscriptionCaps` carries typed transcription caps data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `features` | `frozenset[TranscriptionFeature]` | — | Supported independent features. |
| `formats` | `frozenset[AudioFormat]` | — | Supported media encodings. |
| `max_duration` | `Duration \| None` | — | The maximum media duration. |

### omp.provider.TranscriptionRequest

```python
@dataclass(frozen=True, slots=True)
class TranscriptionRequest:
    model: str
    audio: EnvPath | BlobRef
    language: str | None = None
```

`TranscriptionRequest` carries typed transcription request data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `model` | `str` | — | The provider model identifier. |
| `audio` | `EnvPath \| BlobRef` | — | The audio blob or environment path. |
| `language` | `str \| None` | `None` | The language tag, detected language, or `None`. |

### omp.provider.TranscriptionResult

```python
@dataclass(frozen=True, slots=True)
class TranscriptionResult:
    text: str
    language: str | None
    cost_nanos_usd: int
```

`TranscriptionResult` carries typed transcription result data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `text` | `str` | — | The text input or result. |
| `language` | `str \| None` | — | The language tag, detected language, or `None`. |
| `cost_nanos_usd` | `int` | — | The settled operation cost in nano-USD. |

### omp.provider.RealtimeFeature

```python
class RealtimeFeature(StrEnum): ...
```

`RealtimeFeature` is the closed vocabulary for realtime feature values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `AUDIO_IN` | `'audio_in'` | Selects the `audio_in` realtime feature variant. |
| `AUDIO_OUT` | `'audio_out'` | Selects the `audio_out` realtime feature variant. |
| `TEXT` | `'text'` | Selects the `text` realtime feature variant. |
| `TOOLS` | `'tools'` | Selects the `tools` realtime feature variant. |
| `SERVER_VAD` | `'server_vad'` | Selects the `server_vad` realtime feature variant. |
| `SEMANTIC_VAD` | `'semantic_vad'` | Selects the `semantic_vad` realtime feature variant. |
| `INTERRUPTION` | `'interruption'` | Selects the `interruption` realtime feature variant. |

### omp.provider.RealtimeCaps

```python
@dataclass(frozen=True, slots=True)
class RealtimeCaps:
    features: frozenset[RealtimeFeature]
    voices: tuple[str, ...]
    transports: frozenset[Transport]
```

`RealtimeCaps` carries typed realtime caps data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `features` | `frozenset[RealtimeFeature]` | — | Supported independent features. |
| `voices` | `tuple[str, ...]` | — | Supported provider voice identifiers. |
| `transports` | `frozenset[Transport]` | — | The transports values. |

### omp.provider.RealtimeModality

```python
class RealtimeModality(StrEnum): ...
```

`RealtimeModality` is the closed vocabulary for realtime modality values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `TEXT` | `'text'` | Selects the `text` realtime modality variant. |
| `AUDIO` | `'audio'` | Selects the `audio` realtime modality variant. |

### omp.provider.RealtimeEagerness

```python
class RealtimeEagerness(StrEnum): ...
```

`RealtimeEagerness` is the closed vocabulary for realtime eagerness values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `LOW` | `'low'` | Selects the `low` realtime eagerness variant. |
| `MEDIUM` | `'medium'` | Selects the `medium` realtime eagerness variant. |
| `HIGH` | `'high'` | Selects the `high` realtime eagerness variant. |
| `AUTO` | `'auto'` | Selects the `auto` realtime eagerness variant. |

### omp.provider.RealtimeTurnDetectionMode

```python
class RealtimeTurnDetectionMode(StrEnum): ...
```

`RealtimeTurnDetectionMode` is the closed vocabulary for realtime turn detection mode values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `MANUAL` | `'manual'` | Selects the `manual` realtime turn detection mode variant. |
| `SERVER_VAD` | `'server_vad'` | Selects the `server_vad` realtime turn detection mode variant. |
| `SEMANTIC_VAD` | `'semantic_vad'` | Selects the `semantic_vad` realtime turn detection mode variant. |

### omp.provider.TurnDetection

```python
@dataclass(frozen=True, slots=True)
class TurnDetection:
    mode: RealtimeTurnDetectionMode
    threshold: float | None = None
    silence_ms: int | None = None
    prefix_padding_ms: int | None = None
    eagerness: RealtimeEagerness | None = None
```

`TurnDetection` carries typed turn detection data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `RealtimeTurnDetectionMode` | — | The selected mode. |
| `threshold` | `float \| None` | `None` | The voice-activity threshold. |
| `silence_ms` | `int \| None` | `None` | Required silence in milliseconds. |
| `prefix_padding_ms` | `int \| None` | `None` | Audio retained before speech onset. |
| `eagerness` | `RealtimeEagerness \| None` | `None` | Semantic VAD responsiveness. |

### omp.provider.SettingKind

```python
class SettingKind(StrEnum): ...
```

`SettingKind` is the closed vocabulary for setting kind values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `UNSET` | `'unset'` | Selects the `unset` setting kind variant. |
| `REQUIRE` | `'require'` | Selects the `require` setting kind variant. |
| `PREFER` | `'prefer'` | Selects the `prefer` setting kind variant. |

### omp.provider.Setting

```python
@dataclass(frozen=True, slots=True)
class Setting:
    kind: SettingKind = SettingKind.UNSET
    value: _V | None = None
```

`Setting` carries typed setting data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `SettingKind` | `SettingKind.UNSET` | The typed variant discriminator. |
| `value` | `_V \| None` | `None` | The required or preferred typed value. |

**Example**

```python
audio = Setting.prefer(AudioFormat.OPUS)
```

#### omp.provider.Setting.unset

```python
def Setting.unset() -> 'Setting[_V]'
```

Create an unconstrained setting.

**Returns**

`'Setting[_V]'`
: A `'Setting[_V]'` value.

#### omp.provider.Setting.require

```python
def Setting.require(value: _V) -> 'Setting[_V]'
```

Create a setting the selected route must honor.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `value` | `_V` | The required or preferred typed value. |

**Returns**

`'Setting[_V]'`
: A `'Setting[_V]'` value.

#### omp.provider.Setting.prefer

```python
def Setting.prefer(value: _V) -> 'Setting[_V]'
```

Create a preference that negotiation may adjust.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `value` | `_V` | The required or preferred typed value. |

**Returns**

`'Setting[_V]'`
: A `'Setting[_V]'` value.

### omp.provider.EmulationPolicy

```python
class EmulationPolicy(StrEnum): ...
```

`EmulationPolicy` is the closed vocabulary for emulation policy values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `FORBID` | `'forbid'` | Selects the `forbid` emulation policy variant. |
| `ALLOW_LOSSLESS` | `'allow_lossless'` | Selects the `allow_lossless` emulation policy variant. |
| `ALLOW_DECLARED_LOSSY` | `'allow_declared_lossy'` | Selects the `allow_declared_lossy` emulation policy variant. |

### omp.provider.UnknownCapabilityPolicy

```python
class UnknownCapabilityPolicy(StrEnum): ...
```

`UnknownCapabilityPolicy` is the closed vocabulary for unknown capability policy values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `REJECT` | `'reject'` | Selects the `reject` unknown capability policy variant. |
| `ALLOW_PREFERENCES` | `'allow_preferences'` | Selects the `allow_preferences` unknown capability policy variant. |

### omp.provider.MismatchPolicy

```python
class MismatchPolicy(StrEnum): ...
```

`MismatchPolicy` is the closed vocabulary for mismatch policy values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `REJECT` | `'reject'` | Selects the `reject` mismatch policy variant. |
| `DROP_PREFERRED` | `'drop_preferred'` | Selects the `drop_preferred` mismatch policy variant. |

### omp.provider.NegotiationPolicy

```python
@dataclass(frozen=True, slots=True)
class NegotiationPolicy:
    emulation: EmulationPolicy = EmulationPolicy.FORBID
    unknown: UnknownCapabilityPolicy = UnknownCapabilityPolicy.REJECT
    vendor_option_mismatch: MismatchPolicy = MismatchPolicy.REJECT
```

`NegotiationPolicy` carries typed negotiation policy data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `emulation` | `EmulationPolicy` | `EmulationPolicy.FORBID` | Permitted capability emulation. |
| `unknown` | `UnknownCapabilityPolicy` | `UnknownCapabilityPolicy.REJECT` | Policy for unknown capabilities. |
| `vendor_option_mismatch` | `MismatchPolicy` | `MismatchPolicy.REJECT` | Policy for codec/option mismatches. |

### omp.provider.RealtimeRequest

```python
@dataclass(frozen=True, slots=True)
class RealtimeRequest:
    instructions: str | None = None
    modalities: tuple[RealtimeModality, ...] = ()
    voice: str | None = None
    input_audio: Setting[AudioFormat] = Setting()
    output_audio: Setting[AudioFormat] = Setting()
    turn_detection: Setting[TurnDetection] = Setting()
    tools: tuple[str, ...] = ()
    negotiation: NegotiationPolicy = NegotiationPolicy()
```

`RealtimeRequest` carries typed realtime request data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `instructions` | `str \| None` | `None` | The instructions value. |
| `modalities` | `tuple[RealtimeModality, ...]` | `()` | Enabled realtime modalities. |
| `voice` | `str \| None` | `None` | The provider voice identifier. |
| `input_audio` | `Setting[AudioFormat]` | `Setting()` | Input-audio requirement or preference. |
| `output_audio` | `Setting[AudioFormat]` | `Setting()` | Output-audio requirement or preference. |
| `turn_detection` | `Setting[TurnDetection]` | `Setting()` | Turn-boundary settings. |
| `tools` | `tuple[str, ...]` | `()` | Enabled tool identifiers or tool capabilities. |
| `negotiation` | `NegotiationPolicy` | `NegotiationPolicy()` | Realtime negotiation policy. |

### omp.provider.RealtimeEndpointRef

```python
@dataclass(frozen=True, slots=True)
class RealtimeEndpointRef:
    id: str
```

`RealtimeEndpointRef` carries typed realtime endpoint ref data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `str` | — | The stable identifier. |

### omp.provider.RealtimeCredentialRef

```python
@dataclass(frozen=True, slots=True)
class RealtimeCredentialRef:
    id: str
```

`RealtimeCredentialRef` carries typed realtime credential ref data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `str` | — | The stable identifier. |

### omp.provider.RealtimeSession

```python
@dataclass(frozen=True, slots=True)
class RealtimeSession:
    id: str
    endpoint: RealtimeEndpointRef
    credential: RealtimeCredentialRef
    expires_at_ms: int
    transport: Transport
```

`RealtimeSession` carries typed realtime session data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `str` | — | The stable identifier. |
| `endpoint` | `RealtimeEndpointRef` | — | The opaque realtime endpoint reference. |
| `credential` | `RealtimeCredentialRef` | — | The opaque credential reference or returned credential. |
| `expires_at_ms` | `int` | — | The Unix-epoch expiration time in milliseconds. |
| `transport` | `Transport` | — | The request transport. |

## Resolved catalog and streaming

### omp.provider.Facet

```python
class Facet(StrEnum): ...
```

`Facet` is the closed vocabulary for facet values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `CHAT` | `'chat'` | Selects the `chat` facet variant. |
| `EMBED` | `'embed'` | Selects the `embed` facet variant. |
| `IMAGE_GEN` | `'image_gen'` | Selects the `image_gen` facet variant. |
| `VIDEO_GEN` | `'video_gen'` | Selects the `video_gen` facet variant. |
| `SPEAK` | `'speak'` | Selects the `speak` facet variant. |
| `TRANSCRIBE` | `'transcribe'` | Selects the `transcribe` facet variant. |
| `REALTIME` | `'realtime'` | Selects the `realtime` facet variant. |
| `SEARCH` | `'search'` | Selects the `search` facet variant. |

### omp.provider.PriceUnit

```python
class PriceUnit(StrEnum): ...
```

`PriceUnit` is the closed vocabulary for price unit values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `MTOK_INPUT` | `'mtok_input'` | Selects the `mtok_input` price unit variant. |
| `MTOK_OUTPUT` | `'mtok_output'` | Selects the `mtok_output` price unit variant. |
| `MTOK_CACHE_READ` | `'mtok_cache_read'` | Selects the `mtok_cache_read` price unit variant. |
| `MTOK_CACHE_WRITE` | `'mtok_cache_write'` | Selects the `mtok_cache_write` price unit variant. |
| `IMAGE` | `'image'` | Selects the `image` price unit variant. |
| `VIDEO_SECOND` | `'video_second'` | Selects the `video_second` price unit variant. |
| `AUDIO_SECOND` | `'audio_second'` | Selects the `audio_second` price unit variant. |
| `MCHAR_INPUT` | `'mchar_input'` | Selects the `mchar_input` price unit variant. |
| `REQUEST` | `'request'` | Selects the `request` price unit variant. |

### omp.provider.Price

```python
@dataclass(frozen=True, slots=True)
class Price:
    unit: PriceUnit
    nanos_usd: int
```

`Price` carries typed price data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `unit` | `PriceUnit` | — | The measurement or billing unit. |
| `nanos_usd` | `int` | — | The nanos usd value. |

### omp.provider.Availability

```python
class Availability(StrEnum): ...
```

`Availability` is the closed vocabulary for availability values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `UNSPECIFIED` | `'unspecified'` | Selects the `unspecified` availability variant. |
| `AVAILABLE` | `'available'` | Selects the `available` availability variant. |
| `LOGIN_REQUIRED` | `'login_required'` | Selects the `login_required` availability variant. |
| `BLOCKED` | `'blocked'` | Selects the `blocked` availability variant. |
| `DISABLED` | `'disabled'` | Selects the `disabled` availability variant. |

### omp.provider.ModelCard

```python
@dataclass(frozen=True, slots=True)
class ModelCard:
    id: str
    provider: str
    model: str
    name: str
    family: str | None = None
    facets: frozenset[Facet] = frozenset()
    inputs: frozenset[Modality] = frozenset()
    outputs: frozenset[Modality] = frozenset()
    reasoning: bool = False
    efforts: tuple[Effort, ...] = ()
    context_window: int | None = None
    max_output_tokens: int | None = None
    pricing: tuple[Price, ...] = ()
    availability: Availability = Availability.UNSPECIFIED
    source: Source = Source.UNSPECIFIED
    blocked_until_ms: int | None = None
    deprecated: bool = False
    updated_at_ms: int | None = None
    supports_tools: bool | None = None
    props: Mapping[str, object] = field(default_factory=lambda: _EMPTY_MAP)
```

`ModelCard` carries typed model card data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `str` | — | The stable identifier. |
| `provider` | `str` | — | The provider identifier. |
| `model` | `str` | — | The provider model identifier. |
| `name` | `str` | — | The display or protocol name. |
| `family` | `str \| None` | `None` | The model family. |
| `facets` | `frozenset[Facet]` | `frozenset()` | The inference facets exposed by the model. |
| `inputs` | `frozenset[Modality]` | `frozenset()` | Accepted input modalities. |
| `outputs` | `frozenset[Modality]` | `frozenset()` | Produced output modalities. |
| `reasoning` | `bool` | `False` | Whether reasoning is supported. |
| `efforts` | `tuple[Effort, ...]` | `()` | Supported reasoning effort levels in order. |
| `context_window` | `int \| None` | `None` | The maximum context size in tokens, if known. |
| `max_output_tokens` | `int \| None` | `None` | The maximum generated tokens, if known. |
| `pricing` | `tuple[Price, ...]` | `()` | Exact resolved price components. |
| `availability` | `Availability` | `Availability.UNSPECIFIED` | The model selection state. |
| `source` | `Source` | `Source.UNSPECIFIED` | The catalog layer that supplied the model. |
| `blocked_until_ms` | `int \| None` | `None` | The blocked until ms value. |
| `deprecated` | `bool` | `False` | Whether deprecated is enabled. |
| `updated_at_ms` | `int \| None` | `None` | The updated at ms value. |
| `supports_tools` | `bool \| None` | `None` | Whether supports tools is enabled. |
| `props` | `Mapping[str, object]` | `field(default_factory=lambda: _EMPTY_MAP)` | Additional provider-defined public metadata. |

#### omp.provider.ModelCard.Source

```python
class Source(IntEnum): ...
```

Identifies the catalog layer that contributed the resolved card.

| Member | Value | Meaning |
|---|---:|---|
| `UNSPECIFIED` | `0` | Marks the card as `u n s p e c i f i e d` provenance. |
| `BUNDLED` | `1` | Marks the card as `b u n d l e d` provenance. |
| `DISCOVERED` | `2` | Marks the card as `d i s c o v e r e d` provenance. |
| `CONFIGURED` | `3` | Marks the card as `c o n f i g u r e d` provenance. |
| `EXTENSION` | `4` | Marks the card as `e x t e n s i o n` provenance. |

### omp.provider.Cursor

```python
@dataclass(frozen=True, slots=True)
class Cursor:
    epoch: bytes
    generation: int
```

`Cursor` carries typed cursor data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `epoch` | `bytes` | — | The opaque catalog epoch. |
| `generation` | `int` | — | The monotonic position within the epoch. |

### omp.provider.ModelEvent

```python
@dataclass(frozen=True, slots=True)
class ModelEvent:
    cursor: Cursor
    upserted: ModelCard | None = None
    removed_id: str | None = None
    reset: bool = False
```

`ModelEvent` carries typed model event data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `cursor` | `Cursor` | — | The pagination or catalog-resume cursor. |
| `upserted` | `ModelCard \| None` | `None` | A card to add or replace. |
| `removed_id` | `str \| None` | `None` | The identifier of a card to remove. |
| `reset` | `bool` | `False` | Whether consumers must rebuild derived catalog state. |

**Raises**

`ValueError`
: Raised when the field combination violates the value’s invariants.

### omp.provider.WatchModels

```python
WatchModels(since: Cursor | None = None)
```

`WatchModels` provides the public watch models behavior.

Iterate it directly or call `events()`; both open the host-fed catalog delta stream.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `since` | `Cursor \| None` | The since value. |

**Raises**

`TypeError`
: Raised when an argument or host result violates the operation contract.

**Example**

```python
subscription = WatchModels(since=last_cursor)
async for event in subscription:
    apply(event)
```

#### omp.provider.WatchModels.events

```python
def WatchModels.events() -> AsyncIterator[ModelEvent]
```

Open the ordered model-catalog event iterator.

**Returns**

`AsyncIterator[ModelEvent]`
: An asynchronous iterator over ordered events.

### omp.provider.models

```python
async def models() -> tuple[ModelCard, ...]
```

Read the host’s complete resolved model catalog.

Cards include bundled, discovered, configured, and extension contributions after resolution. The host result must be an iterable of model cards.

**Returns**

`tuple[ModelCard, ...]`
: An immutable tuple of results.

**Raises**

`TypeError`
: Raised when an argument or host result violates the operation contract.

**Example**

```python
cards = await models()
chat_ids = [card.id for card in cards if Facet.CHAT in card.facets]
```

### omp.provider.watch_models

```python
def watch_models(since: Cursor | None = None) -> WatchModels
```

Create a resumable subscription to merged model-catalog changes.

The returned object is both a subscription handle and an async iterable. Pass a prior cursor to resume.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `since` | `Cursor \| None` | The since value. |

**Returns**

`WatchModels`
: A `WatchModels` value.

**Example**

```python
async for event in watch_models():
    update_catalog(event)
```

## Errors and recovery

### omp.provider.RouteRef

```python
@dataclass(frozen=True, slots=True)
class RouteRef:
    provider: str
    route: str
```

`RouteRef` carries typed route ref data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `str` | — | The provider identifier. |
| `route` | `str` | — | The route identifier. |

### omp.provider.ErrorKind

```python
class ErrorKind(StrEnum): ...
```

`ErrorKind` is the closed vocabulary for error kind values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `CANCELLED` | `'cancelled'` | Selects the `cancelled` error kind variant. |
| `DEADLINE_EXCEEDED` | `'deadline_exceeded'` | Selects the `deadline_exceeded` error kind variant. |
| `BUDGET_EXHAUSTED` | `'budget_exhausted'` | Selects the `budget_exhausted` error kind variant. |
| `POLICY_BUFFER_EXCEEDED` | `'policy_buffer_exceeded'` | Selects the `policy_buffer_exceeded` error kind variant. |
| `DNS` | `'dns'` | Selects the `dns` error kind variant. |
| `TLS` | `'tls'` | Selects the `tls` error kind variant. |
| `CONNECTIVITY` | `'connectivity'` | Selects the `connectivity` error kind variant. |
| `PROTOCOL` | `'protocol'` | Selects the `protocol` error kind variant. |
| `STREAM_CORRUPTION` | `'stream_corruption'` | Selects the `stream_corruption` error kind variant. |
| `AUTHENTICATION` | `'authentication'` | Selects the `authentication` error kind variant. |
| `CREDENTIAL_STORAGE_UNAVAILABLE` | `'credential_storage_unavailable'` | Selects the `credential_storage_unavailable` error kind variant. |
| `AUTHORIZATION` | `'authorization'` | Selects the `authorization` error kind variant. |
| `ACCOUNT_DISABLED` | `'account_disabled'` | Selects the `account_disabled` error kind variant. |
| `RATE_LIMITED` | `'rate_limited'` | Selects the `rate_limited` error kind variant. |
| `QUOTA_EXHAUSTED` | `'quota_exhausted'` | Selects the `quota_exhausted` error kind variant. |
| `PAYMENT_REQUIRED` | `'payment_required'` | Selects the `payment_required` error kind variant. |
| `INVALID_REQUEST` | `'invalid_request'` | Selects the `invalid_request` error kind variant. |
| `TARGET_NOT_FOUND` | `'target_not_found'` | Selects the `target_not_found` error kind variant. |
| `CAPABILITY_UNKNOWN` | `'capability_unknown'` | Selects the `capability_unknown` error kind variant. |
| `CODEC_MISMATCH` | `'codec_mismatch'` | Selects the `codec_mismatch` error kind variant. |
| `ROUTE_UNAVAILABLE` | `'route_unavailable'` | Selects the `route_unavailable` error kind variant. |
| `STALE_PLAN` | `'stale_plan'` | Selects the `stale_plan` error kind variant. |
| `REPLAY_REQUIRED` | `'replay_required'` | Selects the `replay_required` error kind variant. |
| `STAGING_REQUIRED` | `'staging_required'` | Selects the `staging_required` error kind variant. |
| `CAPABILITY_MISMATCH` | `'capability_mismatch'` | Selects the `capability_mismatch` error kind variant. |
| `PROVIDER_CONTRACT_MISMATCH` | `'provider_contract_mismatch'` | Selects the `provider_contract_mismatch` error kind variant. |
| `CONTEXT_OVERFLOW` | `'context_overflow'` | Selects the `context_overflow` error kind variant. |
| `CONTENT_FILTER` | `'content_filter'` | Selects the `content_filter` error kind variant. |
| `SAFETY_REFUSAL` | `'safety_refusal'` | Selects the `safety_refusal` error kind variant. |
| `MALFORMED_MODEL_OUTPUT` | `'malformed_model_output'` | Selects the `malformed_model_output` error kind variant. |
| `STRUCTURED_OUTPUT_FAILURE` | `'structured_output_failure'` | Selects the `structured_output_failure` error kind variant. |
| `TOOL_NON_COMPLIANCE` | `'tool_non_compliance'` | Selects the `tool_non_compliance` error kind variant. |
| `REPEATED_REASONING` | `'repeated_reasoning'` | Selects the `repeated_reasoning` error kind variant. |
| `REPEATED_TOOL_CALL` | `'repeated_tool_call'` | Selects the `repeated_tool_call` error kind variant. |
| `EMPTY_COMPLETION` | `'empty_completion'` | Selects the `empty_completion` error kind variant. |
| `EMPTY_OUTPUT` | `'empty_output'` | Selects the `empty_output` error kind variant. |
| `SESSION_EXPIRED` | `'session_expired'` | Selects the `session_expired` error kind variant. |
| `SESSION_CONFLICT` | `'session_conflict'` | Selects the `session_conflict` error kind variant. |
| `LOCAL_MODEL_UNAVAILABLE` | `'local_model_unavailable'` | Selects the `local_model_unavailable` error kind variant. |
| `RESOURCE_EXHAUSTED` | `'resource_exhausted'` | Selects the `resource_exhausted` error kind variant. |
| `NATIVE_REQUEST_REJECTED` | `'native_request_rejected'` | Selects the `native_request_rejected` error kind variant. |
| `INTERNAL_INVARIANT` | `'internal_invariant'` | Selects the `internal_invariant` error kind variant. |

### omp.provider.Retryability

```python
class Retryability(StrEnum): ...
```

`Retryability` is the closed vocabulary for retryability values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `NEVER` | `'never'` | Selects the `never` retryability variant. |
| `SAME_ROUTE` | `'same_route'` | Selects the `same_route` retryability variant. |
| `AFTER_REPAIR` | `'after_repair'` | Selects the `after_repair` retryability variant. |
| `AFTER_CREDENTIAL` | `'after_credential'` | Selects the `after_credential` retryability variant. |
| `AFTER_DELAY` | `'after_delay'` | Selects the `after_delay` retryability variant. |
| `UNSPECIFIED` | `'unspecified'` | Selects the `unspecified` retryability variant. |

### omp.provider.ProviderError

```python
@dataclass(frozen=True, slots=True)
class ProviderError:
    provider: str
    route: str
    model: str
    operation: Operation
    kind: ErrorKind
    retryability: Retryability
    status: int | None
    retry_after: Duration | None
    attempt: int
    committed: bool
    message: str
    identity: str | None
```

`ProviderError` carries typed provider error data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `str` | — | The provider identifier. |
| `route` | `str` | — | The route identifier. |
| `model` | `str` | — | The provider model identifier. |
| `operation` | `Operation` | — | The requested provider operation. |
| `kind` | `ErrorKind` | — | The typed variant discriminator. |
| `retryability` | `Retryability` | — | The safe recovery lane. |
| `status` | `int \| None` | — | The HTTP status, if available. |
| `retry_after` | `Duration \| None` | — | The provider-supplied retry delay. |
| `attempt` | `int` | — | The one-based attempt number. |
| `committed` | `bool` | — | Whether response output was already committed. |
| `message` | `str` | — | A safe diagnostic message. |
| `identity` | `str \| None` | — | The stable account or principal identifier. |

### omp.provider.FailoverKind

```python
class FailoverKind(StrEnum): ...
```

`FailoverKind` is the closed vocabulary for failover kind values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `RETRY` | `'retry'` | Selects the `retry` failover kind variant. |
| `REFRESH_CREDENTIAL` | `'refresh_credential'` | Selects the `refresh_credential` failover kind variant. |
| `ROTATE_ACCOUNT` | `'rotate_account'` | Selects the `rotate_account` failover kind variant. |
| `RESELECT_ROUTE` | `'reselect_route'` | Selects the `reselect_route` failover kind variant. |
| `SWITCH_MODEL` | `'switch_model'` | Selects the `switch_model` failover kind variant. |
| `RESEED_SESSION` | `'reseed_session'` | Selects the `reseed_session` failover kind variant. |
| `SEMANTIC_RETRY` | `'semantic_retry'` | Selects the `semantic_retry` failover kind variant. |
| `FAIL` | `'fail'` | Selects the `fail` failover kind variant. |

### omp.provider.Failover

```python
@dataclass(frozen=True, slots=True)
class Failover:
    kind: FailoverKind
    after: Duration | None = None
    cooldown: Duration | None = None
    route: str | None = None
    target: str | None = None
    reason: str | None = None
```

`Failover` carries typed failover data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `FailoverKind` | — | The typed variant discriminator. |
| `after` | `Duration \| None` | `None` | The retry delay. |
| `cooldown` | `Duration \| None` | `None` | The account, route, or model cooldown. |
| `route` | `str \| None` | `None` | The route identifier. |
| `target` | `str \| None` | `None` | The successor identity or model target. |
| `reason` | `str \| None` | `None` | The reason for a refresh, failure, or recovery choice. |

**Example**

```python
return Failover.reselect_route(cooldown=Duration("2s"))
```

#### omp.provider.Failover.retry

```python
def Failover.retry(*, after: Duration | None = None, cooldown: Duration | None = None) -> Failover
```

Choose another attempt on the same route.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `after` | `Duration \| None` | The retry delay. |
| `cooldown` | `Duration \| None` | The account, route, or model cooldown. |

**Returns**

`Failover`
: A `Failover` value.

#### omp.provider.Failover.refresh_credential

```python
def Failover.refresh_credential() -> Failover
```

Refresh the current credential before retrying.

**Returns**

`Failover`
: A `Failover` value.

#### omp.provider.Failover.rotate_account

```python
def Failover.rotate_account(successor: str, *, cooldown: Duration | None = None) -> Failover
```

Move recovery to a named successor identity.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `successor` | `str` | The successor value. |
| `cooldown` | `Duration \| None` | The account, route, or model cooldown. |

**Returns**

`Failover`
: A `Failover` value.

**Raises**

`ValueError`
: Raised when an argument or host result violates the operation contract.

#### omp.provider.Failover.reselect_route

```python
def Failover.reselect_route(*, route: str | None = None, cooldown: Duration | None = None) -> Failover
```

Ask selection to choose a route again.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `route` | `str \| None` | The route identifier. |
| `cooldown` | `Duration \| None` | The account, route, or model cooldown. |

**Returns**

`Failover`
: A `Failover` value.

#### omp.provider.Failover.switch_model

```python
def Failover.switch_model(target: str, *, cooldown: Duration | None = None) -> Failover
```

Move recovery to a fully qualified model target.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `target` | `str` | The successor identity or model target. |
| `cooldown` | `Duration \| None` | The account, route, or model cooldown. |

**Returns**

`Failover`
: A `Failover` value.

#### omp.provider.Failover.reseed_session

```python
def Failover.reseed_session() -> Failover
```

Rebuild provider-side session state.

**Returns**

`Failover`
: A `Failover` value.

#### omp.provider.Failover.semantic_retry

```python
def Failover.semantic_retry() -> Failover
```

Enter the bounded semantic-repair lane.

**Returns**

`Failover`
: A `Failover` value.

#### omp.provider.Failover.fail

```python
def Failover.fail(reason: str | None = None) -> Failover
```

Stop recovery, optionally recording a reason.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `reason` | `str \| None` | The reason for a refresh, failure, or recovery choice. |

**Returns**

`Failover`
: A `Failover` value.

### omp.provider.ModelFallback

```python
class ModelFallback(StrEnum): ...
```

`ModelFallback` is the closed vocabulary for model fallback values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `DENY` | `'deny'` | Selects the `deny` model fallback variant. |
| `PARENT` | `'parent'` | Selects the `parent` model fallback variant. |
| `CHAIN` | `'chain'` | Selects the `chain` model fallback variant. |

## Intents and request mutation

### omp.provider.Fallback

```python
class Fallback(StrEnum): ...
```

`Fallback` is the closed vocabulary for fallback values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `UNSPECIFIED` | `'unspecified'` | Selects the `unspecified` fallback variant. |
| `ERROR` | `'error'` | Selects the `error` fallback variant. |
| `IGNORE` | `'ignore'` | Selects the `ignore` fallback variant. |
| `EMULATE` | `'emulate'` | Selects the `emulate` fallback variant. |

### omp.provider.IntentKind

```python
class IntentKind(StrEnum): ...
```

`IntentKind` is the closed vocabulary for intent kind values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `STRICT` | `'strict'` | Selects the `strict` intent kind variant. |
| `GRAMMAR` | `'grammar'` | Selects the `grammar` intent kind variant. |
| `FORCE_CALL` | `'force_call'` | Selects the `force_call` intent kind variant. |
| `SERVICE_TIER` | `'service_tier'` | Selects the `service_tier` intent kind variant. |
| `VERBOSITY` | `'verbosity'` | Selects the `verbosity` intent kind variant. |
| `CACHE_RETENTION` | `'cache_retention'` | Selects the `cache_retention` intent kind variant. |
| `REASONING` | `'reasoning'` | Selects the `reasoning` intent kind variant. |
| `SAFETY` | `'safety'` | Selects the `safety` intent kind variant. |
| `DETERMINISM` | `'determinism'` | Selects the `determinism` intent kind variant. |
| `HOSTED_TOOL` | `'hosted_tool'` | Selects the `hosted_tool` intent kind variant. |

### omp.provider.Intent

```python
@dataclass(frozen=True, slots=True)
class Intent:
    kind: IntentKind
    on_unsupported: Fallback = Fallback.UNSPECIFIED
    priority: int = 0
    payload: object = None
```

`Intent` carries typed intent data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `IntentKind` | — | The typed variant discriminator. |
| `on_unsupported` | `Fallback` | `Fallback.UNSPECIFIED` | The action to take when the capability is unavailable. |
| `priority` | `int` | `0` | The relative arbitration priority. |
| `payload` | `object` | `None` | Capability-specific intent data. |

### omp.provider.intents

```python
intents: _Intents
```

`intents` is the process-wide namespace for this extension’s keyed capability requests.

Mutations are queued for host arbitration; accepted state is not mirrored speculatively in Python.

**Example**

```python
intents.set(
    "strict-output",
    Intent(IntentKind.STRICT, on_unsupported=Fallback.ERROR, priority=10),
)
```

#### omp.provider.intents.set

```python
def intents.set(key: str, /, *values: Intent) -> None
```

Replace one keyed intent contribution.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `key` | `str` | The key value. |
| `*values` | `Intent` | Candidate claim fields or static values. |

**Returns**

`None`
: No value.

#### omp.provider.intents.clear

```python
def intents.clear(key: str, /) -> None
```

Remove one keyed intent contribution.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `key` | `str` | The key value. |

**Returns**

`None`
: No value.

#### omp.provider.intents.declared

```python
def intents.declared(key: str | None = None, /) -> tuple[Intent, ...]
```

Return no speculative host state; the result is always empty.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `key` | `str \| None` | The key value. |

**Returns**

`tuple[Intent, ...]`
: An immutable tuple of results.

### omp.provider.RequestDraft

```python
@dataclass(frozen=True, slots=True)
class RequestDraft:
    provider: str
    route: str
    model: str
    operation: Operation
    scalars: Mapping[str, int | float | str | bool]
    headers: Mapping[str, str]
    intents: tuple[Intent, ...]
    message_count: int
    approx_prompt_tokens: int | None
```

`RequestDraft` carries typed request draft data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `str` | — | The provider identifier. |
| `route` | `str` | — | The route identifier. |
| `model` | `str` | — | The provider model identifier. |
| `operation` | `Operation` | — | The requested provider operation. |
| `scalars` | `Mapping[str, int \| float \| str \| bool]` | — | Bounded scalar request metadata. |
| `headers` | `Mapping[str, str]` | — | Static request headers. |
| `intents` | `tuple[Intent, ...]` | — | Negotiated capability requests. |
| `message_count` | `int` | — | The number of canonical messages. |
| `approx_prompt_tokens` | `int \| None` | — | The estimated prompt-token count, if available. |

### omp.provider.RequestMutation

```python
@dataclass(frozen=True, slots=True)
class RequestMutation:
    body: Mapping[str, object] = _EMPTY_MAP
    headers: Mapping[str, str | None] = _EMPTY_MAP
    timeout: Duration | None = None
```

`RequestMutation` carries typed request mutation data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `body` | `Mapping[str, object]` | `_EMPTY_MAP` | Shallow body keys to merge. |
| `headers` | `Mapping[str, str \| None]` | `_EMPTY_MAP` | Static request headers. |
| `timeout` | `Duration \| None` | `None` | The requested request timeout. |

## Discovery, search, and usage

### omp.provider.DiscoveryKind

```python
class DiscoveryKind(StrEnum): ...
```

`DiscoveryKind` is the closed vocabulary for discovery kind values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `OPENAI_MODELS` | `'openai_models'` | Selects the `openai_models` discovery kind variant. |
| `GOOGLE_MODELS` | `'google_models'` | Selects the `google_models` discovery kind variant. |
| `OLLAMA_TAGS` | `'ollama_tags'` | Selects the `ollama_tags` discovery kind variant. |
| `ACCOUNT_MODELS` | `'account_models'` | Selects the `account_models` discovery kind variant. |
| `SPECIALIZED` | `'specialized'` | Selects the `specialized` discovery kind variant. |

### omp.provider.Pagination

```python
@dataclass(frozen=True, slots=True)
class Pagination:
    kind: str
    query_parameter: str | None = None
    first_page: int | None = None
```

`Pagination` carries typed pagination data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `str` | — | The typed variant discriminator. |
| `query_parameter` | `str \| None` | `None` | The query parameter value. |
| `first_page` | `int \| None` | `None` | The first page value. |

#### omp.provider.Pagination.single_page

```python
def Pagination.single_page() -> 'Pagination'
```

Create a policy in which the first response is complete.

**Returns**

`'Pagination'`
: A `'Pagination'` value.

#### omp.provider.Pagination.cursor

```python
def Pagination.cursor(query_parameter: str) -> 'Pagination'
```

Create cursor-based pagination.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `query_parameter` | `str` | The query parameter value. |

**Returns**

`'Pagination'`
: A `'Pagination'` value.

#### omp.provider.Pagination.page_number

```python
def Pagination.page_number(query_parameter: str, *, first_page: int = 1) -> 'Pagination'
```

Create increasing page-number pagination.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `query_parameter` | `str` | The query parameter value. |
| `first_page` | `int` | The first page value. |

**Returns**

`'Pagination'`
: A `'Pagination'` value.

### omp.provider.DiscoverySpec

```python
@dataclass(frozen=True, slots=True)
class DiscoverySpec:
    kind: DiscoveryKind
    path: str
    label: str
    pagination: Pagination = Pagination.single_page()
    authoritative: bool = False
    interval: Duration | None = None
```

`DiscoverySpec` carries typed discovery spec data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `DiscoveryKind` | — | The typed variant discriminator. |
| `path` | `str` | — | The path value. |
| `label` | `str` | — | The label value. |
| `pagination` | `Pagination` | `Pagination.single_page()` | The pagination value. |
| `authoritative` | `bool` | `False` | Whether omitted prior rows should be retired. |
| `interval` | `Duration \| None` | `None` | The interval value. |

**Raises**

`SpecError`
: Raised when the field combination violates the value’s invariants.

### omp.provider.DiscoveryDefaults

```python
@dataclass(frozen=True, slots=True)
class DiscoveryDefaults:
    routes: tuple[str, ...]
    cost: Cost = Cost.free()
    context_window: int | None = None
    max_output_tokens: int | None = None
    operations: frozenset[Operation] = frozenset({Operation.CHAT})
    availability: Availability = Availability.AVAILABLE
    confidence: Confidence = Confidence.INFERRED
```

`DiscoveryDefaults` carries typed discovery defaults data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `routes` | `tuple[str, ...]` | — | Route identifiers in preference order. |
| `cost` | `Cost` | `Cost.free()` | The declared price schedule. |
| `context_window` | `int \| None` | `None` | The maximum context size in tokens, if known. |
| `max_output_tokens` | `int \| None` | `None` | The maximum generated tokens, if known. |
| `operations` | `frozenset[Operation]` | `frozenset({Operation.CHAT})` | The operations supported by the declaration. |
| `availability` | `Availability` | `Availability.AVAILABLE` | The model selection state. |
| `confidence` | `Confidence` | `Confidence.INFERRED` | The evidence quality for discovered facts. |

### omp.provider.Confidence

```python
class Confidence(StrEnum): ...
```

`Confidence` is the closed vocabulary for confidence values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `VERIFIED` | `'verified'` | Selects the `verified` confidence variant. |
| `DECLARED` | `'declared'` | Selects the `declared` confidence variant. |
| `INFERRED` | `'inferred'` | Selects the `inferred` confidence variant. |
| `UNKNOWN` | `'unknown'` | Selects the `unknown` confidence variant. |

### omp.provider.DiscoveryTrigger

```python
class DiscoveryTrigger(StrEnum): ...
```

`DiscoveryTrigger` is the closed vocabulary for discovery trigger values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `SESSION_START` | `'session_start'` | Selects the `session_start` discovery trigger variant. |
| `INTERVAL` | `'interval'` | Selects the `interval` discovery trigger variant. |
| `MANUAL` | `'manual'` | Selects the `manual` discovery trigger variant. |
| `POST_LOGIN` | `'post_login'` | Selects the `post_login` discovery trigger variant. |

### omp.provider.DiscoveryQuery

```python
@dataclass(frozen=True, slots=True)
class DiscoveryQuery:
    provider: str
    route: str
    cursor: str | None
    page_size: int | None
    trigger: DiscoveryTrigger
```

`DiscoveryQuery` carries typed discovery query data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `str` | — | The provider identifier. |
| `route` | `str` | — | The route identifier. |
| `cursor` | `str \| None` | — | The pagination or catalog-resume cursor. |
| `page_size` | `int \| None` | — | The requested discovery page size. |
| `trigger` | `DiscoveryTrigger` | — | The reason discovery ran. |

### omp.provider.DiscoveryPage

```python
@dataclass(frozen=True, slots=True)
class DiscoveryPage:
    models: tuple[ModelSpec, ...]
    next_cursor: str | None = None
    authoritative: bool = False
```

`DiscoveryPage` carries typed discovery page data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `models` | `tuple[ModelSpec, ...]` | — | Model declarations returned by the operation. |
| `next_cursor` | `str \| None` | `None` | The cursor for the next page, or `None` at the end. |
| `authoritative` | `bool` | `False` | Whether omitted prior rows should be retired. |

### omp.provider.SearchQuery

```python
@dataclass(frozen=True, slots=True)
class SearchQuery:
    provider: str
    query: str
    count: int
    offset: int | None = None
```

`SearchQuery` carries typed search query data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `str` | — | The provider identifier. |
| `query` | `str` | — | The query text or parameter name. |
| `count` | `int` | — | The requested result count. |
| `offset` | `int \| None` | `None` | The offset value. |

### omp.provider.SearchResult

```python
@dataclass(frozen=True, slots=True)
class SearchResult:
    title: str
    url: str
    snippet: str
    rank: int
```

`SearchResult` carries typed search result data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `title` | `str` | — | The title value. |
| `url` | `str` | — | The absolute endpoint or result URL. |
| `snippet` | `str` | — | A short result excerpt. |
| `rank` | `int` | — | The result rank. |

### omp.provider.SearchPage

```python
@dataclass(frozen=True, slots=True)
class SearchPage:
    results: tuple[SearchResult, ...]
    next_offset: int | None = None
```

`SearchPage` carries typed search page data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `results` | `tuple[SearchResult, ...]` | — | Normalized ranked search results. |
| `next_offset` | `int \| None` | `None` | The next offset value. |

### omp.provider.UsageScope

```python
class UsageScope(StrEnum): ...
```

`UsageScope` is the closed vocabulary for usage scope values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `CURRENT` | `'current'` | Selects the `current` usage scope variant. |
| `BILLING` | `'billing'` | Selects the `billing` usage scope variant. |
| `RATE_LIMIT` | `'rate_limit'` | Selects the `rate_limit` usage scope variant. |
| `ALL` | `'all'` | Selects the `all` usage scope variant. |

### omp.provider.UsageUnit

```python
class UsageUnit(StrEnum): ...
```

`UsageUnit` is the closed vocabulary for usage unit values.

Use the member rather than spelling its wire value yourself.

| Member | Wire value | Meaning |
|---|---:|---|
| `REQUESTS` | `'requests'` | Selects the `requests` usage unit variant. |
| `TOKENS` | `'tokens'` | Selects the `tokens` usage unit variant. |
| `PREMIUM_UNITS` | `'premium_units'` | Selects the `premium_units` usage unit variant. |
| `NANOS_USD` | `'nanos_usd'` | Selects the `nanos_usd` usage unit variant. |

### omp.provider.UsageQuery

```python
@dataclass(frozen=True, slots=True)
class UsageQuery:
    provider: str
    identity: str | None
    scope: UsageScope
    allow_stale: bool
    api_key: Secret | None = None
```

`UsageQuery` carries typed usage query data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `str` | — | The provider identifier. |
| `identity` | `str \| None` | — | The stable account or principal identifier. |
| `scope` | `UsageScope` | — | The requested account, usage, or contribution scope. |
| `allow_stale` | `bool` | — | Whether cached usage may satisfy the query. |
| `api_key` | `Secret \| None` | `None` | A callback-scoped redacting API key. |

### omp.provider.UsageWindow

```python
@dataclass(frozen=True, slots=True)
class UsageWindow:
    id: str
    used: int | None = None
    limit: int | None = None
    fraction: Decimal | None = None
    resets_at_ms: int | None = None
    unit: UsageUnit = UsageUnit.REQUESTS
```

`UsageWindow` carries typed usage window data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `str` | — | The stable identifier. |
| `used` | `int \| None` | `None` | The amount consumed in the window. |
| `limit` | `int \| None` | `None` | The window ceiling. |
| `fraction` | `Decimal \| None` | `None` | The consumed fraction when exact counts are unavailable. |
| `resets_at_ms` | `int \| None` | `None` | The Unix-epoch reset time in milliseconds. |
| `unit` | `UsageUnit` | `UsageUnit.REQUESTS` | The measurement or billing unit. |

### omp.provider.UsageReport

```python
@dataclass(frozen=True, slots=True)
class UsageReport:
    windows: tuple[UsageWindow, ...]
    balance_nanos_usd: int | None = None
    plan: str | None = None
    observed_at_ms: int | None = None
```

`UsageReport` carries typed usage report data between your extension and the host.

Instances are immutable and slotted. Construct them with the fields below.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `windows` | `tuple[UsageWindow, ...]` | — | Quota or billing windows. |
| `balance_nanos_usd` | `int \| None` | `None` | The account balance in nano-USD. |
| `plan` | `str \| None` | `None` | The provider plan label. |
| `observed_at_ms` | `int \| None` | `None` | The Unix-epoch observation time in milliseconds. |

**Example**

```python
report = UsageReport(
    windows=(UsageWindow("monthly", used=800, limit=1000, unit=UsageUnit.REQUESTS),),
)
```
