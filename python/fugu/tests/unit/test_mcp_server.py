"""Focused protocol tests for the shipped MCP v2 server."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from importlib.metadata import PackageNotFoundError, version as distribution_version
from pathlib import Path

import pytest

pytest.importorskip("mcp", reason="the optional MCP runtime is required for Fugu MCP server unit tests")

import anyio
import httpx2
from mcp import MCPError
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.server import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import HEADER_MISMATCH, INVALID_PARAMS, ResourceTemplateReference
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

import mcp_server


_TOOL_NAMES = {
    "verifier_fusion_compare",
    "verifier_fusion_audit",
    "evaluate_verifier",
    "run_task",
    "inspect_run",
    "frontier",
    "rqgm_search",
}
_PROTOCOL_VERSION = "2026-07-28"


def _expected_distribution_version() -> str:
    try:
        return distribution_version("fusion-meta-harness")
    except PackageNotFoundError:
        return "0.1.0"


def _modern_meta() -> dict[str, object]:
    return {
        "io.modelcontextprotocol/protocolVersion": _PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": {"name": "fugu-test", "version": "1.0"},
        "io.modelcontextprotocol/clientCapabilities": {},
    }


def test_mcpserver_modern_discovery_identity_tools_and_string_result() -> None:
    async def exercise() -> None:
        assert isinstance(mcp_server.mcp, MCPServer)

        async with Client(mcp_server.mcp) as client:
            assert client.protocol_version == _PROTOCOL_VERSION
            assert client.server_info is not None
            assert client.server_info.name == "pi-llm-as-verifier"
            assert client.server_info.version == _expected_distribution_version()

            capabilities = client.server_capabilities
            assert capabilities is not None
            assert capabilities.tools is not None
            assert capabilities.tasks is None
            assert capabilities.extensions is None
            assert capabilities.experimental is None
            assert capabilities.logging is None
            assert capabilities.completions is not None
            # Prompts and resources are explicit product primitives, not merely
            # SDK-advertised empty capabilities.
            assert capabilities.prompts is not None
            assert capabilities.resources is not None

            listed = await client.list_tools()
            assert {tool.name for tool in listed.tools} == _TOOL_NAMES
            assert listed.meta == {
                "io.modelcontextprotocol/serverInfo": {
                    "name": "pi-llm-as-verifier",
                    "version": _expected_distribution_version(),
                }
            }

            result = await client.call_tool("inspect_run", {"run_id": "../escape"})
            assert result.is_error is False
            assert result.structured_content is not None
            payload = result.structured_content["result"]
            assert isinstance(payload, str)
            assert json.loads(payload) == {"error": "invalid run_id"}

            with pytest.raises(MCPError) as unknown:
                await client.call_tool("does_not_exist", {})
            assert unknown.value.code == INVALID_PARAMS
            assert "Unknown tool: does_not_exist" in str(unknown.value)

    anyio.run(exercise)


def test_product_prompt_and_resource_catalogue_are_listable_and_readable() -> None:
    async def exercise() -> None:
        async with Client(mcp_server.mcp) as client:
            prompts = await client.list_prompts()
            assert [prompt.name for prompt in prompts.prompts] == ["review_rqgm_candidate"]
            prompt_definition = prompts.prompts[0]
            assert prompt_definition.description is not None
            assert [(argument.name, argument.required) for argument in prompt_definition.arguments] == [
                ("candidate", True)
            ]

            rendered_prompt = await client.get_prompt(
                "review_rqgm_candidate",
                {"candidate": "The candidate cites no test evidence."},
            )
            assert len(rendered_prompt.messages) == 1
            prompt_content = rendered_prompt.messages[0].content
            assert prompt_content.type == "text"
            assert "strict, impartial judge" in prompt_content.text
            assert prompt_content.text.endswith("The candidate cites no test evidence.")

            resources = await client.list_resources()
            assert [(resource.uri, resource.mime_type) for resource in resources.resources] == [
                ("fugu://knowledge/index", "text/markdown")
            ]
            templates = await client.list_resource_templates()
            assert [(template.uri_template, template.mime_type) for template in templates.resource_templates] == [
                ("fugu://knowledge/{document}", "text/markdown")
            ]
            completed = await client.complete(
                ResourceTemplateReference(uri="fugu://knowledge/{document}"),
                {"name": "document", "value": "fusion"},
            )
            assert "fusion-formal-law" in completed.completion.values
            assert completed.completion.has_more is False
            document_contents = await client.read_resource("fugu://knowledge/fusion-formal-law")
            assert "Formal fusion law" in document_contents.contents[0].text
            resource_contents = await client.read_resource("fugu://knowledge/index")
            assert len(resource_contents.contents) == 1
            content = resource_contents.contents[0]
            assert content.mime_type == "text/markdown"
            assert content.text.startswith("# pi-llm-as-verifier — Knowledge Bundle")

    anyio.run(exercise)


def test_run_task_reports_only_real_execution_lifecycle_progress(monkeypatch: pytest.MonkeyPatch) -> None:
    class ProgressRecorder:
        def __init__(self) -> None:
            self.events: list[tuple[float, float | None, str | None]] = []

        async def report_progress(
            self,
            progress: float,
            total: float | None = None,
            message: str | None = None,
        ) -> None:
            self.events.append((progress, total, message))

    class CompletedState:
        run_id = "run-progress"
        status = "passed"
        selected_candidate_ids = ["candidate-1"]
        synthesis_id = None
        workspace_path = str(Path(mcp_server.__file__).parent / "runs" / "run-progress" / "workspace")
        degraded = False
        errors: list[str] = []
        warnings: list[str] = []

    def complete_without_running_pipeline(*_args: object, **_kwargs: object) -> CompletedState:
        return CompletedState()

    monkeypatch.setattr("harness.core.lifecycle.Supervisor.run_task", complete_without_running_pipeline)
    fixture = Path(mcp_server.__file__).parent / "tests" / "fixtures" / "task_with_commands.json"
    progress = ProgressRecorder()

    async def exercise() -> None:
        result = json.loads(await mcp_server.run_task(str(fixture), ctx=progress))
        assert result["run_id"] == "run-progress"

    anyio.run(exercise)
    assert progress.events == [
        (0, 1, "Running Fugu fusion task"),
        (1, 1, "Fugu fusion task finished"),
    ]


def test_run_task_offloads_via_anyio_with_kwargs(monkeypatch: pytest.MonkeyPatch) -> None:
    received_kwargs: dict[str, object] = {}

    class CompletedState:
        run_id = "run-anyio-kwargs"
        status = "passed"
        selected_candidate_ids = ["candidate-1"]
        synthesis_id = None
        workspace_path = str(Path(mcp_server.__file__).parent / "runs" / "run-anyio-kwargs" / "workspace")
        degraded = False
        errors: list[str] = []
        warnings: list[str] = []

    def mock_run_task(_self: object, task: object, backend: str = "mock", profile: str = "standard", explore_models: list[str] | None = None) -> CompletedState:
        received_kwargs["task"] = task
        received_kwargs["backend"] = backend
        received_kwargs["profile"] = profile
        received_kwargs["explore_models"] = explore_models
        return CompletedState()

    monkeypatch.setattr("harness.core.lifecycle.Supervisor.run_task", mock_run_task)
    fixture = Path(mcp_server.__file__).parent / "tests" / "fixtures" / "task_with_commands.json"

    async def exercise() -> None:
        result_str = await mcp_server.run_task(
            str(fixture),
            backend="mock",
            profile="explore",
            explore_models="model-a,model-b",
        )
        result = json.loads(result_str)
        assert result["run_id"] == "run-anyio-kwargs"

    anyio.run(exercise)
    assert received_kwargs["backend"] == "mock"
    assert received_kwargs["profile"] == "explore"
    assert received_kwargs["explore_models"] == ["model-a", "model-b"]


def test_default_direct_script_transport_is_modern_stdio() -> None:
    async def exercise() -> None:
        server_script = Path(mcp_server.__file__).resolve()
        parameters = StdioServerParameters(
            command=sys.executable,
            args=[str(server_script)],
            cwd=server_script.parent,
        )

        with open(os.devnull, "w", encoding="utf-8") as errlog:
            with anyio.fail_after(20):
                async with Client(
                    stdio_client(parameters, errlog=errlog),
                    read_timeout_seconds=10,
                ) as client:
                    assert client.protocol_version == _PROTOCOL_VERSION
                    assert client.server_info is not None
                    assert client.server_info.name == "pi-llm-as-verifier"
                    assert client.server_info.version == _expected_distribution_version()
                    listed = await client.list_tools()
                    assert {tool.name for tool in listed.tools} == _TOOL_NAMES

                    with pytest.raises(MCPError) as unknown:
                        await client.call_tool("does_not_exist", {})
                    assert unknown.value.code == INVALID_PARAMS

    anyio.run(exercise)


def test_direct_cli_exposes_modern_and_legacy_remote_transports() -> None:
    server_script = Path(mcp_server.__file__).resolve()
    completed = subprocess.run(
        [sys.executable, str(server_script), "--help"],
        cwd=server_script.parent,
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )

    assert "{stdio,streamable-http,sse}" in completed.stdout


def test_direct_cli_rejects_unprotected_non_loopback_streamable_http() -> None:
    server_script = Path(mcp_server.__file__).resolve()
    completed = subprocess.run(
        [
            sys.executable,
            str(server_script),
            "--transport",
            "streamable-http",
            "--host",
            "0.0.0.0",
        ],
        cwd=server_script.parent,
        capture_output=True,
        text=True,
        timeout=10,
    )

    assert completed.returncode == 2
    assert "only to a loopback host" in completed.stderr


def test_non_loopback_app_requires_explicit_host_and_origin_policy() -> None:
    with pytest.raises(ValueError, match="only to a loopback host"):
        mcp_server.mcp.streamable_http_app(host="0.0.0.0")

    security = TransportSecuritySettings(
        allowed_hosts=["mcp.example.com"],
        allowed_origins=["https://mcp.example.com"],
    )
    app = mcp_server.mcp.streamable_http_app(
        host="0.0.0.0",
        transport_security=security,
    )
    assert app is not None


def test_streamable_http_mcp_endpoint_serves_modern_discovery() -> None:
    async def exercise() -> None:
        app = mcp_server.mcp.streamable_http_app(json_response=True)
        transport = httpx2.ASGITransport(app=app)
        headers = {
            "accept": "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": _PROTOCOL_VERSION,
            "mcp-method": "server/discover",
        }
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "server/discover",
            "params": {"_meta": _modern_meta()},
        }

        async with (
            mcp_server.mcp.session_manager.run(),
            httpx2.AsyncClient(
                transport=transport,
                base_url="http://127.0.0.1:8000",
            ) as http,
        ):
            response = await http.post("/mcp", headers=headers, json=body)

        assert response.status_code == 200
        assert "mcp-session-id" not in response.headers
        result = response.json()["result"]
        assert result["supportedVersions"] == [_PROTOCOL_VERSION]
        assert result["resultType"] == "complete"
        assert result["ttlMs"] == 0
        assert result["cacheScope"] == "private"
        assert result["_meta"]["io.modelcontextprotocol/serverInfo"] == {
            "name": "pi-llm-as-verifier",
            "version": _expected_distribution_version(),
        }
        assert "tools" in result["capabilities"]
        assert "tasks" not in result["capabilities"]
        assert "extensions" not in result["capabilities"]

    anyio.run(exercise)


def test_real_process_http_rejects_modern_header_mismatch_and_unknown_tool() -> None:
    server_script = Path(mcp_server.__file__).resolve()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]

    process = subprocess.Popen(
        [
            sys.executable,
            str(server_script),
            "--transport",
            "streamable-http",
            "--port",
            str(port),
        ],
        cwd=server_script.parent,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base_url = f"http://127.0.0.1:{port}"
    common_headers = {
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
    }
    discover = {
        "jsonrpc": "2.0",
        "id": 10,
        "method": "server/discover",
        "params": {"_meta": _modern_meta()},
    }

    try:
        deadline = time.monotonic() + 15
        with httpx2.Client(base_url=base_url, timeout=1) as http:
            while True:
                if process.poll() is not None:
                    pytest.fail("Streamable HTTP server exited before accepting requests")
                try:
                    mismatch = http.post(
                        "/mcp",
                        headers=common_headers | {"mcp-method": "server/discover"},
                        json=discover,
                    )
                    break
                except httpx2.TransportError:
                    if time.monotonic() >= deadline:
                        pytest.fail("Streamable HTTP server did not become ready")
                    time.sleep(0.05)

            assert mismatch.status_code == 400
            assert "mcp-session-id" not in mismatch.headers
            assert mismatch.json()["error"]["code"] == HEADER_MISMATCH

            wrong_header = http.post(
                "/mcp",
                headers=common_headers
                | {
                    "mcp-protocol-version": "2025-06-18",
                    "mcp-method": "server/discover",
                },
                json=discover,
            )
            assert wrong_header.status_code == 400
            assert "mcp-session-id" not in wrong_header.headers
            assert wrong_header.json()["error"]["code"] == HEADER_MISMATCH

            unknown = http.post(
                "/mcp",
                headers=common_headers
                | {
                    "mcp-protocol-version": _PROTOCOL_VERSION,
                    "mcp-method": "tools/call",
                    "mcp-name": "does_not_exist",
                },
                json={
                    "jsonrpc": "2.0",
                    "id": 11,
                    "method": "tools/call",
                    "params": {
                        "name": "does_not_exist",
                        "arguments": {},
                        "_meta": _modern_meta(),
                    },
                },
            )

            assert unknown.status_code == 400
            payload = unknown.json()
            assert "result" not in payload
            assert payload["error"]["code"] == INVALID_PARAMS
            assert "Unknown tool: does_not_exist" in payload["error"]["message"]
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


_REMOTE_ENV = {
    "FUGU_MCP_AUTH_MODE": "jwt",
    "FUGU_MCP_PUBLIC_URL": "https://mcp.example.com/mcp",
    "FUGU_MCP_OAUTH_ISSUER": "https://issuer.example.com",
    "FUGU_MCP_JWKS_URL": "https://issuer.example.com/jwks",
    "FUGU_MCP_REQUIRED_SCOPES": "fugu:mcp",
    "FUGU_MCP_JWT_ALGORITHMS": "RS256",
    "FUGU_MCP_ALLOWED_HOSTS": "mcp.example.com",
    "FUGU_MCP_ALLOWED_ORIGINS": "https://mcp.example.com",
    "FUGU_MCP_JWKS_CACHE_SECONDS": "60",
}


class _StaticJwkClient:
    def __init__(self, public_key: object) -> None:
        self.calls = 0
        self._key = jwt.PyJWK.from_dict(json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(public_key)))

    def get_signing_key_from_jwt(self, token: str) -> jwt.PyJWK:
        self.calls += 1
        return self._key


def _jwt_token(
    private_key: object,
    *,
    issuer: str = _REMOTE_ENV["FUGU_MCP_OAUTH_ISSUER"],
    audience: str = _REMOTE_ENV["FUGU_MCP_PUBLIC_URL"],
    scope: str = "fugu:mcp",
    expires_in: int = 300,
    not_before: int | None = None,
) -> str:
    now = int(time.time())
    claims: dict[str, object] = {
        "iss": issuer,
        "aud": audience,
        "exp": now + expires_in,
        "iat": now,
        "sub": "approved-user",
        "client_id": "approved-client",
        "scope": scope,
    }
    if not_before is not None:
        claims["nbf"] = not_before
    return jwt.encode(claims, private_key, algorithm="RS256", headers={"kid": "test-key"})


def test_remote_auth_configuration_is_explicit_and_rejects_symmetric_algorithms() -> None:
    config = mcp_server.RemoteAuthConfig.from_environment(_REMOTE_ENV)
    assert config.resource_server_url == "https://mcp.example.com/mcp"
    assert config.required_scopes == ("fugu:mcp",)
    assert config.jwks_cache_seconds == 60

    for field, value, message in (
        ("FUGU_MCP_AUTH_MODE", "disabled", "FUGU_MCP_AUTH_MODE"),
        ("FUGU_MCP_PUBLIC_URL", "http://mcp.example.com/mcp", "HTTPS"),
        ("FUGU_MCP_PUBLIC_URL", "https://mcp.example.com/not-mcp", "path"),
        ("FUGU_MCP_JWT_ALGORITHMS", "HS256", "asymmetric"),
        ("FUGU_MCP_REQUIRED_SCOPES", "", "FUGU_MCP_REQUIRED_SCOPES"),
        ("FUGU_MCP_JWKS_CACHE_SECONDS", "0", "between"),
    ):
        environment = _REMOTE_ENV | {field: value}
        with pytest.raises(ValueError, match=message):
            mcp_server.RemoteAuthConfig.from_environment(environment)


def test_jwks_jwt_verifier_validates_signature_claims_and_algorithms() -> None:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    client = _StaticJwkClient(private_key.public_key())
    verifier = mcp_server.JwksJwtTokenVerifier(
        mcp_server.RemoteAuthConfig.from_environment(_REMOTE_ENV),
        jwk_client=client,
    )
    async def exercise() -> None:
        valid = _jwt_token(private_key)
        access_token = await verifier.verify_token(valid)
        assert access_token is not None
        assert access_token.client_id == "approved-client"
        assert access_token.subject == "approved-user"
        assert access_token.scopes == ["fugu:mcp"]
        other_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        assert await verifier.verify_token(_jwt_token(other_private_key)) is None
        assert await verifier.verify_token(_jwt_token(private_key, issuer="https://other.example.com")) is None
        assert await verifier.verify_token(
            _jwt_token(private_key, audience="https://mcp.example.com/other")
        ) is None
        assert await verifier.verify_token(_jwt_token(private_key, expires_in=-120)) is None
        assert await verifier.verify_token(_jwt_token(private_key, not_before=int(time.time()) + 120)) is None
        assert await verifier.verify_token(
            jwt.encode(
                {
                    "iss": _REMOTE_ENV["FUGU_MCP_OAUTH_ISSUER"],
                    "aud": _REMOTE_ENV["FUGU_MCP_PUBLIC_URL"],
                    "exp": int(time.time()) + 300,
                    "iat": int(time.time()),
                },
                "this-is-not-an-asymmetric-key-and-is-long-enough-for-hs256",
                algorithm="HS256",
                headers={"kid": "test-key"},
            )
        ) is None

    anyio.run(exercise)
    assert client.calls == 6


def test_remote_app_uses_sdk_protected_resource_and_scope_enforcement() -> None:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    config = mcp_server.RemoteAuthConfig.from_environment(_REMOTE_ENV)
    server = mcp_server.build_remote_mcp_server(
        config,
        jwk_client=_StaticJwkClient(private_key.public_key()),
    )

    async def exercise() -> None:
        app = server.streamable_http_app(
            host="0.0.0.0",
            transport_security=config.transport_security(),
            json_response=True,
        )
        transport = httpx2.ASGITransport(app=app)
        headers = {
            "accept": "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": _PROTOCOL_VERSION,
            "mcp-method": "server/discover",
        }
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "server/discover",
            "params": {"_meta": _modern_meta()},
        }
        async with (
            server.session_manager.run(),
            httpx2.AsyncClient(
                transport=transport,
                base_url="https://mcp.example.com",
            ) as http,
        ):
            metadata = await http.get("/.well-known/oauth-protected-resource/mcp")
            unauthenticated = await http.post("/mcp", headers=headers, json=body)
            insufficient_scope = await http.post(
                "/mcp",
                headers=headers | {"authorization": f"Bearer {_jwt_token(private_key, scope='other:scope')}"},
                json=body,
            )
            authenticated = await http.post(
                "/mcp",
                headers=headers | {"authorization": f"Bearer {_jwt_token(private_key)}"},
                json=body,
            )
            authorization = {"authorization": f"Bearer {_jwt_token(private_key)}"}
            prompt_list = await http.post(
                "/mcp",
                headers=headers | authorization | {"mcp-method": "prompts/list"},
                json={
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "prompts/list",
                    "params": {"_meta": _modern_meta()},
                },
            )
            prompt_get = await http.post(
                "/mcp",
                headers=headers
                | authorization
                | {"mcp-method": "prompts/get", "mcp-name": "review_rqgm_candidate"},
                json={
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "prompts/get",
                    "params": {
                        "name": "review_rqgm_candidate",
                        "arguments": {"candidate": "Remote candidate."},
                        "_meta": _modern_meta(),
                    },
                },
            )
            resource_list = await http.post(
                "/mcp",
                headers=headers | authorization | {"mcp-method": "resources/list"},
                json={
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "resources/list",
                    "params": {"_meta": _modern_meta()},
                },
            )
            resource_read = await http.post(
                "/mcp",
                headers=headers
                | authorization
                | {"mcp-method": "resources/read", "mcp-name": "fugu://knowledge/index"},
                json={
                    "jsonrpc": "2.0",
                    "id": 5,
                    "method": "resources/read",
                    "params": {"uri": "fugu://knowledge/index", "_meta": _modern_meta()},
                },
            )

        assert metadata.status_code == 200
        assert metadata.json() == {
            "resource": _REMOTE_ENV["FUGU_MCP_PUBLIC_URL"],
            "authorization_servers": [_REMOTE_ENV["FUGU_MCP_OAUTH_ISSUER"]],
            "scopes_supported": ["fugu:mcp"],
            "bearer_methods_supported": ["header"],
        }
        assert unauthenticated.status_code == 401
        assert 'error="invalid_token"' in unauthenticated.headers["www-authenticate"]
        assert 'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"' in (
            unauthenticated.headers["www-authenticate"]
        )
        assert insufficient_scope.status_code == 403
        assert 'error="insufficient_scope"' in insufficient_scope.headers["www-authenticate"]
        assert authenticated.status_code == 200
        authenticated_capabilities = authenticated.json()["result"]["capabilities"]
        assert "prompts" in authenticated_capabilities
        assert "resources" in authenticated_capabilities
        assert prompt_list.status_code == 200
        assert prompt_list.json()["result"]["prompts"][0]["name"] == "review_rqgm_candidate"
        assert prompt_get.status_code == 200
        assert prompt_get.json()["result"]["messages"][0]["content"]["text"].endswith("Remote candidate.")
        assert resource_list.status_code == 200
        assert resource_list.json()["result"]["resources"][0]["uri"] == "fugu://knowledge/index"
        assert resource_read.status_code == 200
        assert resource_read.json()["result"]["contents"][0]["text"].startswith(
            "# pi-llm-as-verifier — Knowledge Bundle"
        )

    anyio.run(exercise)
