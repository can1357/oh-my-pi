"""Command-line interface."""

from __future__ import annotations

import asyncio
import json
import sys

import click
import uvicorn

from robomp.config import Settings, get_settings
from robomp.db import INACTIVE_EVENT_STATES, get_database
from robomp.logging_config import configure_logging
from robomp.manual_triage import (
    InvalidIssueRef,
    ManualTriageError,
    ManualTriageTimeout,
    await_terminal_state,
    enqueue_manual_triage,
    parse_issue_ref,
)
from robomp.platform_utils import proxy_credentials
from robomp.proxy_client import GitHubProxyClient
from robomp.sandbox import SandboxManager
from robomp.server import create_app


def _settings_or_die() -> Settings:
    try:
        return get_settings()
    except Exception as exc:
        click.echo(f"configuration error: {exc}", err=True)
        sys.exit(2)


def _require_proxy_mode(cfg: Settings) -> tuple[str, bytes]:
    if cfg.github_token is not None:
        raise SystemExit(
            "robomp orchestrator refuses to start with GITHUB_TOKEN set in env. "
            "The PAT must live only in the gh-proxy container."
        )
    if cfg.gh_proxy_url is None or cfg.gh_proxy_hmac_key is None:
        raise SystemExit(
            "robomp orchestrator requires ROBOMP_GH_PROXY_URL and "
            "ROBOMP_GH_PROXY_HMAC_KEY (run gh-proxy in a sibling container)."
        )
    return proxy_credentials(cfg)


def _build_github(cfg: Settings) -> GitHubProxyClient:
    base_url, key = _require_proxy_mode(cfg)
    return GitHubProxyClient(base_url=base_url, hmac_key=key)


def _default_wait_timeout(cfg: Settings) -> float:
    return cfg.task_timeout_seconds + cfg.task_timeout_hard_grace_seconds + 30.0


@click.group()
def main() -> None:
    """roboomp control surface."""


@main.command()
def serve() -> None:
    """Run the webhook receiver + worker pool."""
    cfg = _settings_or_die()
    configure_logging(cfg.log_dir)
    cfg.ensure_paths()
    app = create_app(cfg)
    uvicorn.run(app, host=cfg.bind_host, port=cfg.bind_port, log_config=None)


@main.command()
@click.argument("issue_ref")
@click.option(
    "--wait-timeout",
    type=click.FloatRange(min=0.1),
    default=None,
    help="Seconds to wait for a terminal state before returning non-zero (default: task timeout + hard grace + 30).",
)
def triage(issue_ref: str, wait_timeout: float | None) -> None:
    """Fetch a live issue and queue it as if a webhook arrived.

    ISSUE_REF is `owner/repo#NN`.
    """
    cfg = _settings_or_die()
    configure_logging(cfg.log_dir)
    cfg.ensure_paths()
    try:
        repo_full, number = parse_issue_ref(issue_ref)
    except InvalidIssueRef as exc:
        click.echo(str(exc), err=True)
        sys.exit(2)
    if not cfg.allows(repo_full):
        click.echo(f"refusing: {repo_full} not in ROBOMP_REPO_ALLOWLIST", err=True)
        sys.exit(2)

    async def _go() -> None:
        github = _build_github(cfg)
        db = get_database(cfg.sqlite_path)
        try:
            delivery = await enqueue_manual_triage(
                db=db,
                github=github,
                repo_full=repo_full,
                number=number,
            )
        except ManualTriageError as exc:
            click.echo(f"refusing: {exc}", err=True)
            sys.exit(2)
        # The dispatcher loop lives in the long-running `serve` process; we
        # only watch the row land in a terminal state. Wake latency is
        # bounded by `WorkerPool._dispatch_loop`'s 10s `_wakeup.wait()` fallback.
        click.echo(json.dumps({"delivery": delivery, "state": "queued"}, indent=2))
        timeout = wait_timeout if wait_timeout is not None else _default_wait_timeout(cfg)
        try:
            final = await await_terminal_state(db, delivery, timeout=timeout)
        except ManualTriageTimeout as exc:
            click.echo(
                json.dumps(
                    {"delivery": delivery, "state": exc.state, "timed_out": True, "error": str(exc)},
                    indent=2,
                ),
                err=True,
            )
            sys.exit(1)
        if final is None:
            click.echo(json.dumps({"delivery": delivery, "state": "missing"}, indent=2))
            return
        click.echo(
            json.dumps(
                {"delivery": delivery, "state": final.state, "error": final.last_error},
                indent=2,
            )
        )

    asyncio.run(_go())


