# `omp.mcp`

Use `omp.mcp` to declare, mount, inspect, and unmount Model Context Protocol servers. Transport declarations are inert and immutable; the Environment-owned control arm performs process, network, credential, and MCP protocol work.

```python
import omp
from omp import mcp

mount = mcp.McpMount(
    server="docs",
    transport=mcp.Stdio("python", ("-m", "docs_mcp")),
    auth=mcp.McpAuth.none(),
)
devices = await mcp.mount(mount)
```

Mounted tools become Environment-placed [`omp.Device`](omp.devices.md) values. Credential values are never part of `McpAuth`; use the host-managed credential surface documented in [`omp.creds`](omp.creds.md).

## Enums and transport alias

### `omp.mcp.McpTransportKind`

```python
class McpTransportKind(StrEnum):
    STDIO = "stdio"
    HTTP = "http"
    SSE = "sse"
```

Identifies the supported MCP transport.

| Member | Wire value | Meaning |
|---|---|---|
| `STDIO` | `"stdio"` | Newline-delimited child-process stdio. |
| `HTTP` | `"http"` | Streamable HTTP. |
| `SSE` | `"sse"` | Legacy HTTP plus server-sent events. |

### `omp.mcp.McpAuthKind`

```python
class McpAuthKind(StrEnum):
    OAUTH = "oauth"
    API_KEY = "api_key"
    NONE = "none"
```

Identifies the credential requirement declared for an MCP server.

| Member | Wire value | Meaning |
|---|---|---|
| `OAUTH` | `"oauth"` | Environment-managed OAuth credential. |
| `API_KEY` | `"api_key"` | Named Environment-managed API key. |
| `NONE` | `"none"` | No authentication. |

### `omp.mcp.McpServerState`

```python
class McpServerState(StrEnum):
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    RECONNECTING = "reconnecting"
    FAILED = "failed"
```

Represents an Environment-owned MCP connection's lifecycle.

| Member | Wire value | Meaning |
|---|---|---|
| `DISCONNECTED` | `"disconnected"` | No active connection. |
| `CONNECTING` | `"connecting"` | Initial connection is in progress. |
| `CONNECTED` | `"connected"` | Protocol connection is active. |
| `RECONNECTING` | `"reconnecting"` | Recovery connection is in progress. |
| `FAILED` | `"failed"` | Connection failed. |

### `omp.mcp.McpTransport`

```python
McpTransport = Stdio | Http | Sse
```

Type alias for any validated MCP transport declaration.

## Transport declarations

### `omp.mcp.Stdio`

```python
@dataclass(frozen=True, slots=True)
class Stdio:
    command: str
    args: tuple[str, ...] = ()
    env: Mapping[str, str] | None = None
    cwd: str | None = None
    kind: McpTransportKind = field(default=McpTransportKind.STDIO, init=False)
```

Declares an Environment-owned MCP child process. Construction validates text fields and snapshots `env` as an immutable mapping.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `command` | `str` | required | Non-empty executable name or path. |
| `args` | `tuple[str, ...]` | `()` | Child arguments. |
| `env` | `Mapping[str, str] | None` | `None` | Environment overrides; empty values are allowed. |
| `cwd` | `str | None` | `None` | Optional non-empty working directory. |
| `kind` | `McpTransportKind` | `STDIO` | Fixed transport discriminator. |

**Raises**

: `omp.SpecError` — A text value is empty where forbidden, contains NUL/CR/LF, has the wrong type, or `args` is not a sequence of strings.

```python
transport = mcp.Stdio(
    command="uvx",
    args=("acme-docs-mcp",),
    env={"LOG_LEVEL": "warning"},
)
```

### `omp.mcp.Http`

```python
@dataclass(frozen=True, slots=True)
class Http:
    url: str
    headers: Mapping[str, str] | None = None
    kind: McpTransportKind = field(default=McpTransportKind.HTTP, init=False)
```

Declares a streamable-HTTP MCP endpoint.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `url` | `str` | required | Absolute `http` or `https` URL without embedded credentials or a fragment. |
| `headers` | `Mapping[str, str] | None` | `None` | Immutable copy of HTTP headers; values may be empty. |
| `kind` | `McpTransportKind` | `HTTP` | Fixed transport discriminator. |

Header names must use HTTP token syntax and are unique case-insensitively.

