"""Pure provider-catalog declarations.

This module mirrors the public source vocabulary compiled into
``crates/catalog``.  Importing it only constructs immutable Python values;
provider registration is recorded in the local declaration table and performs
no credential, network, filesystem, CONTROL, or DATA access.
"""
from __future__ import annotations

import base64
import inspect
from ipaddress import ip_address
from urllib.parse import urlsplit
from collections.abc import AsyncIterator, Iterable, Mapping, Sequence
from dataclasses import dataclass, field, fields, is_dataclass
from decimal import Decimal
from enum import IntEnum, StrEnum
from types import MappingProxyType
from typing import Any, Generic, Protocol, TypeVar

from _omp import BlobRef, Duration, EnvPath, Secret

from ._registry import registry
from ._errors import SpecError, NotWiredError

_T = TypeVar("_T", bound=type)
_V = TypeVar("_V")
_EMPTY_MAP: Mapping[Any, Any] = MappingProxyType({})
_PROVIDER_INSTANCES: dict[str, object] = {}


def _wire_value(value: object) -> object:
    """Lower one provider value to the JSON-only CONTROL vocabulary."""
    if isinstance(value, StrEnum):
        return value.value
    if isinstance(value, IntEnum):
        return int(value)
    if isinstance(value, Decimal):
        return str(value)
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, bytes):
        return {"$bytes": base64.b64encode(value).decode("ascii")}
    if isinstance(value, BlobRef):
        return {"hash": value.hex, "size": value.size}
    if isinstance(value, EnvPath):
        return str(value)
    if isinstance(value, Duration):
        return {"$duration": str(value)}
    if isinstance(value, Secret):
        raise TypeError("provider CONTROL payloads cannot contain credential secrets")
    if is_dataclass(value) and not isinstance(value, type):
        return {
            item.name: _wire_value(getattr(value, item.name))
            for item in fields(value)
        }
    if isinstance(value, Mapping):
        encoded: dict[str, object] = {}
        for key, item in value.items():
            if not isinstance(key, (str, StrEnum)):
                raise TypeError("provider CONTROL mapping keys must be strings")
            encoded[str(key)] = _wire_value(item)
        return encoded
    if isinstance(value, (tuple, list)):
        return [_wire_value(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return [_wire_value(item) for item in sorted(value, key=repr)]
    raise TypeError(
        f"{type(value).__name__} is not JSON-serializable for provider CONTROL"
    )


class Api(StrEnum):
    """Codec selector for one provider route."""

    OPENAI_CHAT = "openai_chat"
    OPENAI_RESPONSES = "openai_responses"
    OPENAI_CODEX = "openai_codex"
    ANTHROPIC_MESSAGES = "anthropic_messages"
    GEMINI = "gemini"
    GOOGLE_CCA = "google_cca"
    BEDROCK = "bedrock"
    OLLAMA = "ollama"
    GITLAB_DUO = "gitlab_duo"
    CURSOR = "cursor"
    DEVIN = "devin"
    OPENAI_EMBEDDING = "openai_embedding"
    OPENAI_MEDIA = "openai_media"
    OPENAI_REALTIME = "openai_realtime"
    SEARCH_EXA = "search_exa"
    SEARCH_HTTP = "search_http"
    SEARCH_TAVILY = "search_tavily"
    SEARCH_KAGI = "search_kagi"
    SEARCH_PERPLEXITY = "search_perplexity"
    SEARCH_PARALLEL = "search_parallel"
    OMP_NATIVE = "omp_native"
    LOCAL = "local"


class AuthMode(StrEnum):
    """Authentication protocol, matching Rust ``AuthSpecKind`` spellings."""

    NONE = "none"
    API_KEY = "api_key"
    BEARER = "bearer"
    OAUTH = "oauth"
    AWS_SIGV4 = "aws_sigv4"
    GCP_ADC = "gcp_adc"
    AZURE_AD = "azure_ad"
    GITHUB_APP = "github_app"
    OMP_SESSION = "omp_session"


class Transport(StrEnum):
    """Request transport matching Rust ``TransportKind`` spellings."""

    HTTP = "http"
    WEBSOCKET = "websocket"
    WEBRTC = "webrtc"
    AWS_EVENT_STREAM = "aws_event_stream"
    CONNECT = "connect"
    LOCAL = "local"


class CodecProfile(StrEnum):
    """Typed codec-construction discriminator."""

    STANDARD = "standard"
    GOOGLE_CCA_GEMINI_CLI = "google-cca-gemini-cli"
    GOOGLE_CCA_ANTIGRAVITY = "google-cca-antigravity"
    APPLE_FM = "apple-fm"


class AccountScope(StrEnum):
    """Boundary at which a principal and its quota are shared."""

    PROVIDER = "provider"
    ROUTE = "route"
    REGION = "region"


class OAuthFlowKind(StrEnum):
    """OAuth authorization-flow discriminator."""

    PKCE = "pkce"
    DEVICE_CODE = "device_code"
    PASTE = "paste"
    CUSTOM = "custom"


class Completion(StrEnum):
    """Completion mechanism for an OAuth authorization-code flow."""

    CALLBACK_URL = "callback_url"
    PASTE_CALLBACK_URL = "paste_callback_url"
    PASTE_CODE = "paste_code"


class RefreshBehavior(StrEnum):
    """OAuth refresh behavior with Rust-compatible stable spellings."""

    UNSUPPORTED = "unsupported"
    TOKEN_ENDPOINT = "token_endpoint"


class Operation(StrEnum):
    """Closed catalog operation vocabulary matching ``OperationKind``."""

    CHAT = "chat"
    COUNT_TOKENS = "count_tokens"
    TOKENIZE = "tokenize"
    DETOKENIZE = "detokenize"
    EMBED = "embed"
    GENERATE_IMAGE = "generate_image"
    GENERATE_VIDEO = "generate_video"
    SPEAK = "speak"
    TRANSCRIBE = "transcribe"
    REALTIME = "realtime"
    SEARCH = "search"
    USAGE = "usage"
    DISCOVER_MODELS = "discover_models"
    AUTH = "auth"
    NATIVE = "native"


class Role(StrEnum):
    """Identify a canonical chat-message role."""

    SYSTEM = "system"
    DEVELOPER = "developer"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


class Modality(StrEnum):
    """Canonical media modality vocabulary."""

    TEXT = "text"
    IMAGE = "image"
    AUDIO = "audio"
    VIDEO = "video"
    DOCUMENT = "document"


class ToolFeature(StrEnum):
    """Independent tool-call behaviors from Rust ``ToolFeatureBits``."""

    PARALLEL = "parallel"
    STRICT_SCHEMA = "strict_schema"
    NAMED_CHOICE = "named_choice"
    REQUIRED_CHOICE = "required_choice"
    DISABLED_CHOICE = "disabled_choice"


class HostedTool(StrEnum):
    """Provider-hosted tool vocabulary that does not consume schema slots."""

    WEB_SEARCH = "web_search"
    CODE_EXECUTION = "code_execution"
    RETRIEVAL = "retrieval"
    URL_CONTEXT = "url_context"
    DEEP_RESEARCH = "deep_research"


class ToolSchemaFlavor(StrEnum):
    """Provider-specific tool parameter-schema normalization."""

    JSON_SCHEMA = "json_schema"
    ANTHROPIC = "anthropic"
    GOOGLE = "google"
    MOONSHOT_MFJS = "moonshot_mfjs"
    GRAMMAR = "grammar"
    CCA = "cca"


class CacheRetention(StrEnum):
    """Prompt-cache retention classes from Rust ``CacheRetentionBits``."""

    REQUEST = "request"
    SESSION = "session"
    SHORT = "short"
    LONG = "long"


class ThinkingMode(StrEnum):
    """Provider-native reasoning control, matching Rust kebab-case values."""

    EFFORT = "effort"
    BUDGET = "budget"
    GOOGLE_LEVEL = "google-level"
    ANTHROPIC_ADAPTIVE = "anthropic-adaptive"
    ANTHROPIC_BUDGET_EFFORT = "anthropic-budget-effort"


class Effort(StrEnum):
    """Portable ordered reasoning effort vocabulary."""

    OFF = "off"
    MINIMAL = "minimal"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    XHIGH = "xhigh"
    MAX = "max"


@dataclass(frozen=True, slots=True)
class CredentialSource:
    """One public credential source in exact acquisition order."""

    kind: str
    ordered_names: tuple[str, ...] = ()
    options: Mapping[str, object] = field(default_factory=lambda: _EMPTY_MAP)

    @classmethod
    def env(cls, *names: str) -> "CredentialSource":
        """Read the first populated environment variable from ``names``."""
        if not names or not all(isinstance(name, str) and name for name in names):
            raise SpecError("credential environment names must be non-empty strings")
        return cls("environment", tuple(names))

    @classmethod
    def stored(cls) -> "CredentialSource":
        """Read an encrypted credential from the account store."""
        return cls("stored")

    @classmethod
    def oauth(cls) -> "CredentialSource":
        """Run the OAuth flow linked by the enclosing authentication spec."""
        return cls("oauth")

    @classmethod
    def application_default(
        cls,
        *,
        api_key_env: str = "GOOGLE_API_KEY",
        project_env: str = "GOOGLE_CLOUD_PROJECT",
        location_env: str = "GOOGLE_CLOUD_LOCATION",
    ) -> "CredentialSource":
        """Resolve Google application-default credentials through the host ADC chain."""
        names = {
            "api_key_env": api_key_env,
            "project_env": project_env,
            "location_env": location_env,
        }
        if any(not isinstance(value, str) or not value for value in names.values()):
            raise SpecError("ADC environment names must be non-empty strings")
        return cls("application_default", options=MappingProxyType(names))

    @classmethod
    def aws_chain(cls) -> "CredentialSource":
        """Resolve the standard AWS credential chain."""
        return cls("aws_chain")

    @classmethod
    def session(cls) -> "CredentialSource":
        """Acquire an interactive provider session credential."""
        return cls("session")


@dataclass(frozen=True, slots=True)
class TokenPlacement:
    """Placement of a resolved OAuth access token."""

    kind: str
    name: str | None = None
    prefix: str | None = None

    @classmethod
    def header(cls, name: str, prefix: str = "") -> "TokenPlacement":
        """Place the token in a sensitive request header."""
        return cls("header", name, prefix)

    @classmethod
    def query(cls, parameter: str) -> "TokenPlacement":
        """Place the token in a sensitive query parameter."""
        return cls("query", parameter)


@dataclass(frozen=True, slots=True)
class PrincipalResolution:
    """Evidence binding refreshed credentials to a stable principal."""

    kind: str
    values: tuple[str, ...]

    @classmethod
    def id_token_claim(cls, claim: str) -> "PrincipalResolution":
        """Read a verified ID-token claim."""
        return cls("id_token_claim", (claim,))

    @classmethod
    def access_token_claims(cls, *claims: str) -> "PrincipalResolution":
        """Read the first present stable access-token claim."""
        return cls("access_token_claims", tuple(claims))

    @classmethod
    def token_response_field(cls, pointer: str) -> "PrincipalResolution":
        """Read a typed token-response field by JSON Pointer."""
        return cls("token_response_field", (pointer,))

    @classmethod
    def userinfo(cls, url: str, field: str) -> "PrincipalResolution":
        """Fetch a public user-information field."""
        return cls("userinfo_endpoint", (url, field))

    @classmethod
    def static_label(cls, label: str) -> "PrincipalResolution":
        """Use a reviewed static principal label."""
        return cls("static_label", (label,))


@dataclass(frozen=True, slots=True)
class OAuthFlow:
    """Flow-specific public OAuth endpoints and completion behavior."""

    kind: OAuthFlowKind
    url: str
    redirect_uri: str | None = None
    completion: Completion | None = None
    parameters: Mapping[str, str] = field(default_factory=lambda: _EMPTY_MAP)
    max_polls: int | None = None
    interval: object | None = None
    max_interval: object | None = None
    prompt: str | None = None

    @classmethod
    def pkce(
        cls,
        authorize_url: str,
        redirect_uri: str,
        *,
        completion: Completion = Completion.CALLBACK_URL,
        params: Mapping[str, str] = _EMPTY_MAP,
    ) -> "OAuthFlow":
        """Declare an S256 PKCE authorization-code flow."""
        return cls(OAuthFlowKind.PKCE, authorize_url, redirect_uri, completion, MappingProxyType(dict(params)))

    @classmethod
    def device_code(
        cls,
        device_authorization_url: str,
        *,
        max_polls: int = 180,
        interval: object = None,
        max_interval: object = None,
    ) -> "OAuthFlow":
        """Declare an RFC 8628 device authorization flow."""
        return cls(
            OAuthFlowKind.DEVICE_CODE,
            device_authorization_url,
            max_polls=max_polls,
            interval=interval,
            max_interval=max_interval,
        )

    @classmethod
    def paste(cls, authorization_url: str, prompt: str) -> "OAuthFlow":
        """Declare a browser-assisted pasted-input flow."""
        return cls(OAuthFlowKind.PASTE, authorization_url, prompt=prompt)


@dataclass(frozen=True, slots=True)
class OAuthSpec:
    """Public OAuth flow data containing no credential secrets."""

    client_id: str
    token_url: str
    flow: OAuthFlow
    scopes: tuple[str, ...] = ()
    audience: str | None = None
    placement: TokenPlacement = TokenPlacement("header", "authorization", "Bearer ")
    token_params: Mapping[str, str] = field(default_factory=lambda: _EMPTY_MAP)
    refresh: RefreshBehavior = RefreshBehavior.TOKEN_ENDPOINT
    principal: PrincipalResolution | None = None


@dataclass(frozen=True, slots=True)
class AuthSpec:
    """Authentication requirements without credential values."""

    mode: AuthMode
    header: str | None = "authorization"
    prefix: str | None = "Bearer "
    query: str | None = None
    scopes: tuple[str, ...] = ()
    audience: str | None = None
    account_scope: AccountScope = AccountScope.PROVIDER
    sources: tuple[CredentialSource, ...] = (CredentialSource("stored"),)
    oauth: OAuthSpec | None = None
    signing: object | None = None


@dataclass(frozen=True, slots=True)
class ManagementSpec:
    """Provider-level management capabilities."""

    operations: frozenset[Operation] = frozenset()
    multiple_accounts: bool = False
    refresh: bool = False
    principal_quota: bool = False


@dataclass(frozen=True, slots=True)
class StreamWatchdog:
    """Bound the wait for the first and subsequent streaming events."""

    first_event: Duration
    inter_event: Duration | None = None

    def __post_init__(self) -> None:
        """Reject missing, mistyped, or non-positive watchdog windows."""
        if not isinstance(self.first_event, Duration):
            raise SpecError("StreamWatchdog.first_event must be Duration")
        if self.first_event <= Duration("0s"):
            raise SpecError("StreamWatchdog.first_event must be positive")
        if self.inter_event is not None:
            if not isinstance(self.inter_event, Duration):
                raise SpecError("StreamWatchdog.inter_event must be Duration or None")
            if self.inter_event <= Duration("0s"):
                raise SpecError("StreamWatchdog.inter_event must be positive")


@dataclass(frozen=True, slots=True)
class CompatFlags:
    """Closed route/model wire-compatibility overrides used by declarations."""

    schema_flavor: ToolSchemaFlavor | None = None
    watchdog: StreamWatchdog | None = None

class DiscoveryKind(StrEnum):
    """Select the response family used for remote model discovery."""

    OPENAI_MODELS = "openai_models"
    GOOGLE_MODELS = "google_models"
    OLLAMA_TAGS = "ollama_tags"
    ACCOUNT_MODELS = "account_models"
    SPECIALIZED = "specialized"


@dataclass(frozen=True, slots=True)
class Pagination:
    """Describe how a remote model listing advances between pages."""

    kind: str
    query_parameter: str | None = None
    first_page: int | None = None

    @classmethod
    def single_page(cls) -> "Pagination":
        """Return a pagination policy whose first response is complete."""
        return cls("single_page")

    @classmethod
    def cursor(cls, query_parameter: str) -> "Pagination":
        """Pass a response cursor through the named query parameter."""
        return cls("cursor", query_parameter=query_parameter)

    @classmethod
    def page_number(
        cls, query_parameter: str, *, first_page: int = 1
    ) -> "Pagination":
        """Pass an increasing page number through the named query parameter."""
        return cls("page_number", query_parameter=query_parameter, first_page=first_page)


@dataclass(frozen=True, slots=True)
class DiscoverySpec:
    """Configure one route's remote model-list operation."""

    kind: DiscoveryKind
    path: str
    label: str
    pagination: Pagination = Pagination.single_page()
    authoritative: bool = False
    interval: Duration | None = None

    def __post_init__(self) -> None:
        """Reject periodic discovery faster than the daemon scheduling floor."""
        if self.interval is not None:
            if not isinstance(self.interval, Duration):
                raise SpecError("DiscoverySpec.interval must be Duration or None")
            if self.interval < Duration("5s"):
                raise SpecError("DiscoverySpec.interval must be at least 5s")


class RedirectTrust(StrEnum):
    """Constrain redirects relative to a route's trusted origin."""

    DENY = "deny"
    SAME_ORIGIN = "same_origin"
    PUBLIC_ONLY = "public_only"


def _origin(url: str) -> tuple[str, str | None]:
    parsed = urlsplit(url)
    if parsed.scheme in {"unix", "http+unix"} or (
        not parsed.scheme and url.startswith("/")
    ):
        return url, None
    if not parsed.scheme or not parsed.netloc:
        raise SpecError("route base_url must be an absolute URL or Unix socket path")
    return f"{parsed.scheme.lower()}://{parsed.netloc}", parsed.hostname


def _is_loopback(url: str) -> bool:
    parsed = urlsplit(url)
    if parsed.scheme in {"unix", "http+unix"} or (
        not parsed.scheme and url.startswith("/")
    ):
        return True
    host = parsed.hostname
    if host is None:
        return False
    lowered = host.rstrip(".").lower()
    if lowered == "localhost" or lowered.endswith(".localhost"):
        return True
    try:
        return ip_address(lowered).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True, slots=True)
class TrustDomain:
    """Declare the origin and credential-forwarding boundary for a route."""

    origin: str
    redirects: RedirectTrust = RedirectTrust.SAME_ORIGIN
    allow_plaintext: bool = False

    def __post_init__(self) -> None:
        """Reject plaintext trust for anything except loopback and Unix sockets."""
        if self.allow_plaintext and self.origin and not _is_loopback(self.origin):
            raise SpecError("plaintext trust is limited to loopback hosts and Unix sockets")

    @classmethod
    def https(
        cls, *, redirects: RedirectTrust = RedirectTrust.SAME_ORIGIN
    ) -> "TrustDomain":
        """Derive a TLS-required trust origin from the route base URL."""
        return cls("", redirects=redirects)

    @classmethod
    def loopback(
        cls, *, redirects: RedirectTrust = RedirectTrust.SAME_ORIGIN
    ) -> "TrustDomain":
        """Derive a trust origin while permitting loopback plaintext."""
        return cls("", redirects=redirects, allow_plaintext=True)


@dataclass(frozen=True, slots=True)
class RouteLimits:
    """Subtract route-specific operations and token limits from model capabilities."""

    operations: frozenset[Operation] | None = None
    max_context_tokens: int | None = None
    max_output_tokens: int | None = None
    disable_server_state: bool = False
    disable_prompt_caching: bool = False




@dataclass(frozen=True, slots=True)
class RouteSpec:
    """One concrete provider endpoint and its codec/auth contract."""

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

    def __post_init__(self) -> None:
        """Resolve and validate the route's declared trust boundary."""
        route_origin, _ = _origin(self.base_url)
        trust = self.trust
        if not isinstance(trust, TrustDomain):
            raise SpecError("RouteSpec.trust must be TrustDomain")
        if self.transport is not Transport.LOCAL:
            if trust.allow_plaintext:
                if not _is_loopback(self.base_url):
                    raise SpecError(
                        "TrustDomain.loopback() requires a loopback host or Unix socket path"
                    )
            elif urlsplit(self.base_url).scheme.lower() != "https":
                raise SpecError("plaintext routes require TrustDomain.loopback()")
        if not trust.origin:
            object.__setattr__(
                self,
                "trust",
                TrustDomain(route_origin, trust.redirects, trust.allow_plaintext),
            )
        elif route_origin != trust.origin:
            raise SpecError("RouteSpec.base_url is outside its TrustDomain origin")


class Cap(StrEnum):
    """Evidence state for an unsupported or not-yet-known capability axis."""

    UNKNOWN = "unknown"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True, slots=True)
