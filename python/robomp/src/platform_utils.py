"""Platform-aware token, API base, git host, and auth prefix resolution.

Centralizes the platform-branching logic so cross-cutting code (proxy server,
event queue, issue index sync) doesn't duplicate inline checks.
"""

from __future__ import annotations

from robomp.config import Settings


def resolve_token_for_platform(cfg: Settings, platform: str) -> str:
    """Return the PAT for the given platform. Fails closed on unknown/missing."""
    if platform == "forgejo":
        if cfg.forgejo_token is not None:
            return cfg.forgejo_token.get_secret_value()
        raise ValueError("Forgejo platform requested but FORGEJO_TOKEN is not configured")
    if cfg.github_token is None:
        raise ValueError("GITHUB_TOKEN not configured")
    return cfg.github_token.get_secret_value()


def resolve_api_base_for_platform(cfg: Settings, platform: str) -> str:
    """Return the API base URL for the given platform."""
    if platform == "forgejo":
        return cfg.api_base
    return "https://api.github.com"


def resolve_git_host_for_platform(cfg: Settings, platform: str) -> str:
    """Return the git host for the given platform."""
    if platform == "forgejo":
        return cfg.git_host
    return "github.com"


def auth_prefix_for_platform(platform: str) -> str:
    """Return the HTTP Authorization prefix for the given platform."""
    return "token" if platform == "forgejo" else "Bearer"
