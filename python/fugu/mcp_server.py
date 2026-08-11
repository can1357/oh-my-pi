"""MCP server for pi-llm-as-verifier.

Exposes the core fusion-meta-harness operations as MCP tools so any MCP client
(Claude Desktop, Cursor, Zed, etc.) can call the verifier without touching the CLI.

Start:
    python mcp_server.py                              # stdio (default)
    python mcp_server.py --transport streamable-http # modern remote transport
    python mcp_server.py --transport sse             # legacy compatibility transport

Or via the installed entry point:
    fmh-mcp

Tools exposed:
    verifier_fusion_compare  — swap-and-aggregate pairwise compare
    verifier_fusion_audit    — single-candidate rubric scoring
    evaluate_verifier        — run accuracy/flag-recall report against a fixture suite
    run_task                 — full fusion pipeline from a TaskContract JSON file
    inspect_run              — retrieve stored run result JSON
    frontier                 — list frontier candidates from SQLite index
    rqgm_search              — Red Queen Godel Machine co-evolutionary search
"""

from __future__ import annotations

import functools
import inspect
import importlib.util
import json
import os
import sys
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version as distribution_version
from ipaddress import ip_address
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

try:
    import anyio
    import jwt
    from mcp import MCPError
    from mcp.server import MCPServer
    from mcp.server.auth.provider import AccessToken, TokenVerifier
    from mcp.server.auth.settings import AuthSettings
    from mcp.server.context import CallNext, HandlerResult, ServerRequestContext
    from mcp.server.mcpserver.context import Context
    from mcp.server.transport_security import TransportSecuritySettings
    from mcp_types import (
        Completion,
        CompletionArgument,
        CompletionContext,
        INVALID_PARAMS,
        PROTOCOL_VERSION_META_KEY,
        PromptReference,
        ResourceTemplateReference,
    )
    from mcp_types.version import MODERN_PROTOCOL_VERSIONS
    from starlette.types import ASGIApp, Message, Receive, Scope, Send
except ModuleNotFoundError as exc:  # pragma: no cover - install-ergonomics guard
    raise ModuleNotFoundError(
        "The 'mcp' package is required to run the pi-llm-as-verifier MCP server but is "
        "not installed. It ships as an optional extra — install it with:\n"
        "    pip install -e .[mcp]\n"
        "(or `pip install 'mcp>=2.0.0,<3'`)."
    ) from exc

try:
    _SERVER_VERSION = distribution_version("fusion-meta-harness")
except PackageNotFoundError:
    # The module is also run directly from a source checkout, where distribution
    # metadata may not exist yet. Keep that server identity stable and meaningful.
    _SERVER_VERSION = "0.1.0"

_PROTOCOL_VERSION_HEADER = b"mcp-protocol-version"
_MODERN_ROUTE_SENTINEL = b"body-metadata-modern"

_REMOTE_MCP_PATH = "/mcp"
_ASYMMETRIC_JWT_ALGORITHMS = frozenset(
    {
        "RS256",
        "RS384",
        "RS512",
        "PS256",
        "PS384",
        "PS512",
        "ES256",
        "ES384",
        "ES512",
        "EdDSA",
    }
)
_JWT_CLOCK_SKEW_SECONDS = 60
_DEFAULT_JWKS_CACHE_SECONDS = 300
_MAX_JWKS_CACHE_SECONDS = 3600
_JWKS_REQUEST_TIMEOUT_SECONDS = 5


def _required_env(name: str, environ: Mapping[str, str]) -> str:
    value = environ.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} must be configured for non-loopback Streamable HTTP")
    return value


def _https_url(name: str, value: str, *, required_path: str | None = None) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path != (required_path if required_path is not None else parsed.path)
    ):
        expected = f" with path {required_path!r}" if required_path is not None else ""
        raise ValueError(f"{name} must be an absolute canonical HTTPS URL{expected}")
    return value


def _space_delimited_values(name: str, value: str) -> tuple[str, ...]:
    values = tuple(value.split())
    if not values or any(not item for item in values):
        raise ValueError(f"{name} must contain at least one value")
    return values