class ToolCaps:
    """Tool declaration and choice constraints from Rust ``ToolCapabilities``."""

    features: frozenset[ToolFeature] = frozenset()
    maximum_tools: int | None = None


@dataclass(frozen=True, slots=True)
class ReasoningCaps:
    """Reasoning visibility, effort, and token-budget constraints."""

    features: frozenset[str] = frozenset()
    efforts: tuple[Effort, ...] = ()
    minimum_budget_tokens: int | None = None
    maximum_budget_tokens: int | None = None


@dataclass(frozen=True, slots=True)
class PromptCacheCaps:
    """Prompt-cache retention and breakpoint constraints."""

    retention: frozenset[CacheRetention] = frozenset()
    min_prefix_tokens: int | None = None
    max_breakpoints: int | None = None


@dataclass(frozen=True, slots=True)
class ServiceTier:
    """One provider service tier and its relative scheduling priority."""

    name: str
    priority: int


@dataclass(frozen=True, slots=True)
class ServerStateCaps:
    """Provider-side conversation-state constraints."""

    continuation: bool
    expiry_evidence: bool
    fork_requires_reseed: bool


@dataclass(frozen=True, slots=True)
class LogprobCaps:
    """Token-level log-probability constraints."""

    maximum_top_logprobs: int
    prompt_logprobs: bool


