"""Real-process Streamable HTTP gate for the shipped Fugu MCP entrypoint."""

from __future__ import annotations

import http.client
import json
import os
import socket
import subprocess
import sys
import time
from importlib.metadata import PackageNotFoundError, version as distribution_version
from pathlib import Path
from typing import Any

import pytest


pytest.importorskip("mcp", reason="the optional MCP runtime is required for the Fugu process gate")
import anyio
from mcp.client import Client
from mcp.client.sse import sse_client


_PROTOCOL_VERSION = "2026-07-28"
_SERVER_NAME = "pi-llm-as-verifier"
_SERVER_SCRIPT = Path(__file__).resolve().parents[2] / "mcp_server.py"


def _server_version() -> str:
    try:
        return distribution_version("fusion-meta-harness")
    except PackageNotFoundError:
        return "0.1.0"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _modern_params(**params: object) -> dict[str, object]:
    return {
        **params,
        "_meta": {
            "io.modelcontextprotocol/protocolVersion": _PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {"name": "fugu-process-gate", "version": "1.0"},
        },
    }


def _parse_envelope(payload: bytes, content_type: str) -> dict[str, Any]:
    text = payload.decode("utf-8")
    if "text/event-stream" in content_type:
        event_data = "\n".join(
            line[5:].lstrip() for line in text.splitlines() if line.startswith("data:")
        )
        if not event_data:
            raise AssertionError(f"Streamable HTTP response contained no JSON-RPC event: {text!r}")
        return json.loads(event_data)
    return json.loads(text)


def _post_mcp(port: int, request_id: int, method: str, params: dict[str, object]) -> dict[str, Any]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    body = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
    headers = {
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": _PROTOCOL_VERSION,
        "mcp-method": method,
    }
    if isinstance(params.get("name"), str):
        headers["mcp-name"] = params["name"]
    try:
        connection.request(
            "POST",
            "/mcp",
            body=body,
            headers=headers,
        )
        response = connection.getresponse()
        payload = response.read()
        assert response.status == 200, payload.decode("utf-8", errors="replace")
        assert response.getheader("mcp-session-id") is None
        return _parse_envelope(payload, response.getheader("content-type", ""))
    finally:
        connection.close()


def _wait_for_discovery(process: subprocess.Popen[str], port: int) -> dict[str, Any]:
    last_error: BaseException | None = None
    for _ in range(100):
        if process.poll() is not None:
            raise AssertionError(f"Fugu Streamable HTTP entrypoint exited with {process.returncode}")
        try:
            return _post_mcp(port, 1, "server/discover", _modern_params())
        except (ConnectionError, OSError, http.client.HTTPException, AssertionError, json.JSONDecodeError) as error:
            last_error = error
            time.sleep(0.025)
    raise AssertionError(f"Fugu Streamable HTTP endpoint never became ready: {last_error}")


def _stop(process: subprocess.Popen[str]) -> str:
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
    assert process.poll() is not None
    return process.stderr.read() if process.stderr is not None else ""