@dataclass(frozen=True)
class RemoteAuthConfig:
    """Explicit OAuth resource-server configuration for a public MCP endpoint."""

    issuer_url: str
    resource_server_url: str
    required_scopes: tuple[str, ...]
    jwks_url: str
    jwt_algorithms: tuple[str, ...]
    allowed_hosts: tuple[str, ...]
    allowed_origins: tuple[str, ...]
    jwks_cache_seconds: int = _DEFAULT_JWKS_CACHE_SECONDS

    def __post_init__(self) -> None:
        """Keep direct programmatic construction as strict as environment parsing."""
        _https_url(
            "resource_server_url",
            self.resource_server_url,
            required_path=_REMOTE_MCP_PATH,
        )
        _https_url("issuer_url", self.issuer_url)
        _https_url("jwks_url", self.jwks_url)
        if not self.required_scopes or not all(isinstance(scope, str) and scope for scope in self.required_scopes):
            raise ValueError("required_scopes must contain at least one nonempty scope")
        if not self.allowed_hosts or not all(isinstance(host, str) and host for host in self.allowed_hosts):
            raise ValueError("allowed_hosts must contain at least one exact host")
        if not self.allowed_origins or not all(
            isinstance(origin, str) and origin for origin in self.allowed_origins
        ):
            raise ValueError("allowed_origins must contain at least one exact origin")
        if not self.jwt_algorithms or not all(
            isinstance(algorithm, str) and algorithm in _ASYMMETRIC_JWT_ALGORITHMS
            for algorithm in self.jwt_algorithms
        ):
            raise ValueError("jwt_algorithms must contain only approved asymmetric algorithms")
        if not 1 <= self.jwks_cache_seconds <= _MAX_JWKS_CACHE_SECONDS:
            raise ValueError(
                f"jwks_cache_seconds must be between 1 and {_MAX_JWKS_CACHE_SECONDS}"
            )

    @classmethod
    def from_environment(
        cls,
        environ: Mapping[str, str] | None = None,
    ) -> "RemoteAuthConfig":
        env = os.environ if environ is None else environ
        mode = env.get("FUGU_MCP_AUTH_MODE", "").strip().casefold()
        if mode != "jwt":
            raise ValueError(
                "Streamable HTTP may bind only to a loopback host unless "
                "FUGU_MCP_AUTH_MODE is 'jwt' with complete OAuth configuration"
            )

        resource_server_url = _https_url(
            "FUGU_MCP_PUBLIC_URL",
            _required_env("FUGU_MCP_PUBLIC_URL", env),
            required_path=_REMOTE_MCP_PATH,
        )
        issuer_url = _https_url(
            "FUGU_MCP_OAUTH_ISSUER",
            _required_env("FUGU_MCP_OAUTH_ISSUER", env),
        )
        jwks_url = _https_url(
            "FUGU_MCP_JWKS_URL",
            _required_env("FUGU_MCP_JWKS_URL", env),
        )
        required_scopes = _space_delimited_values(
            "FUGU_MCP_REQUIRED_SCOPES",
            _required_env("FUGU_MCP_REQUIRED_SCOPES", env),
        )
        allowed_hosts = _space_delimited_values(
            "FUGU_MCP_ALLOWED_HOSTS",
            _required_env("FUGU_MCP_ALLOWED_HOSTS", env),
        )
        allowed_origins = _space_delimited_values(
            "FUGU_MCP_ALLOWED_ORIGINS",
            _required_env("FUGU_MCP_ALLOWED_ORIGINS", env),
        )
        algorithms = _space_delimited_values(
            "FUGU_MCP_JWT_ALGORITHMS",
            _required_env("FUGU_MCP_JWT_ALGORITHMS", env).replace(",", " "),
        )
        unsupported_algorithms = set(algorithms) - _ASYMMETRIC_JWT_ALGORITHMS
        if unsupported_algorithms:
            raise ValueError(
                "FUGU_MCP_JWT_ALGORITHMS may contain only configured asymmetric "
                f"algorithms, not {', '.join(sorted(unsupported_algorithms))}"
            )
        try:
            jwks_cache_seconds = int(
                env.get("FUGU_MCP_JWKS_CACHE_SECONDS", str(_DEFAULT_JWKS_CACHE_SECONDS))
            )
        except ValueError as exc:
            raise ValueError("FUGU_MCP_JWKS_CACHE_SECONDS must be an integer") from exc
        if not 1 <= jwks_cache_seconds <= _MAX_JWKS_CACHE_SECONDS:
            raise ValueError(
                f"FUGU_MCP_JWKS_CACHE_SECONDS must be between 1 and {_MAX_JWKS_CACHE_SECONDS}"
            )
        return cls(
            issuer_url=issuer_url,
            resource_server_url=resource_server_url,
            required_scopes=required_scopes,
            jwks_url=jwks_url,
            jwt_algorithms=algorithms,
            allowed_hosts=allowed_hosts,
            allowed_origins=allowed_origins,
            jwks_cache_seconds=jwks_cache_seconds,
        )

    def transport_security(self) -> TransportSecuritySettings:
        return TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=list(self.allowed_hosts),
            allowed_origins=list(self.allowed_origins),
        )