@dataclass(frozen=True, slots=True)
class ChatCaps:
    """Complete chat capability axes, field-for-field with Rust."""

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


@dataclass(frozen=True, slots=True)
class ThinkingSpec:
    """Provider-native reasoning controls and ordered effort ladder."""

    mode: ThinkingMode
    efforts: tuple[Effort, ...]
    default: Effort | None = None
    budgets: Mapping[Effort, int] = field(default_factory=lambda: _EMPTY_MAP)
    supports_display: bool | None = None
    suppress_when_off: bool | None = None
    requires_effort: bool | None = None

    def __post_init__(self) -> None:
        order = tuple(Effort)
        if Effort.OFF in self.efforts:
            raise SpecError("ThinkingSpec.efforts must not advertise OFF")
        positions = tuple(order.index(effort) for effort in self.efforts)
        if any(left >= right for left, right in zip(positions, positions[1:])):
            raise SpecError("ThinkingSpec.efforts must be strictly ascending")
        if self.default is not None and self.default not in self.efforts:
            raise SpecError("ThinkingSpec.default must appear in efforts")


@dataclass(frozen=True, slots=True)
class Cost:
    """Exact public price inputs compiled into integer nano-USD components."""

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

    @classmethod
    def free(cls) -> "Cost":
        """Return a zero-price schedule."""
        return cls()
@dataclass(frozen=True, slots=True)
class CostTier:
    """Replacement pricing activated above a prompt-token threshold."""

    prompt_tokens_above: int
    cost: Cost

class Availability(StrEnum):
    """Describe the selectable state assigned to a discovered model."""

    UNSPECIFIED = "unspecified"
    AVAILABLE = "available"
    LOGIN_REQUIRED = "login_required"
    BLOCKED = "blocked"
    DISABLED = "disabled"


class Confidence(StrEnum):
    """Describe the evidence confidence assigned to discovered model facts."""

    VERIFIED = "verified"
    DECLARED = "declared"
    INFERRED = "inferred"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class DiscoveryDefaults:
    """Provide conservative facts for newly discovered models."""

    routes: tuple[str, ...]
    cost: Cost = Cost.free()
    context_window: int | None = None
    max_output_tokens: int | None = None
    operations: frozenset[Operation] = frozenset({Operation.CHAT})
    availability: Availability = Availability.AVAILABLE
    confidence: Confidence = Confidence.INFERRED






@dataclass(frozen=True, slots=True)
class ContextSpec:
    """How canonical conversation history reaches a route."""

    mode: str
    retention: frozenset[CacheRetention] = frozenset()
    min_prefix_tokens: int | None = None
    max_breakpoints: int | None = None

    @classmethod
    def replay(cls) -> "ContextSpec":
        """Resend canonical history on every request."""
        return cls("replay")

    @classmethod
    def prefix_cache(
        cls,
        *,
        retention: frozenset[CacheRetention],
        min_prefix_tokens: int | None = None,
        max_breakpoints: int | None = None,
    ) -> "ContextSpec":
        """Declare deterministic prefix-cache behavior."""
        return cls("prefix_cache", retention, min_prefix_tokens, max_breakpoints)


class ImageFeature(StrEnum):
    """Closed image-operation capability vocabulary."""

    GENERATE = "generate"
    EDIT = "edit"
    MASK = "mask"
    REFERENCE_IMAGES = "reference_images"
    TRANSPARENCY = "transparency"


class ImageFormat(StrEnum):
    """Closed generated-image encoding vocabulary."""

    PNG = "png"
    JPEG = "jpeg"
    WEBP = "webp"


@dataclass(frozen=True, slots=True)
class Dimensions:
    """Raster width and height in pixels."""

    width: int
    height: int

    def __post_init__(self) -> None:
        """Reject non-positive or non-integral raster dimensions."""
        if (
            isinstance(self.width, bool)
            or not isinstance(self.width, int)
            or self.width <= 0
            or isinstance(self.height, bool)
            or not isinstance(self.height, int)
            or self.height <= 0
        ):
            raise SpecError("image dimensions must be positive integers")


@dataclass(frozen=True, slots=True)
class ImageCaps:
    """Image operations, output dimensions, and encodings supported by a model."""

    features: frozenset[ImageFeature]
    sizes: tuple[Dimensions, ...]
    formats: frozenset[ImageFormat]
    max_references: int | None = None


@dataclass(frozen=True, slots=True)
class ImageRequest:
    """Typed request for host-routed image generation."""

    prompt: str
    dimensions: Dimensions
    format: ImageFormat
    count: int = 1


@dataclass(frozen=True, slots=True)
class ImageResult:
    """Blob-backed generated images and their settled nano-USD cost receipt."""

    images: tuple[BlobRef, ...]
    cost_nanos_usd: int


class SpeechFeature(StrEnum):
    """Closed text-to-speech capability vocabulary."""

    STREAMING = "streaming"
    TIMESTAMPS = "timestamps"
    SPEED = "speed"
    VOICE_SELECTION = "voice_selection"


class AudioFormat(StrEnum):
    """Closed audio encoding vocabulary for speech input and output."""

    PCM16 = "pcm16"
    PCM24 = "pcm24"
    F32 = "f32"
    MP3 = "mp3"
    AAC = "aac"
    OPUS = "opus"
    FLAC = "flac"
    WAV = "wav"


@dataclass(frozen=True, slots=True)
class SpeechCaps:
    """Speech synthesis features, voices, encodings, and sample rates."""

    features: frozenset[SpeechFeature]
    voices: tuple[str, ...]
    formats: frozenset[AudioFormat]
    sample_rates_hz: tuple[int, ...]


class TranscriptionFeature(StrEnum):
    """Closed speech-transcription capability vocabulary."""

    STREAMING = "streaming"
    TIMESTAMPS = "timestamps"
    DIARIZATION = "diarization"
    TRANSLATION = "translation"
    LANGUAGE_HINT = "language_hint"


@dataclass(frozen=True, slots=True)
class TranscriptionCaps:
    """Transcription features, accepted encodings, and duration ceiling."""

    features: frozenset[TranscriptionFeature]
    formats: frozenset[AudioFormat]
    max_duration: Duration | None


@dataclass(frozen=True, slots=True)
class SpeechRequest:
    """Typed request for host-routed text-to-speech synthesis."""

    model: str
    text: str
    voice: str
    format: AudioFormat | None = None


@dataclass(frozen=True, slots=True)
class SpeechResult:
    """Blob-backed synthesized audio and its settled nano-USD cost receipt."""

    audio: BlobRef
    format: AudioFormat
    cost_nanos_usd: int


@dataclass(frozen=True, slots=True)
class TranscriptionRequest:
    """Typed request for host-routed speech transcription."""

    model: str
    audio: EnvPath | BlobRef
    language: str | None = None


@dataclass(frozen=True, slots=True)
class TranscriptionResult:
    """Settled transcription text, detected language, and nano-USD cost receipt."""

    text: str
    language: str | None
    cost_nanos_usd: int


class RealtimeFeature(StrEnum):
    """Closed bidirectional realtime-session capability vocabulary."""

    AUDIO_IN = "audio_in"
    AUDIO_OUT = "audio_out"
    TEXT = "text"
    TOOLS = "tools"
    SERVER_VAD = "server_vad"
    SEMANTIC_VAD = "semantic_vad"
    INTERRUPTION = "interruption"


