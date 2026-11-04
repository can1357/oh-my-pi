"""An explicit ``env`` cannot turn MCP back on for the child while the host has it off."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from omp_rpc import RpcClient


class _Sentinel(Exception):
    pass


def _child_env(monkeypatch: pytest.MonkeyPatch, host: str | None, **kwargs) -> dict[str, str]:
    if host is None:
        monkeypatch.delenv("PI_NO_MCP", raising=False)
    else:
        monkeypatch.setenv("PI_NO_MCP", host)
    client = RpcClient(executable="omp", **kwargs)
    with patch("omp_rpc.client.subprocess.Popen", side_effect=_Sentinel("aborted")) as mock_popen:
        with pytest.raises(_Sentinel):
            client.start()
    return mock_popen.call_args.kwargs["env"]


@pytest.mark.parametrize("override", ["", "0", "false"])
def test_host_with_mcp_off_keeps_it_off(monkeypatch: pytest.MonkeyPatch, override: str) -> None:
    env = _child_env(monkeypatch, "1", env={"PI_NO_MCP": override})
    assert env["PI_NO_MCP"] == "1"


def test_host_with_mcp_on_passes_the_override(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _child_env(monkeypatch, None, env={"PI_NO_MCP": "1"})["PI_NO_MCP"] == "1"
    assert _child_env(monkeypatch, "", env={"PI_NO_MCP": ""})["PI_NO_MCP"] == ""