class JwksJwtTokenVerifier(TokenVerifier):
    """Validate provider-issued asymmetric JWTs using a bounded JWKS cache."""

    def __init__(self, config: RemoteAuthConfig, *, jwk_client: Any | None = None) -> None:
        self._config = config
        self._jwk_client = jwk_client or jwt.PyJWKClient(
            config.jwks_url,
            cache_keys=True,
            cache_jwk_set=True,
            lifespan=config.jwks_cache_seconds,
            timeout=_JWKS_REQUEST_TIMEOUT_SECONDS,
        )

    async def verify_token(self, token: str) -> AccessToken | None:
        # PyJWKClient performs synchronous HTTPS I/O on a cache miss. Keep it off
        # the ASGI event loop; every parsing, verification, and I/O failure fails
        # closed and is intentionally indistinguishable to the caller.
        return await anyio.to_thread.run_sync(self._verify, token)

    def _verify(self, token: str) -> AccessToken | None:
        try:
            header = jwt.get_unverified_header(token)
            algorithm = header.get("alg")
            kid = header.get("kid")
            if (
                algorithm not in self._config.jwt_algorithms
                or algorithm not in _ASYMMETRIC_JWT_ALGORITHMS
                or not isinstance(kid, str)
                or not kid
            ):
                return None
            signing_key = self._jwk_client.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=list(self._config.jwt_algorithms),
                audience=self._config.resource_server_url,
                issuer=self._config.issuer_url,
                leeway=_JWT_CLOCK_SKEW_SECONDS,
                options={"require": ["exp", "iat", "iss", "aud"]},
            )
            scopes = _token_scopes(claims)
            client_id = claims.get("client_id") or claims.get("azp")
            subject = claims.get("sub")
            expires_at = claims.get("exp")
            if (
                not scopes
                or not isinstance(client_id, str)
                or not client_id
                or not isinstance(subject, str)
                or not subject
                or isinstance(expires_at, bool)
                or not isinstance(expires_at, (int, float))
            ):
                return None
            return AccessToken(
                token=token,
                client_id=client_id,
                scopes=sorted(scopes),
                expires_at=int(expires_at),
                resource=self._config.resource_server_url,
                subject=subject,
                claims={"iss": self._config.issuer_url},
            )
        except Exception:  # noqa: BLE001 - invalid credentials must not disclose cause
            return None


def _token_scopes(claims: Mapping[str, Any]) -> set[str]:
    """Return normalized provider scopes, rejecting malformed values."""
    scope = claims.get("scope")
    if isinstance(scope, str):
        return set(scope.split()) if scope.strip() else set()
    scp = claims.get("scp")
    if isinstance(scp, list) and all(isinstance(item, str) and item for item in scp):
        return set(scp)
    return set()


def _streamable_http_bind_is_safe(
    host: str,
    transport_security: TransportSecuritySettings | None,
) -> bool:
    """Return whether an HTTP bind is loopback or has an explicit header policy."""
    normalized = host.removeprefix("[").removesuffix("]")
    try:
        loopback = ip_address(normalized).is_loopback
    except ValueError:
        loopback = normalized.casefold() == "localhost"
    if loopback:
        return True
    return bool(
        transport_security is not None
        and transport_security.enable_dns_rebinding_protection
        and transport_security.allowed_hosts
        and transport_security.allowed_origins
    )


def _require_safe_streamable_http_bind(
    host: str,
    transport_security: TransportSecuritySettings | None,
) -> None:
    if not _streamable_http_bind_is_safe(host, transport_security):
        raise ValueError(
            "Streamable HTTP may bind only to a loopback host unless explicit "
            "DNS-rebinding protection configures both allowed_hosts and allowed_origins"
        )


class _ModernBodyMetadataRouter:
    """Route modern body metadata into the SDK's stateless validation path."""

    def __init__(self, app: ASGIApp, max_request_body_size: int) -> None:
        self.app = app
        self.max_request_body_size = max_request_body_size

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") != "POST":
            await self.app(scope, receive, send)
            return

        buffered: deque[Message] = deque()
        body_parts: list[bytes] = []
        body_size = 0
        complete = False
        while body_size <= self.max_request_body_size:
            message = await receive()
            buffered.append(message)
            if message["type"] != "http.request":
                break
            part = message.get("body", b"")
            body_parts.append(part)
            body_size += len(part)
            if not message.get("more_body", False):
                complete = True
                break

        async def replay() -> Message:
            if buffered:
                return buffered.popleft()
            return await receive()

        if complete:
            try:
                decoded = json.loads(b"".join(body_parts))
            except (TypeError, ValueError, RecursionError):
                decoded = None
            params = decoded.get("params") if isinstance(decoded, Mapping) else None
            meta = params.get("_meta") if isinstance(params, Mapping) else None
            body_version = meta.get(PROTOCOL_VERSION_META_KEY) if isinstance(meta, Mapping) else None
            if body_version in MODERN_PROTOCOL_VERSIONS:
                headers = list(scope.get("headers", []))
                header_versions = [
                    value
                    for key, value in headers
                    if key.lower() == _PROTOCOL_VERSION_HEADER
                ]
                expected = body_version.encode("ascii")
                if header_versions != [expected]:
                    # The SDK manager currently selects the stateless modern path
                    # from the header before its classifier compares header/body.
                    # A synthetic unknown version selects that path; retaining any
                    # mismatched original header lets SDK validation own the error.
                    scope = dict(scope)
                    scope["headers"] = [
                        (_PROTOCOL_VERSION_HEADER, _MODERN_ROUTE_SENTINEL),
                        *headers,
                    ]

        await self.app(scope, replay, send)