@dataclass(frozen=True, slots=True)
class RealtimeCaps:
    """Realtime behaviors, voices, and transports supported by a model."""

    features: frozenset[RealtimeFeature]
    voices: tuple[str, ...]
    transports: frozenset[Transport]


class RealtimeModality(StrEnum):
    """Modalities enabled for one bidirectional realtime session."""

    TEXT = "text"
    AUDIO = "audio"


class RealtimeEagerness(StrEnum):
    """Semantic voice-activity detector responsiveness."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    AUTO = "auto"


class RealtimeTurnDetectionMode(StrEnum):
    """Realtime turn-boundary detection strategy."""

    MANUAL = "manual"
    SERVER_VAD = "server_vad"
    SEMANTIC_VAD = "semantic_vad"


@dataclass(frozen=True, slots=True)
class TurnDetection:
    """Typed realtime turn-detection settings."""

    mode: RealtimeTurnDetectionMode
    threshold: float | None = None
    silence_ms: int | None = None
    prefix_padding_ms: int | None = None
    eagerness: RealtimeEagerness | None = None


class SettingKind(StrEnum):
    """Whether one canonical request setting is absent, required, or preferred."""

    UNSET = "unset"
    REQUIRE = "require"
    PREFER = "prefer"


@dataclass(frozen=True, slots=True)
class Setting(Generic[_V]):
    """One absent, required, or preferred canonical request setting."""

    kind: SettingKind = SettingKind.UNSET
    value: _V | None = None

    @classmethod
    def unset(cls) -> "Setting[_V]":
        """Construct an unconstrained setting."""
        return cls()

    @classmethod
    def require(cls, value: _V) -> "Setting[_V]":
        """Construct a setting that must be honored."""
        return cls(SettingKind.REQUIRE, value)

    @classmethod
    def prefer(cls, value: _V) -> "Setting[_V]":
        """Construct a setting that may be adjusted with receipt evidence."""
        return cls(SettingKind.PREFER, value)


class EmulationPolicy(StrEnum):
    """Capability emulation permitted during realtime negotiation."""

    FORBID = "forbid"
    ALLOW_LOSSLESS = "allow_lossless"
    ALLOW_DECLARED_LOSSY = "allow_declared_lossy"


class UnknownCapabilityPolicy(StrEnum):
    """Treatment of unknown capabilities during realtime negotiation."""

    REJECT = "reject"
    ALLOW_PREFERENCES = "allow_preferences"


class MismatchPolicy(StrEnum):
    """Treatment of typed-option and selected-codec mismatches."""

    REJECT = "reject"
    DROP_PREFERRED = "drop_preferred"


@dataclass(frozen=True, slots=True)
class NegotiationPolicy:
    """Capability negotiation policy for a canonical realtime request."""

    emulation: EmulationPolicy = EmulationPolicy.FORBID
    unknown: UnknownCapabilityPolicy = UnknownCapabilityPolicy.REJECT
    vendor_option_mismatch: MismatchPolicy = MismatchPolicy.REJECT


@dataclass(frozen=True, slots=True)
class RealtimeRequest:
    """Establish a Core-owned bidirectional realtime session."""

    instructions: str | None = None
    modalities: tuple[RealtimeModality, ...] = ()
    voice: str | None = None
    input_audio: Setting[AudioFormat] = Setting()
    output_audio: Setting[AudioFormat] = Setting()
    turn_detection: Setting[TurnDetection] = Setting()
    tools: tuple[str, ...] = ()
    negotiation: NegotiationPolicy = NegotiationPolicy()


@dataclass(frozen=True, slots=True)
class RealtimeEndpointRef:
    """Opaque reference to a Core-owned realtime transport endpoint."""

    id: str


@dataclass(frozen=True, slots=True)
class RealtimeCredentialRef:
    """Opaque reference to a scoped realtime credential held by Core."""

    id: str


@dataclass(frozen=True, slots=True)
class RealtimeSession:
    """Negotiated descriptor for a Core-owned realtime media session."""

    id: str
    endpoint: RealtimeEndpointRef
    credential: RealtimeCredentialRef
    expires_at_ms: int
    transport: Transport


@dataclass(frozen=True, slots=True)
class CatalogAlias:
    """Canonical model alias with review rationale and provenance."""

    alias: str
    target: str
    rationale: str
    provenance: str


@dataclass(frozen=True, slots=True)
class ScopedAlias:
    """One canonical alias visible only inside a provider namespace."""

    provider: str
    definition: CatalogAlias


@dataclass(frozen=True, slots=True)
class ModelPatch:
    """Field-granular changes to an existing catalog model."""

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


@dataclass(frozen=True, slots=True)
class ModelOverlay:
    """One model addition or field-granular patch in an overlay declaration."""

    selector: ModelRef
    added: ModelSpec | None = None
    patch: ModelPatch = ModelPatch()


@dataclass(frozen=True, slots=True)
class ModelSpec:
    """One normalized selectable model and its route/capability facts."""

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
    context: ContextSpec = ContextSpec("replay")
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

@dataclass(frozen=True, slots=True)
class ProviderSpec:
    """Complete pure-data provider declaration compiled by the Rust catalog."""

    id: str
    name: str
    routes: tuple[RouteSpec, ...]
    models: tuple[ModelSpec, ...] = ()
    management: ManagementSpec = ManagementSpec()
    discovery_defaults: DiscoveryDefaults | None = None
    mapping: object = "concrete"
    aliases: tuple[ScopedAlias, ...] = ()
    model_overlays: tuple[ModelOverlay, ...] = ()

    def __post_init__(self) -> None:
        """Reject duplicate models, conflicting model patches, and aliases."""
        model_ids: set[str] = set()
        for model in self.models:
            if not isinstance(model, ModelSpec):
                raise SpecError("ProviderSpec.models must contain ModelSpec values")
            if model.id in model_ids:
                raise SpecError(f"duplicate model id {model.id!r}")
            model_ids.add(model.id)

        selectors: set[tuple[str, str]] = set()
        for overlay in self.model_overlays:
            if not isinstance(overlay, ModelOverlay):
                raise SpecError("ProviderSpec.model_overlays must contain ModelOverlay values")
            if not isinstance(overlay.selector, ModelRef):
                raise SpecError("ModelOverlay.selector must be a ModelRef")
            key = (overlay.selector.provider, overlay.selector.model)
            if overlay.selector.provider != self.id:
                raise SpecError("model overlay selector must use the declaring provider")
            if key in selectors:
                raise SpecError(f"duplicate model overlay for {key[0]}/{key[1]}")
            selectors.add(key)

        aliases: dict[tuple[str, str], str] = {}
        for scoped in self.aliases:
            if not isinstance(scoped, ScopedAlias):
                raise SpecError("ProviderSpec.aliases must contain ScopedAlias values")
            if scoped.provider != self.id:
                raise SpecError("scoped alias must use the declaring provider")
            key = (scoped.provider, scoped.definition.alias)
            target = scoped.definition.target
            previous = aliases.get(key)
            if previous is not None and previous != target:
                raise SpecError(
                    f"alias {key[0]}/{key[1]} targets both {previous!r} and {target!r}"
                )
            aliases[key] = target


def _blob_ref(value: object) -> BlobRef:
    if isinstance(value, BlobRef):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("provider media result requires a BlobRef mapping")
    raw_hash = value.get("hash")
    if isinstance(raw_hash, str):
        try:
            digest = bytes.fromhex(raw_hash)
        except ValueError as error:
            raise TypeError("provider BlobRef hash must be hexadecimal") from error
    elif isinstance(raw_hash, Mapping) and isinstance(raw_hash.get("$bytes"), str):
        try:
            digest = base64.b64decode(raw_hash["$bytes"], validate=True)
        except ValueError as error:
            raise TypeError("provider BlobRef hash must be base64") from error
    else:
        raise TypeError("provider BlobRef hash must be hexadecimal")
    size = value.get("size")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise TypeError("provider BlobRef size must be a non-negative integer")
    return BlobRef(digest, size)


def _provider_result(
    operation: Operation,
    value: object,
) -> ImageResult | SpeechResult | TranscriptionResult | RealtimeSession:
    expected_type = {
        Operation.GENERATE_IMAGE: ImageResult,
        Operation.SPEAK: SpeechResult,
        Operation.TRANSCRIBE: TranscriptionResult,
        Operation.REALTIME: RealtimeSession,
    }[operation]
    if isinstance(value, expected_type):
        return value
    if not isinstance(value, Mapping):
        raise TypeError(
            f"omp.provider.request host result must be {expected_type.__name__}"
        )
    if operation is Operation.GENERATE_IMAGE:
        images = value.get("images")
        if not isinstance(images, Sequence) or isinstance(images, (str, bytes)):
            raise TypeError("ImageResult.images must be a sequence")
        return ImageResult(
            tuple(_blob_ref(image) for image in images),
            value["cost_nanos_usd"],
        )
    if operation is Operation.SPEAK:
        return SpeechResult(
            _blob_ref(value["audio"]),
            AudioFormat(value["format"]),
            value["cost_nanos_usd"],
        )
    if operation is Operation.TRANSCRIBE:
        return TranscriptionResult(
            str(value["text"]),
            None if value.get("language") is None else str(value["language"]),
            value["cost_nanos_usd"],
        )
    endpoint = value.get("endpoint")
    credential = value.get("credential")
    if not isinstance(endpoint, (RealtimeEndpointRef, Mapping)):
        raise TypeError("RealtimeSession.endpoint must be an endpoint reference")
    if not isinstance(credential, (RealtimeCredentialRef, Mapping)):
        raise TypeError("RealtimeSession.credential must be a credential reference")
    endpoint_id = endpoint.id if isinstance(endpoint, RealtimeEndpointRef) else endpoint["id"]
    credential_id = (
        credential.id
        if isinstance(credential, RealtimeCredentialRef)
        else credential["id"]
    )
    return RealtimeSession(
        str(value["id"]),
        RealtimeEndpointRef(str(endpoint_id)),
        RealtimeCredentialRef(str(credential_id)),
        value["expires_at_ms"],
        Transport(value["transport"]),
    )


class ProviderHandle:
    """Refer to one provider declaration and its host-owned CONTROL operations."""

    __slots__ = ("_spec", "_priority", "_extends", "_replaces")

    def __init__(
        self,
        spec: ProviderSpec,
        *,
        priority: int = 0,
        extends: str | None = None,
        replaces: str | None = None,
    ) -> None:
        """Create a handle for a validated import-time provider declaration."""
        self._spec = spec
        self._priority = priority
        self._extends = extends
        self._replaces = replaces

    @property
    def id(self) -> str:
        """Return the stable provider identifier."""
        return self._spec.id

    def __call__(self, implementation: _T) -> _T:
        """Bind a provider-scoped implementation class to this declaration."""
        registry.register_provider(self.id,
            self._spec,
            implementation,
            priority=self._priority,
            extends=self._extends,
            replaces=self._replaces,)
        implementation.__omp_provider_spec__ = self._spec
        implementation.__omp_provider_priority__ = self._priority
        implementation.__omp_provider_extends__ = self._extends
        implementation.__omp_provider_replaces__ = self._replaces
        return implementation

    async def retract(self) -> None:
        """Remove this provider declaration through the host CONTROL bridge."""
        await _provider_control_request("omp.provider.retract", provider=self.id)

    async def replace(self, spec: ProviderSpec) -> None:
        """Atomically replace this provider declaration through CONTROL."""
        if not isinstance(spec, ProviderSpec):
            raise TypeError("ProviderHandle.replace requires a ProviderSpec")
        if spec.id != self.id:
            raise ValueError("replacement ProviderSpec.id must match the provider handle")
        await _provider_control_request("omp.provider.replace", provider=self.id, spec=spec)
        self._spec = spec

    async def models(self) -> tuple[ModelCard, ...]:
        """Return the provider's resolved model cards through CONTROL."""
        result = await _provider_control_request("omp.provider.models", provider=self.id)
        if not isinstance(result, Iterable) or isinstance(
            result, (str, bytes, bytearray, Mapping)
        ):
            raise TypeError("omp.provider.models host result must be a model-card sequence")
        return tuple(_model_card(card) for card in result)

    async def is_authenticated(self) -> bool:
        """Return whether an eligible provider principal is available."""
        result = await _provider_control_request(
            "omp.provider.is_authenticated", provider=self.id
        )
        if not isinstance(result, bool):
            raise TypeError("omp.provider.is_authenticated host result must be bool")
        return result

    async def request(
        self,
        operation: Operation,
        request: ImageRequest | SpeechRequest | TranscriptionRequest | RealtimeRequest,
    ) -> ImageResult | SpeechResult | TranscriptionResult | RealtimeSession:
        """Route one typed provider operation through the host CONTROL and DATA arm."""
        expected = {
            Operation.GENERATE_IMAGE: ImageRequest,
            Operation.SPEAK: SpeechRequest,
            Operation.TRANSCRIBE: TranscriptionRequest,
            Operation.REALTIME: RealtimeRequest,
        }.get(operation)
        if expected is None:
            raise ValueError(
                "ProviderHandle.request freezes GENERATE_IMAGE, SPEAK, TRANSCRIBE, and REALTIME"
            )
        if not isinstance(request, expected):
            raise TypeError(f"{operation.name} requires {expected.__name__}")
        result = await _provider_control_request(
            "omp.provider.request",
            provider=self.id,
            operation=operation,
            request=request,
        )
        return _provider_result(operation, result)