def test_direct_streamable_http_entrypoint_modern_wire_contract_and_shutdown() -> None:
    port = _free_port()
    environment = {**os.environ, "PYTHONUNBUFFERED": "1"}
    process = subprocess.Popen(
        [
            sys.executable,
            str(_SERVER_SCRIPT),
            "--transport",
            "streamable-http",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        cwd=_SERVER_SCRIPT.parent,
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    failure: BaseException | None = None
    try:
        discovery = _wait_for_discovery(process, port)
        assert discovery["jsonrpc"] == "2.0"
        assert discovery["id"] == 1
        discover_result = discovery["result"]
        assert discover_result["resultType"] == "complete"
        assert discover_result["supportedVersions"] == [_PROTOCOL_VERSION]
        assert discover_result["ttlMs"] == 0
        assert discover_result["cacheScope"] == "private"
        assert discover_result["_meta"]["io.modelcontextprotocol/serverInfo"] == {
            "name": _SERVER_NAME,
            "version": _server_version(),
        }
        assert "tools" in discover_result["capabilities"]

        listed = _post_mcp(port, 2, "tools/list", _modern_params())
        assert listed["jsonrpc"] == "2.0"
        assert listed["id"] == 2
        list_result = listed["result"]
        assert list_result["resultType"] == "complete"
        assert list_result["ttlMs"] == 0
        assert list_result["cacheScope"] == "private"
        assert list_result["_meta"]["io.modelcontextprotocol/serverInfo"] == {
            "name": _SERVER_NAME,
            "version": _server_version(),
        }
        inspect_run = next(tool for tool in list_result["tools"] if tool["name"] == "inspect_run")
        assert isinstance(inspect_run["inputSchema"], dict)
        assert isinstance(inspect_run.get("outputSchema"), dict)

        called = _post_mcp(
            port,
            3,
            "tools/call",
            _modern_params(name="inspect_run", arguments={"run_id": "../escape"}),
        )
        assert called["jsonrpc"] == "2.0"
        assert called["id"] == 3
        call_result = called["result"]
        assert call_result["resultType"] == "complete"
        assert call_result["isError"] is False
        assert call_result["_meta"]["io.modelcontextprotocol/serverInfo"] == {
            "name": _SERVER_NAME,
            "version": _server_version(),
        }
        assert json.loads(call_result["structuredContent"]["result"]) == {"error": "invalid run_id"}
        assert json.loads(call_result["content"][0]["text"]) == {"error": "invalid run_id"}
    except BaseException as error:
        failure = error
    stderr = _stop(process)
    if failure is not None:
        raise AssertionError(f"Fugu Streamable HTTP process gate failed. Server stderr:\n{stderr}") from failure


async def _legacy_sse_round_trip(port: int) -> tuple[str, set[str], dict[str, Any], dict[str, Any]]:
    async with Client(
        sse_client(f"http://127.0.0.1:{port}/sse", timeout=1, sse_read_timeout=2),
        mode="legacy",
    ) as client:
        listed = await client.list_tools()
        called = await client.call_tool("inspect_run", {"run_id": "../escape"})
        assert client.protocol_version is not None
        assert client.server_info is not None
        return (
            client.protocol_version,
            {tool.name for tool in listed.tools},
            client.server_info.model_dump(),
            called.structured_content,
        )


def _wait_for_legacy_sse(
    process: subprocess.Popen[str], port: int
) -> tuple[str, set[str], dict[str, Any], dict[str, Any]]:
    last_error: BaseException | None = None
    for _ in range(100):
        if process.poll() is not None:
            raise AssertionError(f"Fugu legacy SSE entrypoint exited with {process.returncode}")
        try:
            return anyio.run(_legacy_sse_round_trip, port)
        except Exception as error:  # Readiness races are bounded by the spawned process, not external I/O.
            last_error = error
            time.sleep(0.025)
    raise AssertionError(f"Fugu legacy SSE endpoint never became ready: {last_error}")


def test_direct_sse_entrypoint_legacy_initialize_list_call_and_shutdown() -> None:
    port = _free_port()
    process = subprocess.Popen(
        [
            sys.executable,
            str(_SERVER_SCRIPT),
            "--transport",
            "sse",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        cwd=_SERVER_SCRIPT.parent,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    failure: BaseException | None = None
    try:
        protocol_version, tool_names, server_info, structured_content = _wait_for_legacy_sse(process, port)
        assert protocol_version != _PROTOCOL_VERSION
        assert tool_names >= {"inspect_run"}
        assert server_info["name"] == _SERVER_NAME
        assert server_info["version"] == _server_version()
        assert json.loads(structured_content["result"]) == {"error": "invalid run_id"}
    except BaseException as error:
        failure = error
    stderr = _stop(process)
    if failure is not None:
        raise AssertionError(f"Fugu legacy SSE process gate failed. Server stderr:\n{stderr}") from failure