**Raises**

: `omp.SpecError` — The URL or headers are invalid.

```python
transport = mcp.Http(
    "https://mcp.example.test/v1",
    headers={"X-Workspace": "docs"},
)
```

### `omp.mcp.Sse`

```python
@dataclass(frozen=True, slots=True)
class Sse:
    url: str
    headers: Mapping[str, str] | None = None
    kind: McpTransportKind = field(default=McpTransportKind.SSE, init=False)
```

Declares a legacy HTTP-plus-SSE MCP endpoint. URL and header validation is identical to `Http`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `url` | `str` | required | Absolute credential-free `http` or `https` URL without a fragment. |
| `headers` | `Mapping[str, str] | None` | `None` | Immutable copy of HTTP headers. |
| `kind` | `McpTransportKind` | `SSE` | Fixed transport discriminator. |

**Raises**

: `omp.SpecError` — The URL or headers are invalid.

## Authentication and mounts

### `omp.mcp.McpAuth`

```python
@dataclass(frozen=True, slots=True)
class McpAuth:
    kind: McpAuthKind
    scopes: tuple[str, ...] = ()
    name: str | None = None

    @classmethod
    def oauth(cls, *, scopes: Sequence[str] = ()) -> "McpAuth": ...

    @classmethod
    def api_key(cls, *, name: str) -> "McpAuth": ...

    @classmethod
    def none(cls) -> "McpAuth": ...
```

Declares a credential requirement without carrying credential bytes.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `McpAuthKind` | required | Authentication strategy. |
| `scopes` | `tuple[str, ...]` | `()` | Unique OAuth scopes. |
| `name` | `str | None` | `None` | Credential name for API-key authentication. |

OAuth accepts scopes and forbids `name`. API-key auth requires `name` and forbids scopes. Unauthenticated declarations allow neither.

**Parameters**

: **`scopes`** (`Sequence[str]`) — Unique, non-empty OAuth scope names.
: **`name`** (`str`) — Non-empty host credential name.

**Returns**

: `McpAuth` — A validated authentication declaration.

**Raises**

: `omp.SpecError` — The declaration is malformed or internally inconsistent.

```python
auth = mcp.McpAuth.oauth(scopes=("resources.read",))
```

### `omp.mcp.McpMount`

```python
@dataclass(frozen=True, slots=True)
class McpMount:
    server: str
    transport: McpTransport
    auth: McpAuth = field(default_factory=McpAuth.none)
    include: tuple[str, ...] = ("*",)
    exclude: tuple[str, ...] = ()
    rename: Mapping[str, str] = field(default_factory=lambda: _EMPTY_MAP)
    docs: Mapping[str, str] = field(default_factory=lambda: _EMPTY_MAP)
    precedence: Precedence = Precedence.DEFAULT
    tier: Tier = Tier.WRITE
    timeout: Duration = Duration("30s")
    restart: Restart = Restart.ON_FAILURE
```

Declares one MCP server and the projection of its tools into omp devices.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `server` | `str` | required | Lowercase device segment, at most 64 characters. |
| `transport` | `McpTransport` | required | `Stdio`, `Http`, or `Sse` declaration. |
| `auth` | `McpAuth` | `McpAuth.none()` | Credential requirement. |
| `include` | `tuple[str, ...]` | `("*",)` | Unique endpoint globs to include. Must not be empty. |
| `exclude` | `tuple[str, ...]` | `()` | Unique endpoint globs to exclude. |
| `rename` | `Mapping[str, str]` | empty immutable mapping | Endpoint-to-device-name overrides. |
| `docs` | `Mapping[str, str]` | empty immutable mapping | Documentation overrides. Empty values are allowed. |
| `precedence` | `omp.Precedence` | `Precedence.DEFAULT` | Precedence assigned to mounted devices. |
| `tier` | `omp.Tier` | `Tier.WRITE` | Policy tier sent with the mount. |
| `timeout` | `omp.Duration` | `Duration("30s")` | Non-negative invocation timeout. |
| `restart` | `omp.Restart` | `Restart.ON_FAILURE` | Server restart policy. Compatible strings are converted. |

Endpoint globs cannot contain `/` or NUL. Rename targets must be valid lowercase device segments and unique. When `auth` is not `NONE`, an HTTP or SSE transport cannot also declare an `Authorization` header; the Environment supplies authentication.