async def _provider_control_request(operation: str, /, **arguments: object) -> Any:
    from . import _control_backend, _control_request

    if _control_backend.get() is None:
        raise NotWiredError(f"{operation} CONTROL dispatch is not wired")
    return await _control_request(
        operation,
        **{name: _wire_value(value) for name, value in arguments.items()},
    )


def _provider_definition(provider_id: str) -> object:
    for definition in registry.snapshot().providers:
        if definition.id == provider_id:
            return definition
    raise LookupError(f"provider declaration is not registered: {provider_id!r}")


def _activate_provider_implementation(provider_id: str) -> object | None:
    """Construct one sealed provider implementation for callback dispatch."""
    if not registry.sealed:
        raise RuntimeError("provider implementations activate only after FREEZE")
    definition = _provider_definition(provider_id)
    implementation = definition.implementation
    if implementation is None:
        return None
    instance = _PROVIDER_INSTANCES.get(provider_id)
    if instance is None:
        instance = implementation()
        _PROVIDER_INSTANCES[provider_id] = instance
    return instance


def _sealed_provider_declarations() -> tuple[dict[str, object], ...]:
    """Project the authoritative frozen provider table for host publication."""
    if not registry.sealed:
        raise RuntimeError("provider declarations publish only after FREEZE")
    rows: list[dict[str, object]] = []
    for definition in registry.snapshot().providers:
        callbacks: list[dict[str, object]] = []
        implementation = definition.implementation
        if implementation is not None:
            for _attribute, member in inspect.getmembers(implementation):
                for hook in getattr(member, "__omp_hooks__", ()):
                    when = _wire_value(hook.when)
                    if when is None:
                        when = {"provider": [definition.id]}
                    elif isinstance(when, dict) and when.get("provider") is None:
                        when["provider"] = [definition.id]
                    callbacks.append({
                        "event": hook.event,
                        "phase": str(getattr(hook.phase, "value", hook.phase)),
                        "name": hook.name,
                        "when": when,
                        "order": hook.order,
                        "on_failure": (
                            None
                            if hook.on_failure is None
                            else hook.on_failure.value
                        ),
                        "timeout": _wire_value(hook.timeout),
                        "coalesce": _wire_value(hook.coalesce),
                        "concurrency": hook.concurrency,
                        "threadsafe": hook.threadsafe,
                    })
        rows.append({
            "id": definition.id,
            "spec": _wire_value(definition.spec),
            "priority": definition.priority,
            "extends": definition.extends,
            "replaces": definition.replaces,
            "has_implementation": implementation is not None,
            "callbacks": callbacks,
            "activation": "eager-prompt",
        })
    return tuple(rows)


async def dispatch_provider_callback(
    provider_id: str,
    callback_name: str,
    *args: object,
    **kwargs: object,
) -> object:
    """Dispatch one host-selected cold-path callback on the activated instance."""
    instance = _activate_provider_implementation(provider_id)
    if instance is None:
        raise LookupError(f"provider {provider_id!r} has no callback implementation")
    implementation = type(instance)
    for attribute, member in inspect.getmembers(implementation):
        if any(
            hook.name == callback_name
            for hook in getattr(member, "__omp_hooks__", ())
        ):
            result = getattr(instance, attribute)(*args, **kwargs)
            return await result if inspect.isawaitable(result) else result
    raise LookupError(
        f"provider {provider_id!r} has no callback {callback_name!r}"
    )


class Facet(StrEnum):
    """Identify an inference facet exposed by a resolved model card."""

    CHAT = "chat"
    EMBED = "embed"
    IMAGE_GEN = "image_gen"
    VIDEO_GEN = "video_gen"
    SPEAK = "speak"
    TRANSCRIBE = "transcribe"
    REALTIME = "realtime"
    SEARCH = "search"


class PriceUnit(StrEnum):
    """Identify the billing unit of one resolved catalog price."""

    MTOK_INPUT = "mtok_input"
    MTOK_OUTPUT = "mtok_output"
    MTOK_CACHE_READ = "mtok_cache_read"
    MTOK_CACHE_WRITE = "mtok_cache_write"
    IMAGE = "image"
    VIDEO_SECOND = "video_second"
    AUDIO_SECOND = "audio_second"
    MCHAR_INPUT = "mchar_input"
    REQUEST = "request"


@dataclass(frozen=True, slots=True)
class Price:
    """Represent one exact nano-USD price component."""

    unit: PriceUnit
    nanos_usd: int


@dataclass(frozen=True, slots=True)
class ModelCard:
    """Describe one resolved model after catalog overlays and configuration."""

    class Source(IntEnum):
        """Identify the catalog layer that contributed a resolved model."""

        UNSPECIFIED = 0
        BUNDLED = 1
        DISCOVERED = 2
        CONFIGURED = 3
        EXTENSION = 4

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


@dataclass(frozen=True, slots=True)
class Cursor:
    """Resume the merged model stream within one host catalog epoch."""

    epoch: bytes
    generation: int


@dataclass(frozen=True, slots=True)
class ModelEvent:
    """Carry one typed delta from the host-owned merged model catalog."""

    cursor: Cursor
    upserted: ModelCard | None = None
    removed_id: str | None = None
    reset: bool = False

    def __post_init__(self) -> None:
        """Require exactly one catalog-delta variant."""
        variants = (
            self.upserted is not None,
            self.removed_id is not None,
            self.reset,
        )
        if sum(variants) != 1:
            raise ValueError(
                "ModelEvent requires exactly one of upserted, removed_id, or reset"
            )


def _model_card(value: object) -> ModelCard:
    if isinstance(value, ModelCard):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("model catalog host returned a non-ModelCard value")
    fields = dict(value)
    fields["facets"] = frozenset(Facet(item) for item in fields.get("facets", ()))
    fields["inputs"] = frozenset(Modality(item) for item in fields.get("inputs", ()))
    fields["outputs"] = frozenset(Modality(item) for item in fields.get("outputs", ()))
    fields["efforts"] = tuple(Effort(item) for item in fields.get("efforts", ()))
    fields["pricing"] = tuple(
        item
        if isinstance(item, Price)
        else Price(PriceUnit(item["unit"]), item["nanos_usd"])
        for item in fields.get("pricing", ())
    )
    if "availability" in fields:
        fields["availability"] = Availability(fields["availability"])
    if "source" in fields:
        fields["source"] = ModelCard.Source(fields["source"])
    return ModelCard(**fields)