def _unknown_modern_tool_middleware(
    server_holder: dict[str, "_FuguMCPServer"],
) -> CallNext:
    async def reject_unknown_modern_tool(
        ctx: ServerRequestContext[Any, Any],
        call_next: CallNext,
    ) -> HandlerResult:
        """Keep unknown modern tool names as JSON-RPC INVALID_PARAMS errors."""
        if ctx.protocol_version in MODERN_PROTOCOL_VERSIONS and ctx.method == "tools/call":
            params = ctx.params
            name = params.get("name") if isinstance(params, Mapping) else None
            if isinstance(name, str):
                known_names = {tool.name for tool in await server_holder["server"].list_tools()}
                if name not in known_names:
                    raise MCPError(code=INVALID_PARAMS, message=f"Unknown tool: {name}")
        return await call_next(ctx)

    return reject_unknown_modern_tool


class _FuguMCPServer(MCPServer):
    """MCPServer with Fugu's remote-bind and era-routing invariants."""

    def streamable_http_app(
        self,
        *,
        host: str = "127.0.0.1",
        transport_security: TransportSecuritySettings | None = None,
        max_request_body_size: int = 4 * 1024 * 1024,
        **kwargs: Any,
    ):
        _require_safe_streamable_http_bind(host, transport_security)
        app = super().streamable_http_app(
            host=host,
            transport_security=transport_security,
            max_request_body_size=max_request_body_size,
            **kwargs,
        )
        app.add_middleware(
            _ModernBodyMetadataRouter,
            max_request_body_size=max_request_body_size,
        )
        return app


def _new_server(
    *,
    auth: AuthSettings | None = None,
    token_verifier: TokenVerifier | None = None,
) -> _FuguMCPServer:
    """Construct a local or OAuth-protected server with its own tool middleware."""
    holder: dict[str, _FuguMCPServer] = {}
    server = _FuguMCPServer(
        "pi-llm-as-verifier",
        version=_SERVER_VERSION,
        auth=auth,
        token_verifier=token_verifier,
        middleware=[_unknown_modern_tool_middleware(holder)],
    )
    holder["server"] = server
    return server


# The published fmh-mcp entry point and all local transports deliberately remain
# independent of remote OAuth configuration.
mcp = _new_server()

_FUGU_PRODUCT_ROOT = Path(__file__).parent
_RQGM_REVIEWER_PROMPT = _FUGU_PRODUCT_ROOT / "prompts" / "rqgm_reviewer.md"
_KNOWLEDGE_INDEX = _FUGU_PRODUCT_ROOT / "knowledge" / "index.md"
_KNOWLEDGE_DOCUMENT_URI = "fugu://knowledge/{document}"


def _read_product_asset(path: Path) -> str:
    """Read a fixed, shipped Fugu asset rather than a client-supplied path."""
    return path.read_text(encoding="utf-8")



def _knowledge_documents() -> dict[str, Path]:
    """Expose only named Markdown documents shipped in Fugu's knowledge bundle."""
    return {path.stem: path for path in _KNOWLEDGE_INDEX.parent.glob("*.md") if path.is_file()}

def _register_product_primitives(server: _FuguMCPServer) -> None:
    """Register the small, public catalogue shared by local and remote servers."""

    @server.resource(
        "fugu://knowledge/index",
        name="fugu_knowledge_index",
        title="Fugu knowledge index",
        description="Product-maintained index of Fugu's published verifier and fusion findings.",
        mime_type="text/markdown",
    )
    def fugu_knowledge_index() -> str:
        return _read_product_asset(_KNOWLEDGE_INDEX)

    @server.resource(
        _KNOWLEDGE_DOCUMENT_URI,
        name="fugu_knowledge_document",
        title="Fugu knowledge document",
        description="One named Markdown document from Fugu's shipped knowledge bundle.",
        mime_type="text/markdown",
    )
    def fugu_knowledge_document(document: str) -> str:
        document_path = _knowledge_documents().get(document)
        if document_path is None:
            raise ValueError(f"unknown Fugu knowledge document: {document!r}")
        return _read_product_asset(document_path)

    @server.prompt(
        name="review_rqgm_candidate",
        title="Review an RQGM candidate",
        description="Apply Fugu's shipped RQGM reviewer instructions to one candidate answer.",
    )
    def review_rqgm_candidate(candidate: str) -> str:
        """Return the product reviewer prompt with the candidate to evaluate."""
        return f"{_read_product_asset(_RQGM_REVIEWER_PROMPT)}\n\nCandidate answer:\n{candidate}"

    @server.completion()
    async def complete_product_reference(
        ref: PromptReference | ResourceTemplateReference,
        argument: CompletionArgument,
        _context: CompletionContext | None,
    ) -> Completion | None:
        """Complete only the safe, product-owned knowledge-document template argument."""
        if (
            not isinstance(ref, ResourceTemplateReference)
            or ref.uri != _KNOWLEDGE_DOCUMENT_URI
            or argument.name != "document"
        ):
            return None
        partial = argument.value.casefold()
        values = sorted(name for name in _knowledge_documents() if name.casefold().startswith(partial))
        return Completion(values=values, total=len(values), hasMore=False)


