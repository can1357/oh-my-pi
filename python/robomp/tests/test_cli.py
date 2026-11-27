"""Consumer-visible coverage for the robomp command-line interface."""

from __future__ import annotations

import httpx
import pytest
from click.testing import CliRunner

from robomp import cli
from robomp.config import Settings
from robomp.db import Database, get_database
from robomp.manual_triage import ManualTriageTimeout
from robomp.proxy_client import GitHubProxyClient


@pytest.mark.parametrize("platform", ["forgejo", "github"])
def test_triage_persists_selected_repo_platform(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch, platform: str
) -> None:
    # Both backends exist; repo membership, not backend availability, selects one.
    monkeypatch.setenv("ROBOMP_FORGEJO_REPOS", "forge/widget")
    monkeypatch.setenv("ROBOMP_REPO_ALLOWLIST", "forge/widget,octo/widget")
    monkeypatch.setenv("ROBOMP_API_BASE", "https://git.example.com/api/v1")
    monkeypatch.setenv("ROBOMP_GIT_HOST", "git.example.com")
    cfg = Settings()  # type: ignore[call-arg]
    repo = "forge/widget" if platform == "forgejo" else "octo/widget"
    host = "git.example.com" if platform == "forgejo" else "github.com"
    requests: list[httpx.Request] = []

    def proxy(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.url.params["repo"] == repo
        assert request.url.params.get("platform", "github") == platform
        if request.url.path == "/gh/v1/issue":
            assert request.url.params["number"] == "7"
            return httpx.Response(
                200,
                json={
                    "repo": repo,
                    "number": 7,
                    "title": "CLI triage",
                    "body": "Issue fetched through the selected backend",
                    "state": "open",
                    "author": "alice",
                    "labels": ["bug"],
                    "is_pull_request": False,
                },
            )
        assert request.url.path == "/gh/v1/repo"
        return httpx.Response(
            200,
            json={
                "full_name": repo,
                "default_branch": "main",
                "clone_url": f"https://{host}/{repo}.git",
                "private": False,
            },
        )

    def client(self: GitHubProxyClient) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=cfg.gh_proxy_url or "", transport=httpx.MockTransport(proxy))

    async def stop_waiting(db: Database, delivery: str, *, timeout: float) -> None:
        # No worker runs in a one-shot CLI invocation. Keep its queued row intact
        # while exercising the command's normal timeout response without sleeping.
        row = db.get_event(delivery)
        assert row is not None
        assert row.state == "queued"
        raise ManualTriageTimeout(delivery, row.state, timeout)

    monkeypatch.setattr(cli, "get_settings", lambda: cfg)
    monkeypatch.setattr(GitHubProxyClient, "_async_client", client)
    monkeypatch.setattr(cli, "await_terminal_state", stop_waiting)
    result = CliRunner().invoke(cli.main, ["triage", f"{repo}#7", "--wait-timeout", "0.1"])

    assert result.exit_code == 1, result.output
    assert '"timed_out": true' in result.output
    assert [request.url.path for request in requests] == ["/gh/v1/issue", "/gh/v1/repo"]
    delivery = f"manual-{repo.replace('/', '__')}-7"
    assert f'"delivery": "{delivery}"' in result.output
    event = get_database(cfg.sqlite_path).get_event(delivery)
    assert event is not None
    assert event.platform == platform
    assert event.state == "queued"
    assert event.event_type == "issues"
    assert event.repo == repo
    payload = event.payload
    assert payload["issue"]["number"] == 7
    assert payload["issue"]["title"] == "CLI triage"
    assert payload["repository"]["clone_url"] == f"https://{host}/{repo}.git"
