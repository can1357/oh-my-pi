"""Tests for platform-specific token, API base, git host, and auth resolution."""

from __future__ import annotations

import pytest
from pydantic import SecretStr

from robomp.config import Settings
from robomp.platform_utils import (
    auth_prefix_for_platform,
    resolve_api_base_for_platform,
    resolve_git_host_for_platform,
    resolve_token_for_platform,
)

_BASE = {
    "GITHUB_WEBHOOK_SECRET": "x",
    "ROBOMP_BOT_LOGIN": "bot",
    "ROBOMP_GIT_AUTHOR_EMAIL": "a@b.c",
}


def test_resolve_token_for_github() -> None:
    s = Settings(GITHUB_TOKEN="ghs_test", **_BASE)  # type: ignore[arg-type]
    assert resolve_token_for_platform(s, "github") == "ghs_test"


def test_resolve_token_for_forgejo() -> None:
    s = Settings(FORGEJO_TOKEN="fj_token", GITHUB_TOKEN="ghs_test", **_BASE)  # type: ignore[arg-type]
    assert resolve_token_for_platform(s, "forgejo") == "fj_token"


def test_resolve_token_for_forgejo_raises_when_unset() -> None:
    s = Settings(FORGEJO_TOKEN="", GITHUB_TOKEN="ghs_test", **_BASE)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="FORGEJO_TOKEN is not configured"):
        resolve_token_for_platform(s, "forgejo")


def test_resolve_token_for_github_raises_when_unset() -> None:
    s = Settings(
        FORGEJO_TOKEN="fj_token", ROBOMP_GH_PROXY_URL="http://proxy", ROBOMP_GH_PROXY_HMAC_KEY=SecretStr("k"), **_BASE
    )  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="GITHUB_TOKEN not configured"):
        resolve_token_for_platform(s, "github")


def test_resolve_api_base_for_forgejo() -> None:
    s = Settings(GITHUB_TOKEN="ghs_test", ROBOMP_API_BASE="https://git.example.com/api/v1", **_BASE)  # type: ignore[arg-type]
    assert resolve_api_base_for_platform(s, "forgejo") == "https://git.example.com/api/v1"


def test_resolve_api_base_for_github() -> None:
    s = Settings(GITHUB_TOKEN="ghs_test", **_BASE)  # type: ignore[arg-type]
    assert resolve_api_base_for_platform(s, "github") == "https://api.github.com"


def test_resolve_git_host_for_forgejo() -> None:
    s = Settings(GITHUB_TOKEN="ghs_test", ROBOMP_GIT_HOST="git.example.com", **_BASE)  # type: ignore[arg-type]
    assert resolve_git_host_for_platform(s, "forgejo") == "git.example.com"


def test_resolve_git_host_for_github() -> None:
    s = Settings(GITHUB_TOKEN="ghs_test", **_BASE)  # type: ignore[arg-type]
    assert resolve_git_host_for_platform(s, "github") == "github.com"


def test_auth_prefix_for_forgejo() -> None:
    assert auth_prefix_for_platform("forgejo") == "token"


def test_auth_prefix_for_github() -> None:
    assert auth_prefix_for_platform("github") == "Bearer"