@main.command()
@click.argument("delivery_id")
@click.option(
    "--wait-timeout",
    type=click.FloatRange(min=0.1),
    default=None,
    help="Seconds to wait for a terminal state before returning non-zero (default: task timeout + hard grace + 30).",
)
def replay(delivery_id: str, wait_timeout: float | None) -> None:
    """Re-enqueue a stored event so the running `serve` pool can pick it up."""
    cfg = _settings_or_die()
    configure_logging(cfg.log_dir)
    cfg.ensure_paths()
    db = get_database(cfg.sqlite_path)
    row = db.get_event(delivery_id)
    if row is None:
        click.echo(f"unknown delivery: {delivery_id}", err=True)
        sys.exit(2)
    if not db.requeue_event(delivery_id, from_states=INACTIVE_EVENT_STATES):
        click.echo(
            f"delivery {delivery_id} is {row.state}; only inactive events can be replayed",
            err=True,
        )
        sys.exit(2)

    async def _wait() -> None:
        timeout = wait_timeout if wait_timeout is not None else _default_wait_timeout(cfg)
        try:
            final = await await_terminal_state(db, delivery_id, timeout=timeout)
        except ManualTriageTimeout as exc:
            click.echo(
                json.dumps(
                    {"delivery": delivery_id, "state": exc.state, "timed_out": True, "error": str(exc)},
                    indent=2,
                ),
                err=True,
            )
            sys.exit(1)
        if final is None:
            click.echo(json.dumps({"delivery": delivery_id, "state": "missing"}, indent=2))
            return
        click.echo(
            json.dumps(
                {"delivery": delivery_id, "state": final.state, "error": final.last_error},
                indent=2,
            )
        )

    asyncio.run(_wait())


@main.command()
def status() -> None:
    """Dump issue and release state."""
    cfg = _settings_or_die()
    cfg.ensure_paths()
    db = get_database(cfg.sqlite_path)
    issue_rows = db.list_issues()
    for row in issue_rows:
        click.echo(
            f"{row.key:<40} state={row.state:<12} pr={row.pr_number or '-'} "
            f"branch={row.branch or '-'} updated={row.updated_at}"
        )
    release_rows = db.list_releases()
    if release_rows:
        if issue_rows:
            click.echo()
        click.echo("Releases:")
    for row in release_rows:
        error = f" error={row.last_error}" if row.last_error else ""
        click.echo(
            f"{row.key:<40} state={row.state:<12} rounds={row.rounds:<2} "
            f"sha={row.current_sha[:12]} updated={row.updated_at}{error}"
        )


@main.command()
@click.argument("issue_key")
def cleanup(issue_key: str) -> None:
    """Force-remove the workspace for an issue (does not touch the remote)."""
    cfg = _settings_or_die()
    cfg.ensure_paths()
    db = get_database(cfg.sqlite_path)
    row = db.get_issue(issue_key)
    if row is None:
        click.echo(f"unknown issue: {issue_key}", err=True)
        sys.exit(2)
    sandbox = SandboxManager(cfg.workspace_root)
    sandbox.remove_workspace(repo=row.repo, number=row.number)
    db.set_issue_state(issue_key, "abandoned")
    click.echo(f"cleaned up {issue_key}")


if __name__ == "__main__":
    main()
