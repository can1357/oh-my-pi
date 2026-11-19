"""`python -m robomp.proxy serve` — run the gh-proxy FastAPI app."""

from __future__ import annotations

import sys

import click
import uvicorn

from robomp.config import Settings, load_proxy_settings
from robomp.logging_config import configure_logging
from robomp.proxy.server import create_proxy_app


def _settings_or_die() -> Settings:
    """Load proxy-only settings, surfacing config errors as exit code 2.

    Routes through `load_proxy_settings` (NOT the orchestrator `Settings()`
    ctor) so the gh-proxy container only needs `GITHUB_TOKEN` +
    `ROBOMP_GH_PROXY_HMAC_KEY` — the orchestrator's webhook secret,
    bot_login, and proxy-URL fields are irrelevant here.
    """
    try:
        return load_proxy_settings()
    except Exception as exc:
        click.echo(f"gh-proxy configuration error: {exc}", err=True)
        sys.exit(2)


@click.group()
def main() -> None:
    """gh-proxy control surface."""


@main.command()
def serve() -> None:
    """Run the HMAC-authenticated GitHub proxy."""
    cfg = _settings_or_die()
    configure_logging(cfg.log_dir)
    cfg.ensure_paths()
    # `load_proxy_settings` already rejects blank values, but stay defensive
    # in case a caller constructs the Settings by hand.
    if cfg.github_token is None:
        click.echo("gh-proxy: GITHUB_TOKEN is required in proxy mode", err=True)
        sys.exit(2)
    if cfg.gh_proxy_hmac_key is None:
        click.echo("gh-proxy: ROBOMP_GH_PROXY_HMAC_KEY is required in proxy mode", err=True)
        sys.exit(2)
    app = create_proxy_app(cfg)
    uvicorn.run(
        app,
        host=cfg.gh_proxy_bind_host,
        port=cfg.gh_proxy_bind_port,
        log_config=None,
    )


if __name__ == "__main__":
    main()