_register_product_primitives(mcp)


def _tool_safe(fn):
    """Wrap synchronous and asynchronous tool bodies in structured JSON errors."""
    if inspect.iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def async_wrapper(*args, **kwargs):
            try:
                return await fn(*args, **kwargs)
            except Exception as exc:  # noqa: BLE001 - surface as JSON, never a raw traceback
                return json.dumps({"error": str(exc), "error_type": type(exc).__name__})

        return async_wrapper

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 - surface as JSON, never a raw traceback
            return json.dumps({"error": str(exc), "error_type": type(exc).__name__})

    return wrapper

_RUNNER_PATH = Path(__file__).parent / ".agents/skills/llm-as-verifier/scripts/lav_runner.py"
_RUNS_ROOT = Path(__file__).parent / "runs"

_DEFAULT_CRITERIA = [
    {"id": "correctness", "name": "Correctness",
     "description": "The candidate fully satisfies the stated task requirement with observable evidence."},
    {"id": "evidence_quality", "name": "Evidence quality",
     "description": "Key claims are grounded in concrete artifacts such as tests, logs, diffs, or citations."},
    {"id": "reasoning_robustness", "name": "Reasoning robustness",
     "description": "The reasoning is coherent, criterion-specific, and handles likely edge cases."},
]


_runner_cache: Any = None