def _model_event(value: object) -> ModelEvent:
    if isinstance(value, ModelEvent):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("model catalog host returned a non-ModelEvent value")
    raw_cursor = value.get("cursor")
    if isinstance(raw_cursor, Cursor):
        cursor = raw_cursor
    elif isinstance(raw_cursor, Mapping):
        raw_epoch = raw_cursor.get("epoch")
        if (
            isinstance(raw_epoch, Mapping)
            and isinstance(raw_epoch.get("$bytes"), str)
        ):
            try:
                raw_epoch = base64.b64decode(raw_epoch["$bytes"], validate=True)
            except ValueError as error:
                raise TypeError("model catalog cursor epoch must be base64") from error
        if not isinstance(raw_epoch, bytes):
            raise TypeError("model catalog cursor epoch must be bytes")
        generation = raw_cursor.get("generation")
        if isinstance(generation, bool) or not isinstance(generation, int):
            raise TypeError("model catalog cursor generation must be int")
        cursor = Cursor(epoch=raw_epoch, generation=generation)
    else:
        raise TypeError("model catalog event requires a Cursor")
    upserted = value.get("upserted")
    return ModelEvent(
        cursor=cursor,
        upserted=None if upserted is None else _model_card(upserted),
        removed_id=value.get("removed_id"),
        reset=value.get("reset") is True or isinstance(value.get("reset"), Mapping),
    )


async def models() -> tuple[ModelCard, ...]:
    """Read all resolved cards from the host-owned merged model catalog."""
    result = await _provider_control_request("omp.provider.models")
    if not isinstance(result, Iterable) or isinstance(
        result, (str, bytes, bytearray, Mapping)
    ):
        raise TypeError("omp.provider.models host result must be an iterable of ModelCard")
    return tuple(_model_card(card) for card in result)


async def _watch_model_events(
    since: Cursor | None,
) -> AsyncIterator[ModelEvent]:
    source = await _provider_control_request("omp.provider.watch_models", since=since)
    if hasattr(source, "__aiter__"):
        async for event in source:
            yield _model_event(event)
        return
    if not isinstance(source, Iterable) or isinstance(
        source, (str, bytes, bytearray, Mapping)
    ):
        raise TypeError("omp.provider.watch_models host result must be an event stream")
    for event in source:
        yield _model_event(event)

    def __post_init__(self) -> None:
        if not isinstance(self.epoch, bytes) or not self.epoch:
            raise ValueError("model catalog cursor epoch must be non-empty bytes")
        if (
            isinstance(self.generation, bool)
            or not isinstance(self.generation, int)
            or self.generation < 0
        ):
            raise ValueError("model catalog cursor generation must be non-negative")

class WatchModels:
    """Subscribe to typed updates from the host-owned merged model catalog."""

    __slots__ = ("since",)

    def __init__(self, since: Cursor | None = None) -> None:
        """Create a subscription optionally resuming after ``since``."""
        if since is not None and not isinstance(since, Cursor):
            raise TypeError("watch_models since must be Cursor or None")
        self.since = since

    def events(self) -> AsyncIterator[ModelEvent]:
        """Yield ordered catalog deltas until the host closes the stream."""
        return _watch_model_events(self.since)

    def __aiter__(self) -> AsyncIterator[ModelEvent]:
        """Iterate the host-fed model event stream."""
        return self.events()


def watch_models(since: Cursor | None = None) -> WatchModels:
    """Return a resumable merged-model catalog subscription."""
    return WatchModels(since)


@dataclass(frozen=True, slots=True)
class ModelRef:
    """Identify one provider model and API family."""

    provider: str
    api: str
    model: str


@dataclass(frozen=True, slots=True)
class RouteRef:
    """Identify one selected provider route."""

    provider: str
    route: str


class ErrorKind(StrEnum):
    """Classify a stable provider failure for policy decisions."""

    CANCELLED = "cancelled"
    DEADLINE_EXCEEDED = "deadline_exceeded"
    BUDGET_EXHAUSTED = "budget_exhausted"
    POLICY_BUFFER_EXCEEDED = "policy_buffer_exceeded"
    DNS = "dns"
    TLS = "tls"
    CONNECTIVITY = "connectivity"
    PROTOCOL = "protocol"
    STREAM_CORRUPTION = "stream_corruption"
    AUTHENTICATION = "authentication"
    CREDENTIAL_STORAGE_UNAVAILABLE = "credential_storage_unavailable"
    AUTHORIZATION = "authorization"
    ACCOUNT_DISABLED = "account_disabled"
    RATE_LIMITED = "rate_limited"
    QUOTA_EXHAUSTED = "quota_exhausted"
    PAYMENT_REQUIRED = "payment_required"
    INVALID_REQUEST = "invalid_request"
    TARGET_NOT_FOUND = "target_not_found"
    CAPABILITY_UNKNOWN = "capability_unknown"
    CODEC_MISMATCH = "codec_mismatch"
    ROUTE_UNAVAILABLE = "route_unavailable"
    STALE_PLAN = "stale_plan"
    REPLAY_REQUIRED = "replay_required"
    STAGING_REQUIRED = "staging_required"
    CAPABILITY_MISMATCH = "capability_mismatch"
    PROVIDER_CONTRACT_MISMATCH = "provider_contract_mismatch"
    CONTEXT_OVERFLOW = "context_overflow"
    CONTENT_FILTER = "content_filter"
    SAFETY_REFUSAL = "safety_refusal"
    MALFORMED_MODEL_OUTPUT = "malformed_model_output"
    STRUCTURED_OUTPUT_FAILURE = "structured_output_failure"
    TOOL_NON_COMPLIANCE = "tool_non_compliance"
    REPEATED_REASONING = "repeated_reasoning"
    REPEATED_TOOL_CALL = "repeated_tool_call"
    EMPTY_COMPLETION = "empty_completion"
    EMPTY_OUTPUT = "empty_output"
    SESSION_EXPIRED = "session_expired"
    SESSION_CONFLICT = "session_conflict"
    LOCAL_MODEL_UNAVAILABLE = "local_model_unavailable"
    RESOURCE_EXHAUSTED = "resource_exhausted"
    NATIVE_REQUEST_REJECTED = "native_request_rejected"
    INTERNAL_INVARIANT = "internal_invariant"


class Retryability(StrEnum):
    """Name the safe recovery lane for a classified attempt."""

    NEVER = "never"
    SAME_ROUTE = "same_route"
    AFTER_REPAIR = "after_repair"
    AFTER_CREDENTIAL = "after_credential"
    AFTER_DELAY = "after_delay"
    UNSPECIFIED = "unspecified"


@dataclass(frozen=True, slots=True)
class ProviderError:
    """Describe a structured failure from one provider attempt."""

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


class FailoverKind(StrEnum):
    """Select the recovery action represented by a failover verdict."""

    RETRY = "retry"
    REFRESH_CREDENTIAL = "refresh_credential"
    ROTATE_ACCOUNT = "rotate_account"
    RESELECT_ROUTE = "reselect_route"
    SWITCH_MODEL = "switch_model"
    RESEED_SESSION = "reseed_session"
    SEMANTIC_RETRY = "semantic_retry"
    FAIL = "fail"


@dataclass(frozen=True, slots=True)
class Failover:
    """Request one typed recovery action for a provider failure."""

    kind: FailoverKind
    after: Duration | None = None
    cooldown: Duration | None = None
    route: str | None = None
    target: str | None = None
    reason: str | None = None

    @staticmethod
    def retry(*, after: Duration | None = None, cooldown: Duration | None = None) -> Failover:
        """Retry the same attempt, optionally after a delay."""
        return Failover(FailoverKind.RETRY, after=after, cooldown=cooldown)

    @staticmethod
    def refresh_credential() -> Failover:
        """Refresh the current credential before retrying."""
        return Failover(FailoverKind.REFRESH_CREDENTIAL)

    @staticmethod
    def rotate_account(
        successor: str, *, cooldown: Duration | None = None
    ) -> Failover:
        """Rotate to the named successor identity before retrying."""
        if not isinstance(successor, str) or not successor:
            raise ValueError("successor identity must be a non-empty string")
        return Failover(
            FailoverKind.ROTATE_ACCOUNT, cooldown=cooldown, target=successor
        )

    @staticmethod
    def reselect_route(
        *, route: str | None = None, cooldown: Duration | None = None
    ) -> Failover:
        """Reselect a route, optionally preferring one route."""
        return Failover(FailoverKind.RESELECT_ROUTE, cooldown=cooldown, route=route)

    @staticmethod
    def switch_model(target: str, *, cooldown: Duration | None = None) -> Failover:
        """Switch to a fully qualified model target."""
        return Failover(FailoverKind.SWITCH_MODEL, cooldown=cooldown, target=target)

    @staticmethod
    def reseed_session() -> Failover:
        """Reseed provider-side session state before retrying."""
        return Failover(FailoverKind.RESEED_SESSION)

    @staticmethod
    def semantic_retry() -> Failover:
        """Retry through the bounded semantic-repair lane."""
        return Failover(FailoverKind.SEMANTIC_RETRY)

    @staticmethod
    def fail(reason: str | None = None) -> Failover:
        """Fail without further recovery."""
        return Failover(FailoverKind.FAIL, reason=reason)


class ModelFallback(StrEnum):
    """Choose selection-time behavior for an unavailable pinned model."""

    DENY = "deny"
    PARENT = "parent"
    CHAIN = "chain"