**Raises**

: `omp.SpecError` — Any field violates the mount contract.

```python
spec = mcp.McpMount(
    server="issues",
    transport=mcp.Http("https://mcp.example.test/issues"),
    auth=mcp.McpAuth.api_key(name="issues-api"),
    include=("get_*", "search_*"),
    rename={"search_issues": "search"},
    timeout=omp.Duration("10s"),
)
```

## Server observations

### `omp.mcp.McpResource`

```python
@dataclass(frozen=True, slots=True)
class McpResource:
    uri: str
    name: str
    media_type: str | None = None
    template: bool = False
```

Describes a resource or resource template discovered from a server.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `uri` | `str` | required | Non-empty MCP resource URI. |
| `name` | `str` | required | Non-empty display name. |
| `media_type` | `str | None` | `None` | Optional non-empty media type. |
| `template` | `bool` | `False` | Whether `uri` is a resource template. |

**Raises**

: `omp.SpecError` — Text is empty/unsafe or `template` is not a bool.

### `omp.mcp.McpServer`

```python
@dataclass(frozen=True, slots=True)
class McpServer:
    name: str
    state: McpServerState
    protocol_version: str | None = None
    instructions: str | None = None
    endpoints: tuple[str, ...] = ()
    resources: tuple[McpResource, ...] = ()
    prompts: tuple[str, ...] = ()
    last_error: str | None = None
```

Provides an immutable snapshot of one Environment-owned MCP server connection.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str` | required | Valid server device segment. |
| `state` | `McpServerState` | required | Lifecycle state; compatible strings are converted. |
| `protocol_version` | `str | None` | `None` | Negotiated MCP version. |
| `instructions` | `str | None` | `None` | Server-provided instructions. |
| `endpoints` | `tuple[str, ...]` | `()` | Unique endpoint names. |
| `resources` | `tuple[McpResource, ...]` | `()` | Resource inventory. |
| `prompts` | `tuple[str, ...]` | `()` | Unique prompt names. |
| `last_error` | `str | None` | `None` | Last non-empty error summary. |

**Raises**

: `omp.SpecError` — The host-projected snapshot is malformed.

## Lifecycle operations

### `omp.mcp.mount`

```python
async def mount(spec: McpMount) -> tuple[Device, ...]: ...
```

Mounts a validated server through the Environment-owned control arm and returns the projected devices. Each mounted device has `place=Place.ENV`, uses the mount's precedence, and is marked as mounted.

Calling a mounted device accepts keyword arguments only. Arguments must be JSON-compatible (`None`, strings, numbers, bools, lists, and string-keyed mappings). The device dispatches `omp.mcp.invoke` and returns the host result mapping, including the validated lifecycle flags supplied by the host.

**Parameters**

: **`spec`** (`McpMount`) — Complete server and projection declaration.

**Returns**

: `tuple[omp.Device, ...]` — Mounted devices in host catalog order.

**Raises**

: `omp.SpecError` — `spec` has the wrong type or the host returns an invalid device catalog.
: `omp.NotWiredError` — No control backend is installed.

```python
devices = await mcp.mount(spec)
for device in devices:
    print(device.name)
```

### `omp.mcp.unmount`

```python
async def unmount(server: str) -> None: ...
```

Unmounts every device from one MCP server and releases its connection. A well-formed host response contains a boolean `removed` flag; the function returns `None` regardless of that flag's value.

**Parameters**

: **`server`** (`str`) — Valid lowercase server segment.

**Returns**

: `None`

**Raises**

: `omp.SpecError` — The server name or lifecycle response is invalid.
: `omp.NotWiredError` — No control backend is installed.

### `omp.mcp.servers`

```python
async def servers() -> tuple[McpServer, ...]: ...
```

Reads the current MCP connection inventory from the Environment. The decoder accepts the host's numeric lifecycle values and their string equivalents, validates all endpoint/resource/prompt rows, and returns immutable snapshots.

**Returns**

: `tuple[McpServer, ...]` — Current server inventory in host order.

**Raises**

: `omp.SpecError` — The host inventory is malformed or contains an unknown state.
: `omp.NotWiredError` — No control backend is installed.

```python
for server in await mcp.servers():
    print(server.name, server.state, len(server.resources))
```