def _load_runner() -> Any:
    global _runner_cache
    if _runner_cache is not None:
        return _runner_cache
    spec = importlib.util.spec_from_file_location("lav_runner_mcp", _RUNNER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"lav_runner not found at {_RUNNER_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    _runner_cache = module
    return module


def _make_client(runner: Any, model: str, mock: bool) -> Any:
    """Create the appropriate backend client for lav_runner."""
    if mock:
        return None
    if runner._is_openai_compatible(model):
        # Forward the model so create_openai_client can default the base URL to the
        # local 9router proxy for 9router-routed IDs (kimi/..., cx/..., etc.).
        return runner.create_openai_client(model=model)
    return runner.create_gemini_client()


def _normalize_evidence(evidence: Any) -> list[dict]:
    """Coerce evidence to list[{"label": str, "content": str}].

    Accepts:
      - list of dicts (already correct)
      - list of strings (promoted to {"label": "evidence", "content": s})
      - None / missing
    """
    if not isinstance(evidence, list):
        return []
    result = []
    for item in evidence:
        if isinstance(item, dict):
            result.append(item)
        elif isinstance(item, str) and item.strip():
            result.append({"label": "evidence", "content": item.strip()})
    return result


def _normalize_candidates(candidates: list[dict]) -> list[dict]:
    return [
        {**c, "evidence": _normalize_evidence(c.get("evidence"))}
        for c in candidates
    ]


def _build_config(
    mode: str,
    task: str,
    candidates: list[dict],
    criteria: list[dict],
    n_verifications: int,
    mock: bool,
    model: str,
) -> dict:
    return {
        "mode": mode,
        "task": task,
        "context": "",
        "ground_truth_note": "",
        "criteria": criteria,
        "candidates": _normalize_candidates(candidates),
        "n_verifications": n_verifications,
        "granularity": 20,
        "model": model,
        "mock": mock,
    }


@mcp.tool()
@_tool_safe
def verifier_fusion_compare(
    task: str,
    candidates: str,
    criteria: str = "",
    n_verifications: int = 5,
    model: str = "mock",
    mock: bool = False,
) -> str:
    """Run swap-and-aggregate pairwise comparison across a set of candidates.

    Args:
        task: Task description for the verifier prompt.
        candidates: JSON array of candidates. Each item: {"id": str, "content": str,
                    "summary": str (optional),
                    "evidence": [{"label": str, "content": str}, ...] (optional)}.
        criteria: JSON array of {"id", "name", "description"} criteria. Omit to use
                  the default 3-criterion rubric (correctness, evidence_quality,
                  reasoning_robustness).
        n_verifications: Verifier samples per criterion per ordering (1-8). Each
                         sample runs both A→B and B→A, so actual API calls are 2×.
        model: Model to use as verifier. Use "mock" (default) for no API calls.
               For real LLMs via 9router (requires 9ROUTER_API_KEY or
               NINEROUTER_API_KEY env var):
                 "kimi/kimi-k2.6"                  — Kimi K2.6 reasoning ✅
                 "minimax/MiniMax-M3"               — MiniMax M3 1M context ✅
                 "minimax/MiniMax-M2.7"             — MiniMax M2.7 ✅
                 "cx/gpt-5.5"                       — Codex GPT-5.5 (Codex Pro)
                 "ag/gemini-3.5-flash-low"          — Antigravity Gemini (low)
                 "cc/claude-sonnet-4-6"             — Claude via OAuth
                 "deepseek-v4-flash"                — DeepSeek V4 fast
                 "gemini-3-5-flash-medium-round-robin" — Gemini medium pool (combo)
               For Gemini direct (requires GEMINI_API_KEY):
                 "gemini-2.5-flash"
        mock: Force mock backend regardless of model value.

    Returns:
        JSON string with winner, ranking, pairwise breakdowns, vote_margin, and
        swap_consistency per criterion.
    """
    cands = json.loads(candidates)
    crits = json.loads(criteria) if criteria.strip() else _DEFAULT_CRITERIA
    effective_mock = mock or model == "mock"
    runner = _load_runner()
    # Coerce plain-string evidence to {label, content} BEFORE normalize_input (which
    # otherwise drops non-dict evidence), then let the runner validate/coerce the rest.
    config = _build_config("compare", task, cands, crits, n_verifications, effective_mock, model)
    config = runner.normalize_input(config)
    client = _make_client(runner, model, effective_mock)
    result = runner.run_compare(client, config)
    return json.dumps(result, indent=2)


@mcp.tool()
@_tool_safe
def verifier_fusion_audit(
    task: str,
    candidate: str,
    criteria: str = "",
    n_verifications: int = 5,
    model: str = "mock",
    mock: bool = False,
) -> str:
    """Score a single candidate against all rubric criteria.

    Args:
        task: Task description for the verifier prompt.
        candidate: JSON object for the single candidate: {"id": str, "content": str,
                   "summary": str (optional), "evidence": list (optional)}.
        criteria: JSON array of {"id", "name", "description"} criteria. Omit to use
                  the default 3-criterion rubric.
        n_verifications: Verifier samples per criterion (1-8).
        model: Model identifier (e.g. "mock", "cx/gpt-5.5"). Real models route via
               9router (set 9ROUTER_API_KEY / NINEROUTER_API_KEY).
        mock: Force mock backend.

    Returns:
        JSON string with overall_score, vote_margin, and per-criterion breakdowns.
    """
    cand = json.loads(candidate)
    crits = json.loads(criteria) if criteria.strip() else _DEFAULT_CRITERIA
    effective_mock = mock or model == "mock"
    runner = _load_runner()
    config = _build_config("audit", task, [cand], crits, n_verifications, effective_mock, model)
    config = runner.normalize_input(config)
    client = _make_client(runner, model, effective_mock)
    result = runner.run_audit(client, config)
    return json.dumps(result, indent=2)


@mcp.tool()
@_tool_safe
def evaluate_verifier(
    suite_path: str,
    n_verifications: int = 1,
    model: str = "mock",
) -> str:
    """Grade a verifier model against a labeled JSONL benchmark suite.

    Args:
        suite_path: Path to a .jsonl benchmark file. Each line is a row with
                    task_contract, candidates, expected_winner, expected_failure_flags.
                    Built-in suites: evals/verifier/labeled/tasks.jsonl (28 labeled
                    pairwise rows across 7 categories — the real model-quality benchmark),
                    evals/verifier/search/tasks.jsonl, evals/verifier/validation/tasks.jsonl.
        n_verifications: Verifier samples per row (default 1 for speed).
        model: Verifier model to grade. "mock" (default) is the deterministic floor;
               a real id (e.g. cx/gpt-5.5, kimi/kimi-k2.6, minimax/MiniMax-M3,
               ag/gemini-3.5-flash-low, cc/claude-sonnet-4-6) grades a live model via
               9router (needs 9ROUTER_API_KEY / NINEROUTER_API_KEY).

    Returns:
        JSON report with model, total, accuracy, decisive_accuracy, tie_rate,
        position_bias_rate, flag_recall, category_accuracy, and per-row outcomes.
    """
    from harness.cli.evaluate_verifier import (
        _load_runner_module,
        _evaluate_row,
        _build_report,
    )
    runner = _load_runner_module(_RUNNER_PATH)
    repo_root = Path(__file__).parent
    path = Path(suite_path)
    if not path.is_absolute():
        path = repo_root / path
    if not path.exists():
        available = sorted(
            str(p.relative_to(repo_root))
            for p in (repo_root / "evals").rglob("tasks.jsonl")
        )
        return json.dumps({
            "error": f"suite not found: {path}",
            "hint": "paths resolve relative to the repo root",
            "available": available,
        })
    use_mock = model == "mock"
    client = None if use_mock else runner.create_openai_client(model=model)
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped:
            rows.append(_evaluate_row(
                json.loads(stripped), runner, n_verifications,
                model=model, mock=use_mock, client=client,
            ))
    return json.dumps(_build_report(rows, model=model), indent=2)


@mcp.tool()
@_tool_safe
async def run_task(
    task_path: str,
    backend: str = "mock",
    profile: str = "standard",
    explore_models: str = "",
    ctx: Context | None = None,
) -> str:
    """Run a TaskContract JSON through the full fusion pipeline.

    The pipeline runs N candidate lanes in parallel, scores them, then fuses the
    best with a single synthesizer model (set FMH_SYNTHESIZER=openai and
    FMH_SYNTHESIZER_MODEL=<one model>; route it via 9router by setting
    OPENAI_BASE_URL=http://localhost:20128/v1).

    Args:
        task_path: Path to a TaskContract JSON file (absolute or relative to repo root).
        backend: Candidate backend when profile is not "explore"/"budget"/"dynamic".
                 One of: mock, anthropic_api, openai_api, kimi, minimax, 9router,
                 claude_code, codex_cli, local.
        profile: Lane routing profile. "standard" uses one backend for all lanes.
                 "explore" gives each lane a DISTINCT model (one option per lane) over
                 9router — the multi-model fan-out. "budget" rotates kimi/minimax;
                 "dynamic" rotates qwen/minimax/kimi/9router/openai_api.
        explore_models: Comma-separated 9router model IDs, one per lane, used only when
                 profile="explore". E.g.
                 "kimi/kimi-k2.6,minimax/MiniMax-M3,ag/gemini-3.5-flash-low,qwen3.7-plus,cx/gpt-5.5".
                 Empty -> FMH_EXPLORE_MODELS env -> verified default set. Passing a
                 non-empty value implies profile="explore".

    Returns:
        JSON summary with run_id, pass, final_score, winner candidate id, the per-lane
        model routing, errors, and warnings.
    """
    from harness.core.lifecycle import BACKENDS, Supervisor
    from harness.core.task_contract import load_task_contract
    from harness.routing.router import StaticRouter

    if backend not in BACKENDS:
        return json.dumps({
            "error": f"unknown backend: {backend!r}",
            "valid_backends": sorted(BACKENDS.keys()),
        })

    path = Path(task_path)
    if not path.is_absolute():
        path = Path(__file__).parent / path
    if not path.exists():
        return json.dumps({"error": f"task contract not found: {path}"})

    models = [m.strip() for m in explore_models.split(",") if m.strip()] or None
    if models and profile == "standard":
        profile = "explore"

    task = load_task_contract(path, Path(__file__).parent)

    # Surface the planned per-lane routing without re-running it.
    decision = StaticRouter(profile=profile, explore_models=models).route(task, backend=backend)
    lane_routing = [{"candidate_id": c.candidate_id, "backend": c.backend, "model": c.model} for c in decision.candidates]

    supervisor = Supervisor(runs_root=_RUNS_ROOT)
    if ctx is not None:
        await ctx.report_progress(0, 1, "Running Fugu fusion task")
    state = await anyio.to_thread.run_sync(
        functools.partial(
            supervisor.run_task,
            task,
            backend=backend,
            profile=profile,
            explore_models=models,
        )
    )
    if ctx is not None:
        await ctx.report_progress(1, 1, "Fugu fusion task finished")

    # RunState exposes no pass/final_score/winner attributes — those live on disk.
    passed = (state.status == "passed")
    winner = state.selected_candidate_ids[0] if state.selected_candidate_ids else state.synthesis_id

    final_score = None
    score_path = Path(state.workspace_path).parent / "scores" / "final_score.json"
    try:
        if score_path.exists():
            final_score = json.loads(score_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        final_score = None

    return json.dumps({
        "run_id": state.run_id,
        "status": state.status,
        "passed": passed,
        "final_score": final_score,
        "winner": winner,
        "degraded": state.degraded,
        "profile": profile,
        "lane_routing": lane_routing,
        "errors": state.errors,
        "warnings": state.warnings,
    }, indent=2)


@mcp.tool()
@_tool_safe
def inspect_run(run_id: str, file: str = "run_state.json") -> str:
    """Read a stored artifact from a completed run.

    Args:
        run_id: The run ID (directory name under runs/).
        file: Relative path within the run directory to read.
              Common values: run_state.json, scores/final_score.json,
              verifier/model_verdict.json, candidates/<id>/result.json.

    Returns:
        Raw JSON content of the requested file, or an error message.
    """
    # Reject obviously-unsafe run_id up front (separators / parent refs).
    if "/" in run_id or "\\" in run_id or ".." in Path(run_id).parts:
        return json.dumps({"error": "invalid run_id"})

    runs_root = _RUNS_ROOT.resolve()
    base = (_RUNS_ROOT / run_id).resolve()
    target = (base / file).resolve()
    # Confine the resolved target to both the runs root and the specific run dir so a
    # crafted file like "../../mcp_server.py" or an absolute path cannot escape.
    if not (target.is_relative_to(runs_root) and target.is_relative_to(base)):
        return json.dumps({"error": "path escapes run directory"})

    if not target.exists():
        available = sorted(str(p.relative_to(base))
                           for p in base.rglob("*.json")) if base.exists() else []
        return json.dumps({"error": f"{file} not found in run {run_id}", "available": available[:20]})
    try:
        return target.read_text(encoding="utf-8")
    except OSError as exc:
        return json.dumps({"error": str(exc), "error_type": type(exc).__name__})


_FRONTIER_COLS = ["candidate_id", "search_score", "validation_score", "cost", "safety_failures"]


@mcp.tool()
@_tool_safe
def frontier(metric: str = "validation_score", limit: int = 10) -> str:
    """List top candidates from the SQLite frontier index.

    Args:
        metric: Column to sort by, one of: search_score, validation_score, cost,
                safety_failures (default: validation_score). The underlying query
                orders by validation_score then search_score; this re-sorts the
                resulting rows by the requested column (descending).
        limit: Maximum number of rows to return.

    Returns:
        JSON object {"frontier": [ {candidate_id, search_score, validation_score,
        cost, safety_failures}, ... ]}. On an empty index, a "note" is included.
    """
    from harness.experience.sqlite_store import SQLiteIndex

    sort_cols = _FRONTIER_COLS[1:]  # candidate_id is not a numeric sort key
    if metric not in sort_cols:
        return json.dumps({
            "error": f"unknown metric: {metric!r}",
            "valid_metrics": sort_cols,
        })

    _RUNS_ROOT.mkdir(parents=True, exist_ok=True)
    raw = SQLiteIndex(db_path=_RUNS_ROOT / "index.sqlite3").frontier()
    rows = [dict(zip(_FRONTIER_COLS, r)) for r in raw]
    rows.sort(key=lambda r: (r.get(metric) is None, r.get(metric)), reverse=True)
    rows = rows[:limit]
    if not rows:
        return json.dumps({"frontier": [], "note": "no runs indexed yet"}, indent=2)
    return json.dumps({"frontier": rows}, indent=2, default=str)


@mcp.tool()
@_tool_safe
def rqgm_search(
    provider: str = "fmh",
    budget: int = 64,
    backend: str = "9router",
    model: str = "omp",
    task_suite: str = "rqgm",
    anchor_suite: str = "verifier/labeled",
    epsilon: float = 0.05,
    seed: int = 0,
) -> str:
    """Run the Red Queen Godel Machine co-evolutionary search.

    provider: "fmh" by default (real local 9router via model "omp") or
    "mock" for deterministic offline test mode.
    Returns a JSON summary: best node, best-belief, archive size, balanced
    utility, evaluator replacements, and retained record count. Requires the
    optional `red-queen-godel-machine` package.
    """
    try:
        from rqgm.runner import build_providers, result_to_dict
        from rqgm.search import RQGMConfig, RQGMSearch
    except ImportError as exc:
        raise RuntimeError(
            "rqgm not installed; pip install -e ../../../red-queen-godel-machine"
        ) from exc

    config = RQGMConfig(budget=budget, epsilon=epsilon, seed=seed)
    if provider == "fmh":
        from harness.rqgm_provider import FmhEvaluatorSlotProvider, FmhWorkspaceProvider

        workspace = FmhWorkspaceProvider(backend=backend, task_suite=task_suite, model=model)
        slots = {
            0: FmhEvaluatorSlotProvider(slot=0, backend=backend, anchor_suite=anchor_suite, model=model)
        }
    else:
        workspace, slots = build_providers("mock", config)
    result = RQGMSearch(workspace, slots, config).run()
    return json.dumps(result_to_dict(result), indent=2)



def build_remote_mcp_server(
    config: RemoteAuthConfig,
    *,
    jwk_client: Any | None = None,
) -> _FuguMCPServer:
    """Build a separately configured OAuth resource server for public HTTP only."""
    auth = AuthSettings(
        issuer_url=config.issuer_url,
        resource_server_url=config.resource_server_url,
        required_scopes=list(config.required_scopes),
    )
    remote = _new_server(
        auth=auth,
        token_verifier=JwksJwtTokenVerifier(config, jwk_client=jwk_client),
    )
    _register_product_primitives(remote)
    for tool in (
        verifier_fusion_compare,
        verifier_fusion_audit,
        evaluate_verifier,
        run_task,
        inspect_run,
        frontier,
        rqgm_search,
    ):
        remote.add_tool(tool)
    return remote


def _run_cli() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="pi-llm-as-verifier MCP server")
    parser.add_argument(
        "--transport",
        choices=["stdio", "streamable-http", "sse"],
        default="stdio",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    if args.transport == "stdio":
        mcp.run()
        return
    if args.transport == "sse":
        if not _streamable_http_bind_is_safe(args.host, None):
            parser.error("Legacy SSE may bind only to a loopback host")
        mcp.run(transport="sse", host=args.host, port=args.port)
        return

    if _streamable_http_bind_is_safe(args.host, None):
        mcp.run(
            transport="streamable-http",
            host=args.host,
            port=args.port,
            streamable_http_path=_REMOTE_MCP_PATH,
        )
        return

    try:
        config = RemoteAuthConfig.from_environment()
        security = config.transport_security()
        _require_safe_streamable_http_bind(args.host, security)
    except ValueError as exc:
        parser.error(str(exc))
    build_remote_mcp_server(config).run(
        transport="streamable-http",
        host=args.host,
        port=args.port,
        streamable_http_path=_REMOTE_MCP_PATH,
        transport_security=security,
    )


if __name__ == "__main__":
    _run_cli()