class AuthMethod(StrEnum):
    """Identify a provider login method."""

    API_KEY = "api_key"
    OAUTH_PKCE = "oauth_pkce"
    OAUTH_DEVICE = "oauth_device"
    OAUTH_PASTE = "oauth_paste"
    AWS_PROFILE = "aws_profile"
    ADC = "adc"
    SESSION = "session"


class LoginUi:
    """Provide reentrant user interaction during provider login."""

    async def prompt(self, text: str) -> str:
        """Prompt for a text value."""
        from . import ui

        outcome = await ui.input(text)
        if outcome.cancelled or outcome.value is None:
            raise RuntimeError("provider login prompt was dismissed")
        return outcome.value

    async def select(self, text: str, options: Sequence[str]) -> str:
        """Select one value from an ordered option list."""
        from . import ui

        outcome = await ui.select(text, options)
        if outcome.cancelled or outcome.value is None:
            raise RuntimeError("provider login selection was dismissed")
        return outcome.value

    async def open_url(self, url: str) -> None:
        """Open a login URL for the user."""
        from . import ui

        ui.open_url(url)

    async def notify(self, text: str, level: str) -> None:
        """Show a login notification."""
        from . import ui

        ui.notify(text, level=level)


@dataclass(frozen=True, slots=True)
class LoginRequest:
    """Request an extension-owned provider login flow."""

    provider: str
    method: AuthMethod
    ui: LoginUi


class RefreshReason(StrEnum):
    """Explain why a credential refresh was requested."""

    EXPIRING = "expiring"
    REJECTED_401 = "rejected_401"
    MANUAL = "manual"
    SCHEDULED = "scheduled"


@dataclass(frozen=True, slots=True)
class RefreshRequest:
    """Provide ephemeral material for one serialized credential refresh."""

    provider: str
    identity: str | None
    refresh_token: Secret | None
    expires_at_ms: int | None
    props: Mapping[str, int | str | bool]
    reason: RefreshReason


class Signer(Protocol):
    """Perform keyed signing operations without exposing key material."""

    async def hmac_sha256(self, message: bytes) -> bytes:
        """Compute an HMAC-SHA256 digest."""
        ...

    async def jwt(self, claims: Mapping[str, object], algorithm: str) -> str:
        """Sign a JSON Web Token."""
        ...

    async def attest(self, challenge: bytes) -> bytes:
        """Produce a platform attestation response."""
        ...


@dataclass(frozen=True, slots=True)
class SignRequest:
    """Describe one provider request requiring extension-owned signing."""

    provider: str
    route: str
    method: str
    url: str
    headers: Mapping[str, str]
    body_sha256: bytes
    signer: Signer


@dataclass(frozen=True, slots=True)
class Signature:
    """Carry signer-produced headers and query parameters."""

    headers: Mapping[str, str]
    query: Mapping[str, str] = _EMPTY_MAP


class Fallback(StrEnum):
    """Choose behavior when a provider cannot honor an intent."""

    UNSPECIFIED = "unspecified"
    ERROR = "error"
    IGNORE = "ignore"
    EMULATE = "emulate"


class IntentKind(StrEnum):
    """Identify one negotiated inference capability intent."""

    STRICT = "strict"
    GRAMMAR = "grammar"
    FORCE_CALL = "force_call"
    SERVICE_TIER = "service_tier"
    VERBOSITY = "verbosity"
    CACHE_RETENTION = "cache_retention"
    REASONING = "reasoning"
    SAFETY = "safety"
    DETERMINISM = "determinism"
    HOSTED_TOOL = "hosted_tool"


@dataclass(frozen=True, slots=True)
class Intent:
    """Declare a negotiated inference capability request."""

    kind: IntentKind
    on_unsupported: Fallback = Fallback.UNSPECIFIED
    priority: int = 0
    payload: object = None


class _IntentConstructors:
    """Build immutable provider intent declarations."""

    __slots__ = ()

    @staticmethod
    def _make(
        kind: IntentKind,
        payload: object = None,
        *,
        on_unsupported: Fallback,
        priority: int,
    ) -> Intent:
        if not isinstance(on_unsupported, Fallback):
            raise SpecError("intent on_unsupported must be Fallback")
        if (
            isinstance(priority, bool)
            or not isinstance(priority, int)
            or not 0 <= priority <= 0xFFFFFFFF
        ):
            raise SpecError("intent priority must be an unsigned 32-bit integer")
        return Intent(kind, on_unsupported, priority, payload)

    def strict(
        self, *, on_unsupported: Fallback = Fallback.EMULATE, priority: int = 0
    ) -> Intent:
        """Request server-side strict JSON-Schema enforcement."""
        return self._make(
            IntentKind.STRICT, on_unsupported=on_unsupported, priority=priority
        )

    def grammar(
        self,
        syntax: object,
        definition: str,
        *,
        on_unsupported: Fallback = Fallback.EMULATE,
        priority: int = 0,
    ) -> Intent:
        """Request provider-native constrained grammar decoding."""
        if not isinstance(definition, str) or not definition:
            raise SpecError("grammar intent definition must be a non-empty string")
        return self._make(
            IntentKind.GRAMMAR,
            {"syntax": syntax, "definition": definition},
            on_unsupported=on_unsupported,
            priority=priority,
        )

    def force_call(
        self,
        name: str | None = None,
        *,
        retries: int = 2,
        allow_costly_escalation: bool = True,
        on_unsupported: Fallback = Fallback.EMULATE,
        priority: int = 0,
    ) -> Intent:
        """Request the bounded forced-tool-call ladder."""
        if name is not None and (not isinstance(name, str) or not name):
            raise SpecError("forced call name must be a non-empty string or None")
        if isinstance(retries, bool) or not isinstance(retries, int) or retries < 0:
            raise SpecError("forced call retries must be a non-negative integer")
        if not isinstance(allow_costly_escalation, bool):
            raise SpecError("allow_costly_escalation must be bool")
        return self._make(
            IntentKind.FORCE_CALL,
            {
                "name": name,
                "retries": retries,
                "allow_costly_escalation": allow_costly_escalation,
            },
            on_unsupported=on_unsupported,
            priority=priority,
        )

    def service_tier(
        self,
        name: str,
        *,
        on_unsupported: Fallback = Fallback.IGNORE,
        priority: int = 0,
    ) -> Intent:
        """Select one provider-declared service tier."""
        if not isinstance(name, str) or not name:
            raise SpecError("service tier intent name must be a non-empty string")
        return self._make(
            IntentKind.SERVICE_TIER,
            name,
            on_unsupported=on_unsupported,
            priority=priority,
        )

    def verbosity(
        self,
        level: object,
        *,
        on_unsupported: Fallback = Fallback.UNSPECIFIED,
        priority: int = 0,
    ) -> Intent:
        """Select provider response verbosity."""
        return self._make(
            IntentKind.VERBOSITY,
            level,
            on_unsupported=on_unsupported,
            priority=priority,
        )

    def cache_retention(
        self,
        retention: CacheRetention,
        *,
        on_unsupported: Fallback = Fallback.UNSPECIFIED,
        priority: int = 0,
    ) -> Intent:
        """Select provider prompt-cache retention."""
        if not isinstance(retention, CacheRetention):
            raise SpecError("cache retention intent must be CacheRetention")
        return self._make(
            IntentKind.CACHE_RETENTION,
            retention,
            on_unsupported=on_unsupported,
            priority=priority,
        )

    def reasoning(
        self,
        effort: Effort | None = None,
        budget_tokens: int | None = None,
        visibility: object = None,
        preserve_signatures: bool = True,
        *,
        on_unsupported: Fallback = Fallback.UNSPECIFIED,
        priority: int = 0,
    ) -> Intent:
        """Request provider reasoning controls."""
        if effort is not None and not isinstance(effort, Effort):
            raise SpecError("reasoning effort must be Effort or None")
        if budget_tokens is not None and (
            isinstance(budget_tokens, bool)
            or not isinstance(budget_tokens, int)
            or budget_tokens < 0
        ):
            raise SpecError("reasoning budget_tokens must be a non-negative integer or None")
        if not isinstance(preserve_signatures, bool):
            raise SpecError("preserve_signatures must be bool")
        return self._make(
            IntentKind.REASONING,
            {
                "effort": effort,
                "budget_tokens": budget_tokens,
                "visibility": visibility,
                "preserve_signatures": preserve_signatures,
            },
            on_unsupported=on_unsupported,
            priority=priority,
        )

    def safety(
        self,
        category: object,
        threshold: object,
        *,
        on_unsupported: Fallback = Fallback.UNSPECIFIED,
        priority: int = 0,
    ) -> Intent:
        """Request one provider safety threshold."""
        return self._make(
            IntentKind.SAFETY,
            {"category": category, "threshold": threshold},
            on_unsupported=on_unsupported,
            priority=priority,
        )

    def determinism(
        self,
        seed: int | None = None,
        deterministic: bool = False,
        *,
        on_unsupported: Fallback = Fallback.UNSPECIFIED,
        priority: int = 0,
    ) -> Intent:
        """Request deterministic sampling or one explicit seed."""
        if seed is not None and (isinstance(seed, bool) or not isinstance(seed, int)):
            raise SpecError("determinism seed must be an integer or None")
        if not isinstance(deterministic, bool):
            raise SpecError("deterministic must be bool")
        return self._make(
            IntentKind.DETERMINISM,
            {"seed": seed, "deterministic": deterministic},
            on_unsupported=on_unsupported,
            priority=priority,
        )

    def hosted_tool(
        self,
        tool: HostedTool,
        *,
        on_unsupported: Fallback = Fallback.UNSPECIFIED,
        priority: int = 0,
    ) -> Intent:
        """Request one provider-hosted tool."""
        if not isinstance(tool, HostedTool):
            raise SpecError("hosted tool intent must be HostedTool")
        return self._make(
            IntentKind.HOSTED_TOOL,
            tool,
            on_unsupported=on_unsupported,
            priority=priority,
        )


