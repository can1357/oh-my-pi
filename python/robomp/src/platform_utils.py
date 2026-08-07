"""Platform-aware token, API base, git host, and auth prefix resolution.

Centralizes the platform-branching logic so cross-cutting code (proxy server,
event queue, issue index sync) doesn't duplicate inline checks.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from robomp.config import Settings

if TYPE_CHECKING:
    from robomp.github_backend import GitHubBackend


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


def backend_for_repo(
    settings: Settings, repo: str, github: GitHubBackend, forgejo_github: GitHubBackend | None
) -> GitHubBackend:
    """Return the backend that serves ``repo``: the Forgejo client when the
    (case-insensitive) repo is in ``forgejo_repos``, else the GitHub client."""
    if forgejo_github is not None and repo.lower() in settings.forgejo_repos:
        return forgejo_github
    return github


def proxy_credentials(cfg: Settings) -> tuple[str, bytes]:
    """Return ``(base_url, hmac_key)`` for gh-proxy, with None fallbacks."""
    base_url = cfg.gh_proxy_url or ""
    key = b""
    if cfg.gh_proxy_hmac_key:
        key = cfg.gh_proxy_hmac_key.get_secret_value().encode("utf-8")
    return base_url, key


def create_proxy_backend(cfg: Settings, platform: str) -> GitHubBackend | None:
    """Return a proxy backend (GitHubProxyClient) for the given platform.

    For ``github``, returns None (caller should use its cached singleton).
    For ``forgejo``, creates a new GitHubProxyClient with the forgejo platform.
    """
    if platform == "forgejo":
        base_url, key = proxy_credentials(cfg)
        from robomp.proxy_client import GitHubProxyClient

        return GitHubProxyClient(base_url=base_url, hmac_key=key, platform="forgejo")
    return None


def create_git_transport(cfg: Settings, platform: str):
    """Return a git transport (ProxyGitTransport) for the given platform.

    For ``github``, returns None (caller should use its cached singleton).
    For ``forgejo``, creates a new ProxyGitTransport with the forgejo platform.
    """
    if platform == "forgejo":
        base_url, key = proxy_credentials(cfg)
        from robomp.proxy_client import ProxyGitTransport

        return ProxyGitTransport(base_url=base_url, hmac_key=key, platform="forgejo")
    return None