intent = _IntentConstructors()
"""Provider intent constructor namespace."""


class _Intents:
    """Manage this extension's keyed session-level intent contributions."""

    __slots__ = ()

    @staticmethod
    def _validate(key: str, values: tuple[Intent, ...]) -> None:
        if not isinstance(key, str) or not key:
            raise SpecError("intent contribution key must be a non-empty string")
        if not all(isinstance(value, Intent) for value in values):
            raise SpecError("intent contributions must contain only Intent values")
        for value in values:
            if not isinstance(value.kind, IntentKind):
                raise SpecError("intent kind must be IntentKind")
            if not isinstance(value.on_unsupported, Fallback):
                raise SpecError("intent on_unsupported must be Fallback")
            if (
                isinstance(value.priority, bool)
                or not isinstance(value.priority, int)
                or not 0 <= value.priority <= 0xFFFFFFFF
            ):
                raise SpecError("intent priority must be an unsigned 32-bit integer")

    @staticmethod
    def _emit(operation: str, **arguments: object) -> None:
        from . import _control_backend

        backend = _control_backend.get()
        sink = getattr(backend, "intent_effect", None)
        if not callable(sink):
            raise NotWiredError(f"{operation} CONTROL effect dispatch is not wired")
        sink(operation, arguments)

    def set(self, key: str, /, *values: Intent) -> None:
        """Queue replacement of one keyed contribution for host arbitration."""
        self._validate(key, values)
        self._emit("omp.intents.set", key=key, intents=values)

    def clear(self, key: str, /) -> None:
        """Queue removal of one keyed contribution for host arbitration."""
        self._validate(key, ())
        self._emit("omp.intents.clear", key=key)

    def declared(self, key: str | None = None, /) -> tuple[Intent, ...]:
        """Return no speculative state; accepted contributions live in the host."""
        if key is not None:
            self._validate(key, ())
            return ()
        return ()


intents = _Intents()


@dataclass(frozen=True, slots=True)
class RequestDraft:
    """Expose bounded request metadata to a pre-encoding hook."""

    provider: str
    route: str
    model: str
    operation: Operation
    scalars: Mapping[str, int | float | str | bool]
    headers: Mapping[str, str]
    intents: tuple[Intent, ...]
    message_count: int
    approx_prompt_tokens: int | None


@dataclass(frozen=True, slots=True)
class RequestMutation:
    """Describe a shallow request-body and header mutation."""

    body: Mapping[str, object] = _EMPTY_MAP
    headers: Mapping[str, str | None] = _EMPTY_MAP
    timeout: Duration | None = None


class DiscoveryTrigger(StrEnum):
    """Identify what initiated provider model discovery."""

    SESSION_START = "session_start"
    INTERVAL = "interval"
    MANUAL = "manual"
    POST_LOGIN = "post_login"


@dataclass(frozen=True, slots=True)
class DiscoveryQuery:
    """Request one page of provider model discovery."""

    provider: str
    route: str
    cursor: str | None
    page_size: int | None
    trigger: DiscoveryTrigger


@dataclass(frozen=True, slots=True)
class DiscoveryPage:
    """Return one page of dynamically discovered models."""

    models: tuple[ModelSpec, ...]
    next_cursor: str | None = None
    authoritative: bool = False


@dataclass(frozen=True, slots=True)
class SearchQuery:
    """Request one page from a provider-backed web search."""

    provider: str
    query: str
    count: int
    offset: int | None = None


@dataclass(frozen=True, slots=True)
class SearchResult:
    """Represent one normalized ranked web search result."""

    title: str
    url: str
    snippet: str
    rank: int


@dataclass(frozen=True, slots=True)
class SearchPage:
    """Return one normalized page of provider-backed search results."""

    results: tuple[SearchResult, ...]
    next_offset: int | None = None


class UsageScope(StrEnum):
    """Select the provider usage scope to query."""

    CURRENT = "current"
    BILLING = "billing"
    RATE_LIMIT = "rate_limit"
    ALL = "all"


class UsageUnit(StrEnum):
    """Identify the unit used by a provider usage window."""

    REQUESTS = "requests"
    TOKENS = "tokens"
    PREMIUM_UNITS = "premium_units"
    NANOS_USD = "nanos_usd"


@dataclass(frozen=True, slots=True)
class UsageQuery:
    """Request provider usage with one callback-scoped, redacting API key."""

    provider: str
    identity: str | None
    scope: UsageScope
    allow_stale: bool
    api_key: Secret | None = None


@dataclass(frozen=True, slots=True)
class UsageWindow:
    """Describe one provider quota or billing window."""

    id: str
    used: int | None = None
    limit: int | None = None
    fraction: Decimal | None = None
    resets_at_ms: int | None = None
    unit: UsageUnit = UsageUnit.REQUESTS


@dataclass(frozen=True, slots=True)
class UsageReport:
    """Aggregate provider usage windows and account balance metadata."""

    windows: tuple[UsageWindow, ...]
    balance_nanos_usd: int | None = None
    plan: str | None = None
    observed_at_ms: int | None = None


class CredentialKind(StrEnum):
    """Identify the material carried by a provider credential."""

    API_KEY = "api_key"
    BEARER = "bearer"
    OAUTH = "oauth"
    AWS = "aws"
    SESSION = "session"


@dataclass(frozen=True, slots=True)
class Credential:
    """Carry provider credential material returned by login or refresh."""

    kind: CredentialKind
    secret: Secret
    refresh_token: Secret | None = None
    expires_at_ms: int | None = None
    identity: str | None = None
    props: Mapping[str, int | str | bool] = _EMPTY_MAP


def provider(
    spec: ProviderSpec,
    /,
    *,
    priority: int = 0,
    extends: str | None = None,
    replaces: str | None = None,
) -> ProviderHandle:
    """Declare the provider immediately and return its optional decorator handle."""
    if not isinstance(spec, ProviderSpec):
        raise SpecError("omp.provider requires a ProviderSpec")
    if isinstance(priority, bool) or not isinstance(priority, int):
        raise SpecError("provider priority must be an integer")
    if extends is not None and (not isinstance(extends, str) or not extends):
        raise SpecError("provider extends must be a non-empty provider id")
    if spec.model_overlays and extends is None:
        raise SpecError("model_overlays require provider(..., extends=...)")
    handle = ProviderHandle(
        spec, priority=priority, extends=extends, replaces=replaces
    )
    registry.register_provider(spec.id,
        spec,
        priority=priority,
        extends=extends,
        replaces=replaces,)
    return handle


__all__ = (
    "AccountScope", "Api", "AudioFormat", "AuthMethod", "AuthMode", "AuthSpec", "Availability",
    "CacheRetention", "Cap", "CatalogAlias", "ChatCaps", "CodecProfile", "CompatFlags",
    "Completion", "Confidence", "ContextSpec", "Cost", "CostTier", "Credential", "CredentialKind",
    "Cursor",
    "CredentialSource", "Dimensions", "DiscoveryDefaults", "DiscoveryKind", "DiscoveryPage",
    "DiscoveryQuery", "DiscoverySpec", "DiscoveryTrigger", "Effort", "EmulationPolicy",
    "ErrorKind", "Facet", "Failover",
    "FailoverKind", "HostedTool", "ImageCaps", "ImageFeature", "ImageFormat", "ImageRequest",
    "ImageResult",
    "Fallback", "SpeechCaps", "SpeechFeature", "SpeechRequest", "SpeechResult", "Intent", "IntentKind", "LoginRequest", "LoginUi", "LogprobCaps",
    "ManagementSpec", "MismatchPolicy", "Modality", "ModelCard", "ModelEvent", "ModelFallback",
    "ModelOverlay",
    "ModelPatch", "ModelRef", "ModelSpec", "OAuthFlow",
    "NegotiationPolicy", "OAuthFlowKind", "OAuthSpec", "Operation", "Pagination", "Price",
    "PriceUnit",
    "PrincipalResolution", "PromptCacheCaps", "ProviderError", "ProviderHandle", "ProviderSpec",
    "ReasoningCaps", "RealtimeCaps", "RealtimeCredentialRef", "RealtimeEagerness",
    "RealtimeEndpointRef", "RealtimeFeature", "RealtimeModality", "RealtimeRequest",
    "RealtimeSession", "RealtimeTurnDetectionMode",
    "RedirectTrust", "RefreshBehavior", "RefreshReason", "RefreshRequest", "RequestDraft",
    "RequestMutation", "Retryability", "Role", "RouteLimits", "RouteRef", "RouteSpec",
    "StreamWatchdog",
    "ScopedAlias",
    "SearchPage", "SearchQuery", "SearchResult", "ServerStateCaps", "ServiceTier", "Setting",
    "SettingKind",
    "SignRequest", "SpecError", "TranscriptionCaps", "TranscriptionFeature",
        "TranscriptionRequest", "TranscriptionResult", "Signature", "Signer", "ThinkingMode", "ThinkingSpec", "TokenPlacement",
    "TurnDetection",
    "ToolCaps", "ToolFeature", "ToolSchemaFlavor", "Transport", "TrustDomain",
    "UnknownCapabilityPolicy", "UsageQuery",
    "UsageReport", "UsageScope", "UsageUnit", "UsageWindow", "WatchModels", "models",
    "intents", "intent", "provider", "watch_models",
)


import sys as _sys
import types as _types


class _CallableProviderModule(_types.ModuleType):
    def __call__(self, *args: Any, **kwargs: Any) -> ProviderHandle:
        """Delegate callable-module registration to :func:`provider`."""
        return provider(*args, **kwargs)


_sys.modules[__name__].__class__ = _CallableProviderModule
del _sys, _types
