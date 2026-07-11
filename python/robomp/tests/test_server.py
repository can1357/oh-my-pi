"""End-to-end coverage for the FastAPI surface (dashboard + JSON APIs)."""

from __future__ import annotations

import hashlib
import hmac
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from robomp.config import Settings, reset_settings_cache
from robomp.dashboard import tail_jsonl
from robomp.db import Database, close_database, get_database, issue_key
from robomp.github_client import GitHubClient
from robomp.manual_triage import InvalidIssueRef, ManualTriageTimeout, await_terminal_state, parse_issue_ref
from robomp.sandbox import LocalGitTransport
from robomp.server import create_app


def _seed_db(settings: Settings) -> None:
    db = get_database(settings.sqlite_path)
    db.record_event(
        delivery_id="d-queued",
        event_type="issues",
        repo="octo/widget",
        issue_key=issue_key("octo/widget", 1),
        payload={"action": "opened", "issue": {"number": 1}},
    )
    db.record_event(
        delivery_id="d-skipped",
        event_type="issues",
        repo="octo/widget",
        issue_key=issue_key("octo/widget", 2),
        payload={"action": "labeled"},
        state="skipped",
    )
    # Promote one event to "running" so the running_events list isn't empty.
    db.record_event(
        delivery_id="d-running",
        event_type="issue_comment",
        repo="octo/widget",
        issue_key=issue_key("octo/widget", 3),
        payload={"action": "created"},
    )
    claimed = db.claim_next_event()
    assert claimed is not None  # d-queued or d-running depending on order
    # Make sure at least one event is in running state for our assertions.
    db.upsert_issue(
        key=issue_key("octo/widget", 3),
        repo="octo/widget",
        number=3,
        state="opened",
        branch="farm/abc12345/fix",
        pr_number=42,
    )
    db.set_issue_classification(issue_key("octo/widget", 3), "bug")


def test_index_serves_dashboard_html(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        resp = client.get("/")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    # Stable anchors only. The Vite bundle hashes its asset filenames on every
    # build, but the structural skeleton (title, mount node, config script)
    # has to stay intact for the SPA to bootstrap.
    assert "<title>robomp</title>" in resp.text
    assert 'id="app"' in resp.text
    assert 'id="robomp-config"' in resp.text
    # The sentinel must have been substituted — neither the literal sentinel
    # nor an empty script body is acceptable.
    assert "__ROBOMP_CONFIG__" not in resp.text
    assert '"replayEnabled":' in resp.text


def test_index_substitutes_replay_token(env, monkeypatch: pytest.MonkeyPatch) -> None:
    """When a replay token is set, the config blob exposes it to the SPA."""
    monkeypatch.setenv("ROBOMP_REPLAY_TOKEN", "secret-token-7")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    try:
        with TestClient(app) as client:
            resp = client.get("/")
        assert resp.status_code == 200
        assert '"replayEnabled":true' in resp.text
        assert '"replayToken":"secret-token-7"' in resp.text
    finally:
        close_database()


def test_api_status_reports_runtime_counts_and_inflight(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        _seed_db(settings)
        resp = client.get("/api/status")
    close_database()

    assert resp.status_code == 200
    body = resp.json()

    runtime = body["runtime"]
    assert runtime["bot_login"] == "robomp-bot"
    assert runtime["repo_allowlist"] == ["octo/widget"]
    assert runtime["max_concurrency"] == settings.max_concurrency
    assert runtime["model"] == settings.model
    assert runtime["uptime_seconds"] >= 0

    counts = body["event_counts"]
    # All five buckets must be present even when zero — the UI relies on it.
    assert set(counts) == {"queued", "running", "done", "failed", "skipped"}
    assert counts["queued"] + counts["running"] == 2  # d-queued + d-running
    assert counts["skipped"] == 1
    assert counts["running"] >= 1

    running = body["running_events"]
    assert running, "expected at least one running event after claim"
    assert all(r["started_at"] for r in running)

    # No worker pool was started in TestClient lifespan? It actually is — verify
    # the inflight snapshot returns a list even when empty.
    assert isinstance(body["inflight"], list)

    issues = {i["key"]: i for i in body["issues"]}
    fix_key = issue_key("octo/widget", 3)
    assert fix_key in issues
    assert issues[fix_key]["classification"] == "bug"
    assert issues[fix_key]["pr_number"] == 42
    assert issues[fix_key]["branch"] == "farm/abc12345/fix"

    delivery_ids = {e["delivery_id"] for e in body["recent_events"]}
    assert {"d-queued", "d-skipped", "d-running"}.issubset(delivery_ids)


def test_api_status_reports_current_issue_event_state(settings: Settings) -> None:
    app = create_app(settings)
    fixed = issue_key("octo/widget", 44)
    failed = issue_key("octo/widget", 69)
    with TestClient(app) as client:
        db = get_database(settings.sqlite_path)
        db.upsert_issue(key=fixed, repo="octo/widget", number=44, state="closed", pr_number=1084)
        db.upsert_issue(key=failed, repo="octo/widget", number=69, state="reproducing")
        db.record_event(
            delivery_id="fixed-old-failure",
            event_type="issues",
            repo="octo/widget",
            issue_key=fixed,
            payload={"action": "opened"},
            state="failed",
        )
        db.record_event(
            delivery_id="fixed-later-success",
            event_type="issues",
            repo="octo/widget",
            issue_key=fixed,
            payload={"action": "closed"},
            state="done",
        )
        db.record_event(
            delivery_id="still-failed",
            event_type="issues",
            repo="octo/widget",
            issue_key=failed,
            payload={"action": "opened"},
            state="failed",
        )
        db.record_event(
            delivery_id="failed-label-noise",
            event_type="issues",
            repo="octo/widget",
            issue_key=failed,
            payload={"action": "labeled"},
            state="skipped",
            last_error="issues.labeled ignored",
        )

        resp = client.get("/api/status")
    close_database()

    assert resp.status_code == 200
    body = resp.json()
    assert body["event_counts"]["failed"] == 2
    assert body["issue_event_counts"]["failed"] == 1
    assert body["issue_event_counts"]["done"] == 1
    assert body["issue_event_counts"]["skipped"] == 0

    issues = {i["key"]: i for i in body["issues"]}
    assert issues[fixed]["latest_event"]["delivery_id"] == "fixed-later-success"
    assert issues[fixed]["latest_event"]["state"] == "done"
    assert issues[failed]["latest_event"]["delivery_id"] == "still-failed"
    assert issues[failed]["latest_event"]["state"] == "failed"


def test_api_logs_returns_empty_when_file_missing(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        resp = client.get("/api/logs?limit=10")
    close_database()
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"entries": [], "count": 0, "limit": 10}


def test_api_logs_tails_jsonl_file(settings: Settings) -> None:
    log_path = settings.log_dir / "robomp.log.jsonl"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    payloads = [
        {"ts": "2026-05-14T21:28:28Z", "level": "INFO", "logger": "robomp.queue", "msg": "dispatch loop online"},
        {
            "ts": "2026-05-14T21:28:54Z",
            "level": "INFO",
            "logger": "robomp.server",
            "msg": "skip",
            "event": "issues",
            "reason": "issues.labeled ignored",
        },
        {"ts": "2026-05-14T21:30:00Z", "level": "WARNING", "logger": "robomp.queue", "msg": "tool_end", "ok": False},
    ]
    log_path.write_text("\n".join(json.dumps(p) for p in payloads) + "\n", encoding="utf-8")

    app = create_app(settings)
    with TestClient(app) as client:
        resp = client.get("/api/logs?limit=2")
    close_database()

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 2
    assert body["limit"] == 2
    # Oldest of the requested window first.
    assert body["entries"][0]["msg"] == "skip"
    assert body["entries"][1]["msg"] == "tool_end"
    assert body["entries"][1]["level"] == "WARNING"


def test_api_logs_limit_is_clamped(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        too_low = client.get("/api/logs?limit=0").json()
        too_high = client.get("/api/logs?limit=99999").json()
    close_database()
    assert too_low["limit"] == 1
    assert too_high["limit"] == 2000


def test_tail_jsonl_recovers_from_garbage_lines(tmp_path: Path) -> None:
    path = tmp_path / "noisy.jsonl"
    path.write_text(
        json.dumps({"ts": "a", "level": "INFO", "msg": "ok"}) + "\n"
        "{not json}\n" + json.dumps({"ts": "b", "level": "ERROR", "msg": "bang"}) + "\n",
        encoding="utf-8",
    )
    rows = tail_jsonl(path, limit=10)
    assert len(rows) == 3
    assert rows[0]["msg"] == "ok"
    assert rows[1]["level"] == "RAW"
    assert rows[1]["msg"] == "{not json}"
    assert rows[2]["level"] == "ERROR"


# ---------- manual_triage helpers ----------


def test_parse_issue_ref_accepts_owner_repo_hash_number() -> None:
    assert parse_issue_ref("octo/widget#42") == ("octo/widget", 42)
    assert parse_issue_ref("  octo/widget#42  ") == ("octo/widget", 42)


def test_parse_issue_ref_accepts_github_issue_urls() -> None:
    cases = (
        "https://github.com/can1357/oh-my-pi/issues/1348",
        "http://github.com/can1357/oh-my-pi/issues/1348",
        "github.com/can1357/oh-my-pi/issues/1348",
        "https://www.github.com/can1357/oh-my-pi/issues/1348",
        "https://github.com/can1357/oh-my-pi/issues/1348/",
        "https://github.com/can1357/oh-my-pi/issues/1348?foo=bar",
        "https://github.com/can1357/oh-my-pi/issues/1348#issuecomment-99",
        "  https://github.com/can1357/oh-my-pi/issues/1348  ",
    )
    for case in cases:
        assert parse_issue_ref(case) == ("can1357/oh-my-pi", 1348), case


def test_parse_issue_ref_rejects_garbage() -> None:
    for bad in (
        "widget#1",
        "octo/widget",
        "octo/widget#abc",
        "octo widget#1",
        "",
        "https://github.com/octo/widget/pull/1",
        "https://github.com/octo/widget/issues/",
        "https://gitlab.com/octo/widget/issues/1",
    ):
        with pytest.raises(InvalidIssueRef):
            parse_issue_ref(bad)


@pytest.mark.asyncio
async def test_await_terminal_state_times_out_with_current_state(db: Database) -> None:
    db.record_event(
        delivery_id="d-wait",
        event_type="issues",
        repo="octo/widget",
        issue_key=issue_key("octo/widget", 42),
        payload={"action": "opened"},
    )

    with pytest.raises(ManualTriageTimeout) as excinfo:
        await await_terminal_state(db, "d-wait", poll_interval=0.001, timeout=0.001)

    assert excinfo.value.delivery_id == "d-wait"
    assert excinfo.value.state == "queued"


# ---------- /api/trigger ----------


def _enable_replay(monkeypatch: pytest.MonkeyPatch) -> str:
    token = "trigger-secret"
    monkeypatch.setenv("ROBOMP_REPLAY_TOKEN", token)
    reset_settings_cache()
    return token


def _install_github_mock(app, transport: httpx.MockTransport) -> None:
    """Replace the real GitHub client with one wired to a MockTransport."""
    app.state.bag["github"] = GitHubClient("token", transport=transport)


def test_trigger_returns_404_when_token_disabled(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        resp = client.post("/api/trigger", json={"mode": "triage", "issue": "octo/widget#1"})
    close_database()
    assert resp.status_code == 404
    assert "trigger disabled" in resp.json()["detail"]


def test_trigger_rejects_missing_token(env, monkeypatch: pytest.MonkeyPatch) -> None:
    _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        resp = client.post("/api/trigger", json={"mode": "triage", "issue": "octo/widget#1"})
    close_database()
    assert resp.status_code == 401


def test_trigger_triage_fetches_and_enqueues(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()

    captured: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request.url.path)
        if request.url.path.endswith("/issues/7"):
            return httpx.Response(
                200,
                json={
                    "number": 7,
                    "title": "boom",
                    "body": "details here",
                    "state": "open",
                    "user": {"login": "alice"},
                    "labels": [{"name": "bug"}],
                },
            )
        if request.url.path.endswith("/repos/octo/widget"):
            return httpx.Response(
                200,
                json={
                    "full_name": "octo/widget",
                    "default_branch": "main",
                    "clone_url": "https://github.com/octo/widget.git",
                    "private": False,
                },
            )
        return httpx.Response(404)

    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, httpx.MockTransport(handler))
        resp = client.post(
            "/api/trigger",
            json={"mode": "triage", "issue": "octo/widget#7"},
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()

    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["mode"] == "triage"
    assert body["state"] == "queued"
    assert body["delivery"] == "manual-octo__widget-7"
    # Both endpoints should have been hit on GitHub.
    assert any(p.endswith("/issues/7") for p in captured)
    assert any(p.endswith("/repos/octo/widget") for p in captured)


@pytest.mark.parametrize("state", ["queued", "running"])
def test_trigger_triage_conflicts_when_manual_delivery_is_active(
    env, monkeypatch: pytest.MonkeyPatch, state: str
) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    delivery = "manual-octo__widget-7"
    original_payload = {"action": "opened", "issue": {"number": 7, "title": "old"}}

    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(500, json={"message": "should not fetch active manual event"})

    app = create_app(cfg)
    with TestClient(app) as client:
        db = get_database(cfg.sqlite_path)
        db.record_event(
            delivery_id=delivery,
            event_type="issues",
            repo="octo/widget",
            issue_key=issue_key("octo/widget", 7),
            payload=original_payload,
            state=state,
        )
        _install_github_mock(app, httpx.MockTransport(handler))
        resp = client.post(
            "/api/trigger",
            json={"mode": "triage", "issue": "octo/widget#7"},
            headers={"X-Robomp-Replay-Token": token},
        )
        row = get_database(cfg.sqlite_path).get_event(delivery)
    close_database()

    assert resp.status_code == 409, resp.text
    assert row is not None
    assert row.state == state
    assert row.payload == original_payload
    assert calls == []


@pytest.mark.parametrize("state", ["done", "failed", "skipped"])
def test_trigger_triage_replaces_inactive_manual_delivery(env, monkeypatch: pytest.MonkeyPatch, state: str) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    delivery = "manual-octo__widget-7"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/issues/7"):
            return httpx.Response(
                200,
                json={
                    "number": 7,
                    "title": "fresh",
                    "body": "new details",
                    "state": "open",
                    "user": {"login": "alice"},
                    "labels": [{"name": "bug"}],
                },
            )
        if request.url.path.endswith("/repos/octo/widget"):
            return httpx.Response(
                200,
                json={
                    "full_name": "octo/widget",
                    "default_branch": "main",
                    "clone_url": "https://github.com/octo/widget.git",
                    "private": False,
                },
            )
        return httpx.Response(404)

    app = create_app(cfg)
    with TestClient(app) as client:
        db = get_database(cfg.sqlite_path)
        db.record_event(
            delivery_id="running-octo__widget-7",
            event_type="issue_comment",
            repo="octo/widget",
            issue_key=issue_key("octo/widget", 7),
            payload={"action": "created"},
        )
        claimed = db.claim_next_event()
        assert claimed is not None
        assert claimed.delivery_id == "running-octo__widget-7"

        db.record_event(
            delivery_id=delivery,
            event_type="issues",
            repo="octo/widget",
            issue_key=issue_key("octo/widget", 7),
            payload={"action": "opened", "issue": {"number": 7, "title": "old"}},
            state=state,
        )
        _install_github_mock(app, httpx.MockTransport(handler))
        resp = client.post(
            "/api/trigger",
            json={"mode": "triage", "issue": "octo/widget#7"},
            headers={"X-Robomp-Replay-Token": token},
        )
        row = get_database(cfg.sqlite_path).get_event(delivery)
    close_database()

    assert resp.status_code == 202, resp.text
    assert row is not None
    assert row.state == "queued"
    assert row.attempts == 0
    assert row.payload["issue"]["title"] == "fresh"


def test_trigger_triage_rejects_pull_request_issue_payload(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()

    captured: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request.url.path)
        if request.url.path.endswith("/issues/7"):
            return httpx.Response(
                200,
                json={
                    "number": 7,
                    "title": "change",
                    "body": "details here",
                    "state": "open",
                    "user": {"login": "alice"},
                    "labels": [{"name": "bug"}],
                    "pull_request": {"url": "https://api.github.com/repos/octo/widget/pulls/7"},
                },
            )
        if request.url.path.endswith("/repos/octo/widget"):
            return httpx.Response(
                200,
                json={
                    "full_name": "octo/widget",
                    "default_branch": "main",
                    "clone_url": "https://github.com/octo/widget.git",
                    "private": False,
                },
            )
        return httpx.Response(404)

    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, httpx.MockTransport(handler))
        resp = client.post(
            "/api/trigger",
            json={"mode": "triage", "issue": "octo/widget#7"},
            headers={"X-Robomp-Replay-Token": token},
        )
        assert get_database(cfg.sqlite_path).get_event("manual-octo__widget-7") is None
    close_database()

    assert resp.status_code == 400, resp.text
    assert "pull request" in resp.json()["detail"]
    assert any(p.endswith("/issues/7") for p in captured)
    assert not any(p.endswith("/repos/octo/widget") for p in captured)


def test_trigger_triage_rejects_repo_not_in_allowlist(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, httpx.MockTransport(lambda r: httpx.Response(500)))
        resp = client.post(
            "/api/trigger",
            json={"mode": "triage", "issue": "evil/repo#1"},
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()
    assert resp.status_code == 403
    assert "ROBOMP_REPO_ALLOWLIST" in resp.json()["detail"]


@pytest.mark.parametrize("state", ["queued", "running"])
def test_trigger_retry_by_delivery_rejects_active_events(
    env,
    monkeypatch: pytest.MonkeyPatch,
    state: str,
) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        db = get_database(cfg.sqlite_path)
        db.record_event(
            delivery_id=f"d-{state}",
            event_type="issues",
            repo="octo/widget",
            issue_key=issue_key("octo/widget", 5),
            payload={"action": "opened", "issue": {"number": 5}},
            state=state,
        )
        resp = client.post(
            "/api/trigger",
            json={"mode": "retry", "delivery_id": f"d-{state}"},
            headers={"X-Robomp-Replay-Token": token},
        )
        assert resp.status_code == 409
        assert state in resp.json()["detail"]
        assert get_database(cfg.sqlite_path).get_event(f"d-{state}").state == state
    close_database()


def test_trigger_triage_surfaces_github_failure(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    transport = httpx.MockTransport(lambda r: httpx.Response(404, json={"message": "Not Found"}))
    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, transport)
        resp = client.post(
            "/api/trigger",
            json={"mode": "triage", "issue": "octo/widget#999"},
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()
    assert resp.status_code == 502
    assert "github error" in resp.json()["detail"]


def test_trigger_retry_by_delivery_id_requeues(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        db = get_database(cfg.sqlite_path)
        db.record_event(
            delivery_id="running-widget-4",
            event_type="issue_comment",
            repo="octo/widget",
            issue_key=issue_key("octo/widget", 4),
            payload={"action": "created"},
        )
        claimed = db.claim_next_event()
        assert claimed is not None
        assert claimed.delivery_id == "running-widget-4"

        db.record_event(
            delivery_id="d-old",
            event_type="issues",
            repo="octo/widget",
            issue_key=issue_key("octo/widget", 4),
            payload={"action": "opened", "issue": {"number": 4}},
            state="failed",
        )
        resp = client.post(
            "/api/trigger",
            json={"mode": "retry", "delivery_id": "d-old"},
            headers={"X-Robomp-Replay-Token": token},
        )
        assert resp.status_code == 202
        assert get_database(cfg.sqlite_path).get_event("d-old").state == "queued"
    close_database()


def test_trigger_retry_by_issue_finds_latest_non_skipped_event(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        db = get_database(cfg.sqlite_path)
        key = issue_key("octo/widget", 9)
        db.record_event(
            delivery_id="running-widget-9",
            event_type="issue_comment",
            repo="octo/widget",
            issue_key=key,
            payload={"action": "created"},
        )
        claimed = db.claim_next_event()
        assert claimed is not None
        assert claimed.delivery_id == "running-widget-9"

        db.record_event(
            delivery_id="d-old-1",
            event_type="issues",
            repo="octo/widget",
            issue_key=key,
            payload={"a": 1},
            state="failed",
        )
        db.record_event(
            delivery_id="d-old-2",
            event_type="issue_comment",
            repo="octo/widget",
            issue_key=key,
            payload={"a": 2},
            state="done",
        )
        db.record_event(
            delivery_id="d-label-noise",
            event_type="issues",
            repo="octo/widget",
            issue_key=key,
            payload={"a": 3},
            state="skipped",
        )
        resp = client.post(
            "/api/trigger",
            json={"mode": "retry", "issue": "octo/widget#9"},
            headers={"X-Robomp-Replay-Token": token},
        )
        body = resp.json()
        assert resp.status_code == 202, body
        # Most recently-received non-skipped row wins; ignored label events do not hide it.
        assert body["delivery"] == "d-old-2"
        retried = get_database(cfg.sqlite_path).get_event("d-old-2")
        assert retried is not None
        assert retried.state == "queued"
    close_database()


def test_trigger_retry_by_issue_rejects_active_latest_event(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        db = get_database(cfg.sqlite_path)
        key = issue_key("octo/widget", 10)
        db.record_event(
            delivery_id="d-inactive",
            event_type="issues",
            repo="octo/widget",
            issue_key=key,
            payload={"a": 1},
            state="failed",
        )
        db.record_event(
            delivery_id="d-active",
            event_type="issue_comment",
            repo="octo/widget",
            issue_key=key,
            payload={"a": 2},
            state="running",
        )
        resp = client.post(
            "/api/trigger",
            json={"mode": "retry", "issue": "octo/widget#10"},
            headers={"X-Robomp-Replay-Token": token},
        )
        assert resp.status_code == 409
        assert "running" in resp.json()["detail"]
        assert get_database(cfg.sqlite_path).get_event("d-active").state == "running"
        assert get_database(cfg.sqlite_path).get_event("d-inactive").state == "failed"
    close_database()


def test_trigger_retry_by_issue_rejects_repo_not_in_allowlist(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        db = get_database(cfg.sqlite_path)
        db.record_event(
            delivery_id="d-evil",
            event_type="issues",
            repo="evil/repo",
            issue_key=issue_key("evil/repo", 1),
            payload={"a": 1},
            state="failed",
        )
        resp = client.post(
            "/api/trigger",
            json={"mode": "retry", "issue": "evil/repo#1"},
            headers={"X-Robomp-Replay-Token": token},
        )
        assert resp.status_code == 403
        assert "ROBOMP_REPO_ALLOWLIST" in resp.json()["detail"]
        assert get_database(cfg.sqlite_path).get_event("d-evil").state == "failed"
    close_database()


def test_trigger_retry_unknown_delivery_404s(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        resp = client.post(
            "/api/trigger",
            json={"mode": "retry", "delivery_id": "nope"},
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()
    assert resp.status_code == 404


def test_trigger_rejects_bad_mode(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        resp = client.post(
            "/api/trigger",
            json={"mode": "explode"},
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()
    assert resp.status_code == 400


# -------- /webhook/github rate-limiting --------------------------------


def _signed_headers(secret: str, body: bytes, *, event: str, delivery: str) -> dict[str, str]:
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return {
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": delivery,
        "X-Hub-Signature-256": f"sha256={sig}",
        "Content-Type": "application/json",
    }


def _post_issue_opened(
    client: TestClient,
    *,
    delivery: str,
    user: str,
    number: int,
    association: str = "NONE",
    secret: str = "test-webhook-secret",
):
    payload = {
        "action": "opened",
        "issue": {
            "number": number,
            "user": {"login": user},
            "author_association": association,
        },
        "repository": {"full_name": "octo/widget"},
    }
    body = json.dumps(payload).encode()
    return client.post(
        "/webhook/github",
        content=body,
        headers=_signed_headers(secret, body, event="issues", delivery=delivery),
    )


def _post_pr_issue_comment(
    client: TestClient,
    *,
    delivery: str,
    user: str,
    pr_number: int,
    association: str = "NONE",
    secret: str = "test-webhook-secret",
):
    payload = {
        "action": "created",
        "comment": {
            "user": {"login": user},
            "author_association": association,
            "body": "follow-up",
        },
        "issue": {
            "number": pr_number,
            "pull_request": {"url": f"https://api.github.com/repos/octo/widget/pulls/{pr_number}"},
        },
        "repository": {"full_name": "octo/widget"},
    }
    body = json.dumps(payload).encode()
    return client.post(
        "/webhook/github",
        content=body,
        headers=_signed_headers(secret, body, event="issue_comment", delivery=delivery),
    )


@pytest.fixture
def rate_limited_settings(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> Settings:
    monkeypatch.setenv("ROBOMP_RATE_LIMIT_DEFAULT", "2")
    monkeypatch.setenv("ROBOMP_RATE_LIMIT_CONTRIBUTOR", "4")
    monkeypatch.setenv("ROBOMP_RATE_LIMIT_WINDOW_SECONDS", "3600")
    monkeypatch.setenv("ROBOMP_RATE_LIMIT_UNLIMITED", "can1357")
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    return cfg


def test_webhook_rate_limits_unknown_submitter_at_default_cap(rate_limited_settings: Settings) -> None:
    app = create_app(rate_limited_settings)
    with TestClient(app) as client:
        # Default cap is 2 → first two queued, third throttled.
        states = []
        for i in range(3):
            resp = _post_issue_opened(
                client,
                delivery=f"d-{i}",
                user="stranger",
                number=100 + i,
                association="NONE",
            )
            assert resp.status_code == 202
            states.append(resp.json()["state"])
    close_database()
    assert states == ["queued", "queued", "skipped"]


def test_webhook_incoming_pr_comment_without_directive_skips_without_counting_budget(
    rate_limited_settings: Settings,
) -> None:
    app = create_app(rate_limited_settings)
    with TestClient(app) as client:
        skipped = _post_pr_issue_comment(
            client,
            delivery="pr-unmapped",
            user="stranger",
            pr_number=900,
            association="NONE",
        )
        assert skipped.status_code == 202
        assert skipped.json()["state"] == "skipped"

        states = []
        for i in range(3):
            resp = _post_issue_opened(
                client,
                delivery=f"real-{i}",
                user="stranger",
                number=100 + i,
                association="NONE",
            )
            assert resp.status_code == 202
            states.append(resp.json()["state"])

        db = get_database(rate_limited_settings.sqlite_path)
        unmapped = db.get_event("pr-unmapped")
    close_database()

    assert unmapped is not None
    assert unmapped.issue_key == "octo/widget#900"
    assert "incoming PR comments ignored" in (unmapped.last_error or "")
    assert states == ["queued", "queued", "skipped"]


def test_webhook_contributor_gets_higher_cap(rate_limited_settings: Settings) -> None:
    app = create_app(rate_limited_settings)
    with TestClient(app) as client:
        # Default cap (2) would block at i=2; CONTRIBUTOR cap (4) allows it.
        for i in range(4):
            resp = _post_issue_opened(
                client,
                delivery=f"c-{i}",
                user="bob",
                number=200 + i,
                association="CONTRIBUTOR",
            )
            assert resp.status_code == 202
            assert resp.json()["state"] == "queued", i
        resp = _post_issue_opened(
            client,
            delivery="c-x",
            user="bob",
            number=299,
            association="CONTRIBUTOR",
        )
        assert resp.json()["state"] == "skipped"
    close_database()


def test_webhook_owner_association_bypasses_limit(rate_limited_settings: Settings) -> None:
    app = create_app(rate_limited_settings)
    with TestClient(app) as client:
        for i in range(5):  # well over default cap
            resp = _post_issue_opened(
                client,
                delivery=f"o-{i}",
                user="acme-staff",
                number=300 + i,
                association="OWNER",
            )
            assert resp.json()["state"] == "queued", i
    close_database()


def test_webhook_unlimited_allowlist_bypasses_limit(rate_limited_settings: Settings) -> None:
    app = create_app(rate_limited_settings)
    with TestClient(app) as client:
        # NONE association would normally cap at 2, but `can1357` is whitelisted.
        for i in range(5):
            resp = _post_issue_opened(
                client,
                delivery=f"u-{i}",
                user="can1357",
                number=400 + i,
                association="NONE",
            )
            assert resp.json()["state"] == "queued", i
    close_database()


def test_webhook_rate_limit_per_user_is_independent(rate_limited_settings: Settings) -> None:
    """One user's cap doesn't drain another user's budget."""
    app = create_app(rate_limited_settings)
    with TestClient(app) as client:
        # alice exhausts default cap.
        for i in range(2):
            assert (
                _post_issue_opened(
                    client,
                    delivery=f"a-{i}",
                    user="alice",
                    number=500 + i,
                    association="NONE",
                ).json()["state"]
                == "queued"
            )
        # alice's next attempt is skipped.
        assert (
            _post_issue_opened(
                client,
                delivery="a-x",
                user="alice",
                number=599,
                association="NONE",
            ).json()["state"]
            == "skipped"
        )
        # bob is untouched.
        for i in range(2):
            assert (
                _post_issue_opened(
                    client,
                    delivery=f"b-{i}",
                    user="bob",
                    number=600 + i,
                    association="NONE",
                ).json()["state"]
                == "queued"
            )
    close_database()


def test_webhook_rate_limited_event_records_reason(rate_limited_settings: Settings) -> None:
    """Throttled events must surface a useful reason on the dashboard feed."""
    app = create_app(rate_limited_settings)
    with TestClient(app) as client:
        for i in range(3):
            _post_issue_opened(
                client,
                delivery=f"r-{i}",
                user="charlie",
                number=700 + i,
                association="NONE",
            )
        db = get_database(rate_limited_settings.sqlite_path)
        skipped = db.get_event("r-2")
    close_database()
    assert skipped is not None
    assert skipped.state == "skipped"
    assert skipped.last_error is not None
    assert "rate limit" in skipped.last_error
    assert "@charlie" in skipped.last_error


# ---------- /api/github/issues ----------


def _allowlist(monkeypatch: pytest.MonkeyPatch, repos: str) -> None:
    monkeypatch.setenv("ROBOMP_REPO_ALLOWLIST", repos)
    reset_settings_cache()


def _issue_payload(
    number: int,
    title: str,
    *,
    state: str = "open",
    author: str = "alice",
    labels: list[dict] | None = None,
    comments: int = 0,
    updated_at: str = "2026-05-14T10:00:00Z",
    created_at: str = "2026-05-01T10:00:00Z",
    repo: str = "octo/widget",
) -> dict:
    return {
        "number": number,
        "title": title,
        "state": state,
        "user": {"login": author},
        "labels": labels or [],
        "comments": comments,
        "updated_at": updated_at,
        "created_at": created_at,
        "html_url": f"https://github.com/{repo}/issues/{number}",
    }


def _make_issues_handler(
    by_repo: dict[str, list[dict]],
    *,
    expected_state: str = "open",
    expected_limit: int = 30,
    failing_repos: tuple[str, ...] = (),
) -> httpx.MockTransport:
    expected_params = {
        "state": expected_state,
        "per_page": str(expected_limit),
        "sort": "updated",
        "direction": "desc",
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        params = request.url.params
        assert set(params.keys()) == set(expected_params)
        for key, expected in expected_params.items():
            assert params.get(key) == expected

        path = request.url.path
        for repo, items in by_repo.items():
            if path == f"/repos/{repo}/issues":
                return httpx.Response(200, json=items)
        for repo in failing_repos:
            if path == f"/repos/{repo}/issues":
                return httpx.Response(500, json={"message": "boom"})
        return httpx.Response(404, json={"message": "not found"})

    return httpx.MockTransport(handler)


def test_browse_returns_404_without_token(settings: Settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:
        resp = client.get("/api/github/issues")
    close_database()
    assert resp.status_code == 404


def test_browse_returns_401_with_replay_enabled_without_valid_token(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)

    with TestClient(app) as client:
        missing = client.get("/api/github/issues")
        wrong = client.get(
            "/api/github/issues",
            headers={"X-Robomp-Replay-Token": f"{token}-wrong"},
        )
    close_database()

    assert missing.status_code == 401
    assert wrong.status_code == 401


def test_browse_fans_out_across_allowlist_and_filters_prs(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    _allowlist(monkeypatch, "octo/widget,octo/gadget")
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    transport = _make_issues_handler(
        {
            "octo/widget": [
                {
                    "number": 7,
                    "title": "newest",
                    "state": "open",
                    "user": {"login": "alice"},
                    "labels": [{"name": "bug"}],
                    "comments": 3,
                    "updated_at": "2026-05-14T10:00:00Z",
                    "created_at": "2026-05-01T10:00:00Z",
                    "html_url": "https://github.com/octo/widget/issues/7",
                },
                {
                    "number": 8,
                    "title": "a PR not an issue",
                    "state": "open",
                    "user": {"login": "bob"},
                    "labels": [],
                    "comments": 0,
                    "updated_at": "2026-05-14T11:00:00Z",
                    "created_at": "2026-05-14T11:00:00Z",
                    "html_url": "https://github.com/octo/widget/pull/8",
                    "pull_request": {"url": "..."},
                },  # GitHub /issues returns these too
            ],
            "octo/gadget": [
                {
                    "number": 2,
                    "title": "older",
                    "state": "open",
                    "user": {"login": "carol"},
                    "labels": [],
                    "comments": 1,
                    "updated_at": "2026-05-12T09:00:00Z",
                    "created_at": "2026-05-12T09:00:00Z",
                    "html_url": "https://github.com/octo/gadget/issues/2",
                },
            ],
        },
        expected_limit=20,
    )
    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, transport)
        resp = client.get(
            "/api/github/issues?state=open&limit=20",
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["repos"] == ["octo/gadget", "octo/widget"]
    assert body["errors"] == []
    # PR row dropped; issues sorted newest-updated first.
    titles = [(i["repo"], i["number"]) for i in body["issues"]]
    assert titles == [("octo/widget", 7), ("octo/gadget", 2)]
    first = body["issues"][0]
    assert first["author"] == "alice"
    assert first["labels"] == ["bug"]
    assert first["comments"] == 3
    assert first["html_url"].endswith("/issues/7")


def test_browse_reuses_cache_until_forced_refresh(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        assert request.method == "GET"
        assert request.url.path == "/repos/octo/widget/issues"
        calls += 1
        title = "initial" if calls == 1 else "refreshed"
        updated_at = "2026-05-14T10:00:00Z" if calls == 1 else "2026-05-14T11:00:00Z"
        return httpx.Response(200, json=[_issue_payload(1, title, updated_at=updated_at)])

    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, httpx.MockTransport(handler))
        first = client.get(
            "/api/github/issues?state=open&limit=20",
            headers={"X-Robomp-Replay-Token": token},
        )
        second = client.get(
            "/api/github/issues?state=open&limit=20",
            headers={"X-Robomp-Replay-Token": token},
        )
        forced = client.get(
            "/api/github/issues?state=open&limit=20&refresh=1",
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()

    assert first.status_code == 200
    assert second.status_code == 200
    assert forced.status_code == 200
    assert calls == 2
    assert first.json()["cache"]["hit"] is False
    assert first.json()["issues"][0]["title"] == "initial"
    assert second.json()["cache"]["hit"] is True
    assert second.json()["issues"][0]["title"] == "initial"
    assert forced.json()["cache"]["hit"] is False
    assert forced.json()["issues"][0]["title"] == "refreshed"


def test_browse_cache_updates_from_issue_webhook(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        assert request.url.path == "/repos/octo/widget/issues"
        calls += 1
        return httpx.Response(200, json=[_issue_payload(4, "before", comments=1)])

    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, httpx.MockTransport(handler))
        first = client.get(
            "/api/github/issues?state=open&limit=20",
            headers={"X-Robomp-Replay-Token": token},
        )
        assert first.status_code == 200

        edited = {
            "action": "edited",
            "issue": _issue_payload(
                4,
                "after",
                labels=[{"name": "bug"}],
                comments=3,
                updated_at="2026-05-14T12:00:00Z",
            ),
            "repository": {"full_name": "octo/widget"},
        }
        raw = json.dumps(edited).encode()
        webhook_resp = client.post(
            "/webhook/github",
            content=raw,
            headers=_signed_headers("test-webhook-secret", raw, event="issues", delivery="cache-edit"),
        )
        after = client.get(
            "/api/github/issues?state=open&limit=20",
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()

    assert webhook_resp.status_code == 202
    assert calls == 1
    body = after.json()
    assert body["cache"]["hit"] is True
    assert body["issues"][0]["title"] == "after"
    assert body["issues"][0]["comments"] == 3
    assert body["issues"][0]["labels"] == ["bug"]


def test_browse_per_repo_failure_does_not_take_down_panel(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    _allowlist(monkeypatch, "octo/widget,octo/dead")
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()

    transport = _make_issues_handler(
        {
            "octo/widget": [
                {
                    "number": 1,
                    "title": "ok",
                    "state": "open",
                    "user": {"login": "u"},
                    "labels": [],
                    "comments": 0,
                    "updated_at": "2026-05-14T00:00:00Z",
                    "created_at": "2026-05-14T00:00:00Z",
                    "html_url": "https://github.com/octo/widget/issues/1",
                },
            ],
        },
        failing_repos=("octo/dead",),
    )

    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, transport)
        resp = client.get(
            "/api/github/issues",
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()

    assert resp.status_code == 200
    body = resp.json()
    assert len(body["issues"]) == 1
    assert body["issues"][0]["repo"] == "octo/widget"
    assert len(body["errors"]) == 1
    assert body["errors"][0]["repo"] == "octo/dead"


def test_browse_rejects_bad_state(env, monkeypatch: pytest.MonkeyPatch) -> None:
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, httpx.MockTransport(lambda r: httpx.Response(500)))
        resp = client.get(
            "/api/github/issues?state=garbage",
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()
    assert resp.status_code == 400


def test_browse_marks_processed_issues_present_in_db(env, monkeypatch: pytest.MonkeyPatch) -> None:
    """The /api/github/issues payload tags every issue with `processed`,
    derived live from the `issues` table so freshly-triaged work disappears
    from the "fresh issues" filter without invalidating the GitHub cache."""
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()

    # Seed: issue #7 was previously picked up; #8 is brand new.
    db = get_database(cfg.sqlite_path)
    db.upsert_issue(
        key=issue_key("octo/widget", 7),
        repo="octo/widget",
        number=7,
        state="opened",
    )

    transport = _make_issues_handler(
        {
            "octo/widget": [
                _issue_payload(7, "already triaged", updated_at="2026-05-14T10:00:00Z"),
                _issue_payload(8, "fresh", updated_at="2026-05-14T11:00:00Z"),
            ],
        },
        expected_limit=20,
    )
    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, transport)
        resp = client.get(
            "/api/github/issues?state=open&limit=20",
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()

    assert resp.status_code == 200, resp.text
    by_number = {i["number"]: i for i in resp.json()["issues"]}
    assert by_number[7]["processed"] is True
    assert by_number[8]["processed"] is False


def test_browse_processed_flag_is_recomputed_on_cache_hit(env, monkeypatch: pytest.MonkeyPatch) -> None:
    """Even when the GitHub cache is reused, `processed` reflects the current DB
    so a triage that lands between two dashboard polls hides the entry on the
    next refresh without forcing a GitHub round-trip."""
    token = _enable_replay(monkeypatch)
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()

    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=[_issue_payload(9, "fresh")])

    app = create_app(cfg)
    with TestClient(app) as client:
        _install_github_mock(app, httpx.MockTransport(handler))
        first = client.get(
            "/api/github/issues?state=open&limit=20",
            headers={"X-Robomp-Replay-Token": token},
        )
        assert first.status_code == 200
        assert first.json()["issues"][0]["processed"] is False

        # Simulate a triage landing between two dashboard polls.
        get_database(cfg.sqlite_path).upsert_issue(
            key=issue_key("octo/widget", 9),
            repo="octo/widget",
            number=9,
            state="reproducing",
        )

        second = client.get(
            "/api/github/issues?state=open&limit=20",
            headers={"X-Robomp-Replay-Token": token},
        )
    close_database()

    # GitHub was hit only once; the cached entry served the second call.
    assert calls == 1
    body = second.json()
    assert body["cache"]["hit"] is True
    assert body["issues"][0]["processed"] is True


# -------- maintainer directives ----------------------------------------


def _post_issue_comment(
    client: TestClient,
    *,
    delivery: str,
    user: str,
    number: int,
    body: str,
    association: str = "NONE",
    secret: str = "test-webhook-secret",
):
    payload = {
        "action": "created",
        "comment": {
            "user": {"login": user},
            "author_association": association,
            "body": body,
        },
        "issue": {"number": number},
        "repository": {"full_name": "octo/widget"},
    }
    raw = json.dumps(payload).encode()
    return client.post(
        "/webhook/github",
        content=raw,
        headers=_signed_headers(secret, raw, event="issue_comment", delivery=delivery),
    )


def test_webhook_directive_on_unknown_issue_is_queued_with_metadata(env) -> None:
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    with TestClient(app) as client:
        resp = _post_issue_comment(
            client,
            delivery="dir-1",
            user="can1357",
            number=77,
            body="@robomp-bot please refactor X",
            association="OWNER",
        )
        assert resp.status_code == 202
        assert resp.json()["state"] == "queued"
        row = get_database(cfg.sqlite_path).get_event("dir-1")
    close_database()
    assert row is not None
    assert row.state == "queued"
    directive = row.payload.get("_robomp_directive")
    assert directive == {"body": "please refactor X", "author": "can1357", "pragmas": [], "authorizes_impl": True}


def test_webhook_directive_authorizes_deployed_app_login_without_author_association(
    monkeypatch: pytest.MonkeyPatch, env
) -> None:
    monkeypatch.setenv("ROBOMP_BOT_LOGIN", "@roboomp[bot]")
    monkeypatch.setenv("ROBOMP_REPO_ALLOWLIST", "can1357/widget")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    app = create_app(cfg)
    payload = {
        "action": "created",
        "comment": {
            "user": {"login": "can1357"},
            "body": "@roboomp go ahead",
        },
        "issue": {"number": 3196},
        "repository": {
            "full_name": "can1357/widget",
            "owner": {"login": "can1357", "type": "User"},
        },
    }
    raw = json.dumps(payload).encode()
    with TestClient(app) as client:
        resp = client.post(
            "/webhook/github",
            content=raw,
            headers=_signed_headers("test-webhook-secret", raw, event="issue_comment", delivery="dir-app-login"),
        )
        assert resp.status_code == 202
        assert resp.json()["state"] == "queued"
        row = get_database(cfg.sqlite_path).get_event("dir-app-login")
    close_database()
    assert row is not None
    directive = row.payload.get("_robomp_directive")
    assert directive == {"body": "go ahead", "author": "can1357", "pragmas": [], "authorizes_impl": True}


def test_webhook_maintainer_bypasses_rate_limit(
    rate_limited_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Login in ROBOMP_MAINTAINER_LOGINS is always unlimited, even with NONE association."""
    monkeypatch.setenv("ROBOMP_MAINTAINER_LOGINS", "can1357")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()

    app = create_app(cfg)
    with TestClient(app) as client:
        states = []
        # cap=2 from rate_limited_settings — 3rd would normally be skipped.
        for i in range(4):
            resp = _post_issue_comment(
                client,
                delivery=f"m-{i}",
                user="can1357",
                number=300 + i,
                body=("@robomp-bot do X" if i == 3 else "comment"),
                association="NONE",
            )
            assert resp.status_code == 202
            states.append(resp.json()["state"])
        directive_event = get_database(cfg.sqlite_path).get_event("m-3")
    close_database()
    assert states == ["queued"] * 4, states
    assert directive_event is not None
    assert directive_event.payload.get("_robomp_directive") == {
        "body": "do X",
        "author": "can1357",
        "pragmas": [],
        "authorizes_impl": True,
    }


# -------- handler-level: bootstrap + reopen ----------------------------


class _RecordingSandbox:
    """Stand-in for SandboxManager: records calls, hands back a fake Workspace."""

    natives_cache = None

    def __init__(self, tmp_root: Path) -> None:
        self.tmp_root = tmp_root
        self.ensure_calls: list[dict] = []
        self.remove_calls: list[tuple[str, int]] = []

    def ensure_workspace(
        self,
        *,
        repo: str,
        number: int,
        title: str,
        clone_url: str,
        default_branch: str,
        existing_branch=None,
        pr_head: int | None = None,
        author_name: str = "",
        author_email: str = "",
        slot_uid: int | None = None,
    ):
        self.ensure_calls.append(
            {
                "repo": repo,
                "number": number,
                "title": title,
                "default_branch": default_branch,
                "existing_branch": existing_branch,
                "pr_head": pr_head,
                "slot_uid": slot_uid,
            }
        )
        # Mimic Workspace shape — only the attributes ensure_workspace's
        # downstream callers touch.
        from dataclasses import dataclass

        @dataclass(slots=True, frozen=True)
        class _W:
            branch: str
            session_dir: Path
            context_dir: Path
            repo_dir: Path

        wid = f"{repo.replace('/', '__')}__{number}"
        return _W(
            branch=existing_branch or (f"review/pr-{pr_head}" if pr_head is not None else f"farm/auto/{wid}"),
            session_dir=self.tmp_root / wid / "session",
            context_dir=self.tmp_root / wid / "context",
            repo_dir=self.tmp_root / wid / "repo",
        )

    def remove_workspace(self, *, repo: str, number: int) -> None:
        self.remove_calls.append((repo, number))


@pytest.fixture
def stub_run_task(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Capture run_task invocations instead of spinning up RpcClient."""
    captured: list[dict] = []

    async def _stub(**kwargs):
        captured.append(kwargs)
        return None

    from robomp import tasks as tasks_module

    monkeypatch.setattr(tasks_module, "run_task", _stub)
    return captured


async def test_handle_pr_conversation_unmapped_bot_pr_uses_pr_branch(
    settings: Settings, tmp_path: Path, stub_run_task, monkeypatch
) -> None:
    from robomp import tasks
    from robomp.github_client import CommentInfo, IssueInfo, PullRequestInfo, RepoInfo

    sandbox = _RecordingSandbox(tmp_path)
    db = get_database(settings.sqlite_path)
    repo = RepoInfo(
        full_name="octo/widget", default_branch="main", clone_url="https://github.com/octo/widget.git", private=False
    )
    pr_issue = IssueInfo(
        repo="octo/widget",
        number=900,
        title="Fix flaky parser",
        body="PR body",
        state="open",
        author=settings.bot_login,
        labels=(),
        is_pull_request=True,
    )
    pr_info = PullRequestInfo(
        repo="octo/widget",
        number=900,
        html_url="https://github.com/octo/widget/pull/900",
        head_ref="farm/abc12345/fix-flaky-parser",
        base_ref="main",
        state="open",
        author=settings.bot_login,
        head_repo="octo/widget",
    )

    async def _get_pull_request(self, repo_full: str, number: int):
        assert repo_full == "octo/widget"
        assert number == 900
        return pr_info

    async def _get_repo(self, repo_full: str):
        assert repo_full == "octo/widget"
        return repo

    async def _get_issue(self, repo_full: str, number: int):
        assert repo_full == "octo/widget"
        assert number == 900
        return pr_issue

    async def _list_comments(self, repo_full: str, number: int):
        assert repo_full == "octo/widget"
        assert number == 900
        return [CommentInfo(id=77, author="can1357", body="prior PR context", created_at="2026-05-14T00:00:00Z")]

    async def _list_review_comments(self, repo_full: str, number: int):
        assert repo_full == "octo/widget"
        assert number == 900
        return []

    async def _list_pr_reviews(self, repo_full: str, number: int):
        assert repo_full == "octo/widget"
        assert number == 900
        return []

    monkeypatch.setattr(GitHubClient, "get_pull_request", _get_pull_request)
    monkeypatch.setattr(GitHubClient, "get_repo", _get_repo)
    monkeypatch.setattr(GitHubClient, "get_issue", _get_issue)
    monkeypatch.setattr(GitHubClient, "list_comments", _list_comments)
    monkeypatch.setattr(GitHubClient, "list_review_comments", _list_review_comments)
    monkeypatch.setattr(GitHubClient, "list_pr_reviews", _list_pr_reviews)

    payload = {
        "action": "created",
        "issue": {"number": 900, "pull_request": {"url": "https://api.github.com/repos/octo/widget/pulls/900"}},
        "comment": {"user": {"login": "can1357"}, "body": "please fix", "id": 10, "created_at": "2026-05-15T00:00:00Z"},
        "repository": {"full_name": "octo/widget"},
    }
    await tasks.handle_pr_conversation(
        settings=settings,
        db=db,
        github=GitHubClient("t"),
        git_transport=LocalGitTransport(token=None),
        sandbox=sandbox,
        payload=payload,
        delivery_id="test-pr-direct",
    )

    assert len(stub_run_task) == 1
    call = stub_run_task[0]
    assert call["task_kind"] == "handle_comment"
    assert call["pr_number"] == 900
    assert call["inputs"].issue.is_pull_request is True
    assert [(m.kind, m.author, m.body) for m in call["thread"]] == [
        ("pr_body", settings.bot_login, "PR body"),
        ("comment", "can1357", "prior PR context"),
    ]
    assert sandbox.ensure_calls[0]["number"] == 900
    assert sandbox.ensure_calls[0]["existing_branch"] == "farm/abc12345/fix-flaky-parser"
    row = db.get_issue("octo/widget#900")
    assert row is not None
    assert row.pr_number == 900
    assert row.branch == "farm/abc12345/fix-flaky-parser"
    close_database()


async def test_handle_pr_conversation_repairs_missing_pr_mapping_from_branch(
    settings: Settings, tmp_path: Path, stub_run_task, monkeypatch
) -> None:
    from robomp import tasks
    from robomp.github_client import CommentInfo, IssueInfo, PullRequestInfo, RepoInfo

    sandbox = _RecordingSandbox(tmp_path)
    db = get_database(settings.sqlite_path)
    branch = "farm/abc12345/fix-flaky-parser"
    db.upsert_issue(key="octo/widget#42", repo="octo/widget", number=42, state="opened", branch=branch)
    repo = RepoInfo(
        full_name="octo/widget", default_branch="main", clone_url="https://github.com/octo/widget.git", private=False
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=42,
        title="Parser is flaky",
        body="issue body",
        state="open",
        author="alice",
        labels=(),
        is_pull_request=False,
    )
    pr_issue = IssueInfo(
        repo="octo/widget",
        number=900,
        title="Fix flaky parser",
        body="PR body",
        state="open",
        author=settings.bot_login,
        labels=(),
        is_pull_request=True,
    )
    pr_info = PullRequestInfo(
        repo="octo/widget",
        number=900,
        html_url="https://github.com/octo/widget/pull/900",
        head_ref=branch,
        base_ref="main",
        state="open",
        author=settings.bot_login,
        head_repo="octo/widget",
    )

    async def _get_pull_request(self, repo_full: str, number: int):
        assert repo_full == "octo/widget"
        assert number == 900
        return pr_info

    async def _get_repo(self, repo_full: str):
        assert repo_full == "octo/widget"
        return repo

    async def _get_issue(self, repo_full: str, number: int):
        assert repo_full == "octo/widget"
        if number == 42:
            return issue
        if number == 900:
            return pr_issue
        raise AssertionError(number)

    async def _list_comments(self, repo_full: str, number: int):
        assert repo_full == "octo/widget"
        assert number == 900
        return [CommentInfo(id=78, author="can1357", body="prior PR context", created_at="2026-05-14T00:00:00Z")]

    async def _list_review_comments(self, repo_full: str, number: int):
        assert repo_full == "octo/widget"
        assert number == 900
        return []

    async def _list_pr_reviews(self, repo_full: str, number: int):
        assert repo_full == "octo/widget"
        assert number == 900
        return []

    monkeypatch.setattr(GitHubClient, "get_pull_request", _get_pull_request)
    monkeypatch.setattr(GitHubClient, "get_repo", _get_repo)
    monkeypatch.setattr(GitHubClient, "get_issue", _get_issue)
    monkeypatch.setattr(GitHubClient, "list_comments", _list_comments)
    monkeypatch.setattr(GitHubClient, "list_review_comments", _list_review_comments)
    monkeypatch.setattr(GitHubClient, "list_pr_reviews", _list_pr_reviews)

    payload = {
        "action": "created",
        "issue": {"number": 900, "pull_request": {"url": "https://api.github.com/repos/octo/widget/pulls/900"}},
        "comment": {"user": {"login": "can1357"}, "body": "please fix", "id": 11, "created_at": "2026-05-15T00:00:00Z"},
        "repository": {"full_name": "octo/widget"},
    }
    await tasks.handle_pr_conversation(
        settings=settings,
        db=db,
        github=GitHubClient("t"),
        git_transport=LocalGitTransport(token=None),
        sandbox=sandbox,
        payload=payload,
        delivery_id="test-pr-repair",
    )

    assert len(stub_run_task) == 1
    call = stub_run_task[0]
    assert call["inputs"].issue.number == 42
    assert call["pr_number"] == 900
    assert [(m.kind, m.author, m.body) for m in call["thread"]] == [
        ("pr_body", settings.bot_login, "PR body"),
        ("comment", "can1357", "prior PR context"),
    ]
    assert sandbox.ensure_calls[0]["number"] == 42
    assert sandbox.ensure_calls[0]["existing_branch"] == branch
    row = db.get_issue("octo/widget#42")
    assert row is not None
    assert row.pr_number == 900
    close_database()


async def test_handle_pr_conversation_skips_review_workspace_rows(
    settings: Settings, tmp_path: Path, stub_run_task, monkeypatch
) -> None:
    from robomp import tasks
    from robomp.github_client import GitHubClient, PullRequestInfo

    sandbox = _RecordingSandbox(tmp_path)
    db = get_database(settings.sqlite_path)
    db.upsert_issue(
        key="octo/widget#900",
        repo="octo/widget",
        number=900,
        state="reviewing",
        branch="review/pr-900",
        pr_number=900,
    )

    async def _get_pull_request(self, repo_full: str, number: int):
        assert repo_full == "octo/widget"
        assert number == 900
        return PullRequestInfo(
            repo="octo/widget",
            number=900,
            html_url="https://github.com/octo/widget/pull/900",
            head_ref="contrib/fix",
            base_ref="main",
            state="open",
            author="alice",
            head_repo="alice/widget",
        )

    monkeypatch.setattr(GitHubClient, "get_pull_request", _get_pull_request)

    payload = {
        "action": "created",
        "issue": {
            "number": 900,
            "user": {"login": "alice"},
            "pull_request": {"url": "https://api.github.com/repos/octo/widget/pulls/900"},
        },
        "comment": {"user": {"login": "can1357"}, "body": "@robomp-bot please re-review", "id": 12},
        "repository": {"full_name": "octo/widget"},
        "_robomp_directive": {"body": "please re-review", "author": "can1357"},
    }
    await tasks.handle_pr_conversation(
        settings=settings,
        db=db,
        github=GitHubClient("t"),
        git_transport=LocalGitTransport(token=None),
        sandbox=sandbox,
        payload=payload,
        delivery_id="test-pr-review-row",
    )

    assert stub_run_task == []
    assert sandbox.ensure_calls == []
    close_database()


async def test_review_pr_retries_when_ranked_but_not_submitted(
    settings: Settings, tmp_path: Path, stub_run_task, monkeypatch
) -> None:
    from robomp import tasks
    from robomp.github_client import GitHubClient, IssueInfo, PullRequestInfo, RepoInfo

    sandbox = _RecordingSandbox(tmp_path)
    db = get_database(settings.sqlite_path)
    repo = RepoInfo(
        full_name="octo/widget", default_branch="main", clone_url="https://github.com/octo/widget.git", private=False
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=900,
        title="Fix parser",
        body="body",
        state="open",
        author="alice",
        labels=("triaged", "review:p1"),
        is_pull_request=True,
    )
    pr = PullRequestInfo(
        repo="octo/widget",
        number=900,
        html_url="https://github.com/octo/widget/pull/900",
        head_ref="alice/fix-parser",
        base_ref="main",
        state="open",
        author="alice",
        head_repo="alice/widget",
    )

    async def _get_repo(self, repo_full: str):
        assert repo_full == "octo/widget"
        return repo

    async def _get_issue(self, repo_full: str, number: int):
        assert repo_full == "octo/widget"
        assert number == 900
        return issue

    async def _get_pull_request(self, repo_full: str, number: int):
        assert repo_full == "octo/widget"
        assert number == 900
        return pr

    monkeypatch.setattr(GitHubClient, "get_repo", _get_repo)
    monkeypatch.setattr(GitHubClient, "get_issue", _get_issue)
    monkeypatch.setattr(GitHubClient, "get_pull_request", _get_pull_request)

    await tasks.review_pr(
        settings=settings,
        db=db,
        github=GitHubClient("t"),
        sandbox=sandbox,
        git_transport=LocalGitTransport(token=None),
        payload={"pull_request": {"number": 900}, "repository": {"full_name": "octo/widget"}},
        delivery_id="d-review-retry",
    )

    assert len(stub_run_task) == 1
    assert stub_run_task[0]["task_kind"] == "review_pr"
    assert sandbox.ensure_calls[0]["pr_head"] == 900
    close_database()


async def test_review_pr_skips_after_submitted_review(
    settings: Settings, tmp_path: Path, stub_run_task, monkeypatch
) -> None:
    from robomp import tasks
    from robomp.github_client import GitHubClient, IssueInfo, PullRequestInfo, RepoInfo

    sandbox = _RecordingSandbox(tmp_path)
    db = get_database(settings.sqlite_path)
    key = issue_key("octo/widget", 900)
    db.log_tool_call(issue_key=key, tool="submit_pr_review", args={"body": "done"}, result={"review_id": 12})
    repo = RepoInfo(
        full_name="octo/widget", default_branch="main", clone_url="https://github.com/octo/widget.git", private=False
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=900,
        title="Fix parser",
        body="body",
        state="open",
        author="alice",
        labels=("triaged", "review:p1"),
        is_pull_request=True,
    )
    pr = PullRequestInfo(
        repo="octo/widget",
        number=900,
        html_url="https://github.com/octo/widget/pull/900",
        head_ref="alice/fix-parser",
        base_ref="main",
        state="open",
        author="alice",
        head_repo="alice/widget",
    )

    async def _get_repo(self, repo_full: str):
        assert repo_full == "octo/widget"
        return repo

    async def _get_issue(self, repo_full: str, number: int):
        assert repo_full == "octo/widget"
        assert number == 900
        return issue

    async def _get_pull_request(self, repo_full: str, number: int):
        assert repo_full == "octo/widget"
        assert number == 900
        return pr

    monkeypatch.setattr(GitHubClient, "get_repo", _get_repo)
    monkeypatch.setattr(GitHubClient, "get_issue", _get_issue)
    monkeypatch.setattr(GitHubClient, "get_pull_request", _get_pull_request)

    await tasks.review_pr(
        settings=settings,
        db=db,
        github=GitHubClient("t"),
        sandbox=sandbox,
        git_transport=LocalGitTransport(token=None),
        payload={"pull_request": {"number": 900}, "repository": {"full_name": "octo/widget"}},
        delivery_id="d-review-skip",
    )

    assert stub_run_task == []
    assert sandbox.ensure_calls == []
    close_database()


async def test_handle_comment_directive_bootstraps_untriaged_issue(
    settings: Settings, tmp_path: Path, stub_run_task, monkeypatch
) -> None:
    """Directive on an unknown issue → DB row created, triage_issue task with directive."""
    from robomp import tasks
    from robomp.github_client import GitHubClient, IssueInfo, RepoInfo

    sandbox = _RecordingSandbox(tmp_path)
    db = get_database(settings.sqlite_path)
    repo = RepoInfo(
        full_name="octo/widget", default_branch="main", clone_url="https://github.com/octo/widget.git", private=False
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=88,
        title="boom",
        body="details",
        state="open",
        author="alice",
        labels=(),
        is_pull_request=False,
    )

    async def _resolve(_gh, _payload):
        return repo, issue

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve)

    payload = {
        "action": "created",
        "issue": {"number": 88, "user": {"login": "alice"}, "title": "boom"},
        "comment": {"user": {"login": "can1357"}, "body": "do it", "id": 1, "created_at": "2026-05-14T20:00:00Z"},
        "repository": {"full_name": "octo/widget"},
        "_robomp_directive": {"body": "please refactor X", "author": "can1357"},
    }
    await tasks.handle_comment(
        settings=settings,
        db=db,
        github=GitHubClient("t"),
        git_transport=LocalGitTransport(token=None),
        sandbox=sandbox,
        payload=payload,
        delivery_id="test-delivery-1",
    )
    assert len(stub_run_task) == 1
    call = stub_run_task[0]
    assert call["task_kind"] == "triage_issue"
    assert call["directive"] is not None
    assert call["directive"].body == "please refactor X"
    assert call["directive"].author == "can1357"
    row = db.get_issue("octo/widget#88")
    assert row is not None
    assert row.state == "reproducing"
    assert sandbox.ensure_calls, "ensure_workspace must be called"
    assert sandbox.remove_calls == [], "no removal on bootstrap"
    close_database()


async def test_handle_comment_directive_reopens_finalized_issue(
    settings: Settings, tmp_path: Path, stub_run_task, monkeypatch
) -> None:
    """Directive on a closed issue → workspace torn down, state reset, no auto-reply."""
    from robomp import tasks
    from robomp.github_client import GitHubClient, IssueInfo, RepoInfo

    sandbox = _RecordingSandbox(tmp_path)
    db = get_database(settings.sqlite_path)
    db.upsert_issue(
        key="octo/widget#88", repo="octo/widget", number=88, state="closed", branch="farm/old/branch", pr_number=99
    )

    repo = RepoInfo(
        full_name="octo/widget", default_branch="main", clone_url="https://github.com/octo/widget.git", private=False
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=88,
        title="boom",
        body="details",
        state="open",
        author="alice",
        labels=(),
        is_pull_request=False,
    )

    async def _resolve(_gh, _payload):
        return repo, issue

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve)

    post_comment_calls: list = []

    async def _no_post_comment(*args, **kwargs):
        post_comment_calls.append((args, kwargs))
        return None

    monkeypatch.setattr(GitHubClient, "post_comment", _no_post_comment)

    payload = {
        "action": "created",
        "issue": {"number": 88, "user": {"login": "alice"}, "title": "boom"},
        "comment": {"user": {"login": "can1357"}, "body": "redo", "id": 2, "created_at": "2026-05-14T21:00:00Z"},
        "repository": {"full_name": "octo/widget"},
        "_robomp_directive": {"body": "redo the fix", "author": "can1357"},
    }
    await tasks.handle_comment(
        settings=settings,
        db=db,
        github=GitHubClient("t"),
        git_transport=LocalGitTransport(token=None),
        sandbox=sandbox,
        payload=payload,
        delivery_id="test-delivery-2",
    )
    assert len(stub_run_task) == 1
    call = stub_run_task[0]
    assert call["task_kind"] == "handle_comment"
    assert call["directive"].body == "redo the fix"
    assert sandbox.remove_calls == [("octo/widget", 88)]
    assert sandbox.ensure_calls
    # Reopen branches afresh (no existing_branch passed).
    assert sandbox.ensure_calls[0]["existing_branch"] is None
    assert post_comment_calls == [], "no 'this is closed' comment on reopen"
    row = db.get_issue("octo/widget#88")
    assert row is not None and row.state == "reproducing"
    close_database()


async def test_handle_comment_finalized_without_directive_still_replies(
    settings: Settings, tmp_path: Path, stub_run_task, monkeypatch
) -> None:
    """Non-maintainer on a closed issue → original behavior preserved."""
    from robomp import tasks
    from robomp.github_client import GitHubClient, IssueInfo, RepoInfo

    sandbox = _RecordingSandbox(tmp_path)
    db = get_database(settings.sqlite_path)
    db.upsert_issue(
        key="octo/widget#88", repo="octo/widget", number=88, state="closed", branch="farm/old/branch", pr_number=99
    )

    repo = RepoInfo(
        full_name="octo/widget", default_branch="main", clone_url="https://github.com/octo/widget.git", private=False
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=88,
        title="boom",
        body="details",
        state="closed",
        author="alice",
        labels=(),
        is_pull_request=False,
    )

    async def _resolve(_gh, _payload):
        return repo, issue

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve)

    post_comment_calls: list = []

    async def _capture_post(self, *args, **kwargs):
        post_comment_calls.append((args, kwargs))
        return None

    monkeypatch.setattr(GitHubClient, "post_comment", _capture_post)

    payload = {
        "action": "created",
        "issue": {"number": 88, "user": {"login": "stranger"}, "title": "boom"},
        "comment": {
            "user": {"login": "stranger"},
            "body": "still broken",
            "id": 3,
            "created_at": "2026-05-14T22:00:00Z",
        },
        "repository": {"full_name": "octo/widget"},
    }
    await tasks.handle_comment(
        settings=settings,
        db=db,
        github=GitHubClient("t"),
        git_transport=LocalGitTransport(token=None),
        sandbox=sandbox,
        payload=payload,
        delivery_id="test-delivery-3",
    )
    assert stub_run_task == [], "must not invoke run_task on plain finalized comment"
    assert post_comment_calls, "should post the finalized-issue reply"
    assert sandbox.remove_calls == []
    close_database()


async def test_handle_comment_resumes_needs_info_without_preemptive_cleanup(
    settings: Settings, tmp_path: Path, stub_run_task, monkeypatch
) -> None:
    """A needs-info reply resumes first; host tools clear state only after actionable work."""
    from robomp import tasks
    from robomp.github_client import GitHubClient, IssueInfo, RepoInfo

    sandbox = _RecordingSandbox(tmp_path)
    db = get_database(settings.sqlite_path)
    db.upsert_issue(
        key="octo/widget#88",
        repo="octo/widget",
        number=88,
        state="needs_info",
        branch="farm/old/branch",
    )

    repo = RepoInfo(
        full_name="octo/widget", default_branch="main", clone_url="https://github.com/octo/widget.git", private=False
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=88,
        title="boom",
        body="details",
        state="open",
        author="alice",
        labels=("needs-info",),
        is_pull_request=False,
    )

    async def _resolve(_gh, _payload):
        return repo, issue

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve)

    post_comment_calls: list = []
    removed_labels: list[tuple[str, int, str]] = []

    async def _capture_post(self, *args, **kwargs):
        post_comment_calls.append((args, kwargs))
        return None

    async def _capture_remove_label(self, repo: str, number: int, label: str) -> None:
        removed_labels.append((repo, number, label))

    monkeypatch.setattr(GitHubClient, "post_comment", _capture_post)
    monkeypatch.setattr(GitHubClient, "remove_issue_label", _capture_remove_label)

    payload = {
        "action": "created",
        "issue": {"number": 88, "user": {"login": "alice"}, "title": "boom"},
        "comment": {
            "user": {"login": "alice"},
            "body": "I am on Bun 1.3.14 and here is the trace",
            "id": 4,
            "created_at": "2026-05-14T23:00:00Z",
        },
        "repository": {"full_name": "octo/widget"},
    }
    await tasks.handle_comment(
        settings=settings,
        db=db,
        github=GitHubClient("t"),
        git_transport=LocalGitTransport(token=None),
        sandbox=sandbox,
        payload=payload,
        delivery_id="test-delivery-needs-info",
    )
    assert len(stub_run_task) == 1
    call = stub_run_task[0]
    assert call["task_kind"] == "handle_comment"
    assert call["comment"].body == "I am on Bun 1.3.14 and here is the trace"
    assert sandbox.ensure_calls[0]["existing_branch"] == "farm/old/branch"
    assert removed_labels == []
    assert post_comment_calls == [], "needs-info replies must not get the finalized-issue notice"
    row = db.get_issue("octo/widget#88")
    assert row is not None and row.state == "needs_info"
    close_database()


async def test_directive_handler_attaches_thread_from_github(
    settings: Settings, tmp_path: Path, stub_run_task, monkeypatch
) -> None:
    """When a directive lands, the handler must hydrate the thread before run_task."""
    from robomp import tasks
    from robomp.github_client import (
        CommentInfo,
        GitHubClient,
        IssueInfo,
        RepoInfo,
    )

    sandbox = _RecordingSandbox(tmp_path)
    db = get_database(settings.sqlite_path)

    repo = RepoInfo(
        full_name="octo/widget", default_branch="main", clone_url="https://github.com/octo/widget.git", private=False
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=88,
        title="boom",
        body="the body",
        state="open",
        author="alice",
        labels=(),
        is_pull_request=False,
    )

    async def _resolve(_gh, _payload):
        return repo, issue

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve)

    # Stub GitHubClient endpoints used by _fetch_thread.
    async def _get_issue(self, _repo, _number):
        return issue

    async def _list_comments(self, _repo, _number):
        return [
            CommentInfo(id=1, author="alice", body="me too", created_at="2026-05-01T10:00:00Z"),
            CommentInfo(id=2, author="bob", body="confirmed", created_at="2026-05-02T10:00:00Z"),
        ]

    monkeypatch.setattr(GitHubClient, "get_issue", _get_issue)
    monkeypatch.setattr(GitHubClient, "list_comments", _list_comments)

    payload = {
        "action": "created",
        "issue": {"number": 88, "user": {"login": "alice"}, "title": "boom"},
        "comment": {
            "user": {"login": "can1357"},
            "body": "@roboomp do X",
            "id": 10,
            "created_at": "2026-05-03T20:00:00Z",
        },
        "repository": {"full_name": "octo/widget"},
        "_robomp_directive": {"body": "do X", "author": "can1357"},
    }
    # Pre-seed an issue row so we exercise the "existing, non-finalized" path
    # (otherwise we'd hit the bootstrap branch which is covered elsewhere).
    db.upsert_issue(key="octo/widget#88", repo="octo/widget", number=88, state="reproducing", branch="farm/x/y")

    await tasks.handle_comment(
        settings=settings,
        db=db,
        github=GitHubClient("t"),
        git_transport=LocalGitTransport(token=None),
        sandbox=sandbox,
        payload=payload,
        delivery_id="test-delivery-4",
    )

    assert len(stub_run_task) == 1
    directive = stub_run_task[0]["directive"]
    assert directive is not None
    assert directive.body == "do X"
    # Thread must include the body + both comments, in chronological order.
    kinds_authors = [(m.kind, m.author) for m in directive.thread]
    assert ("issue_body", "alice") in kinds_authors
    assert ("comment", "alice") in kinds_authors
    assert ("comment", "bob") in kinds_authors
    close_database()


# ---------- triage_issue: closing-PR skip ----------


class _StubGithubForTriage:
    """Minimal `GitHubBackend` shim for triage_issue tests."""

    def __init__(self, closing_prs: tuple[int, ...] | Exception = ()) -> None:
        self._closing_prs = closing_prs
        self.calls: list[tuple[str, int]] = []

    async def list_closing_pull_requests(self, repo: str, number: int) -> tuple[int, ...]:
        self.calls.append((repo, number))
        if isinstance(self._closing_prs, Exception):
            raise self._closing_prs
        return self._closing_prs


async def test_triage_issue_skips_when_a_closing_pr_already_exists(
    settings: Settings, tmp_path: Path, stub_run_task, monkeypatch
) -> None:
    """An OPEN PR linked via Closes/Fixes/Resolves means another author is on it.
    The bot MUST NOT triage, label, or build a workspace — leave it alone."""
    from robomp import tasks
    from robomp.github_client import IssueInfo, RepoInfo

    sandbox = _RecordingSandbox(tmp_path)
    db = get_database(settings.sqlite_path)
    repo = RepoInfo(
        full_name="octo/widget", default_branch="main", clone_url="https://github.com/octo/widget.git", private=False
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=1069,
        title="x",
        body="y",
        state="open",
        author="alice",
        labels=(),
        is_pull_request=False,
    )

    async def _resolve(_gh, _payload):
        return repo, issue

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve)
    github = _StubGithubForTriage(closing_prs=(1070,))

    await tasks.triage_issue(
        settings=settings,
        db=db,
        github=github,  # type: ignore[arg-type]
        git_transport=LocalGitTransport(token=None),
        sandbox=sandbox,  # type: ignore[arg-type]
        payload={"action": "opened", "issue": {"number": 1069}, "repository": {"full_name": "octo/widget"}},
        delivery_id="t-skip-1",
    )

    assert github.calls == [("octo/widget", 1069)]
    assert stub_run_task == [], "must not invoke run_task when a closing PR exists"
    assert sandbox.ensure_calls == [], "must not create a workspace when skipping"
    assert db.get_issue("octo/widget#1069") is None, "must not persist an issue row when skipping"
    close_database()


async def test_triage_issue_proceeds_when_no_closing_pr(
    settings: Settings, tmp_path: Path, stub_run_task, monkeypatch
) -> None:
    from robomp import tasks
    from robomp.github_client import IssueInfo, RepoInfo

    sandbox = _RecordingSandbox(tmp_path)
    db = get_database(settings.sqlite_path)
    repo = RepoInfo(
        full_name="octo/widget", default_branch="main", clone_url="https://github.com/octo/widget.git", private=False
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=42,
        title="x",
        body="y",
        state="open",
        author="alice",
        labels=(),
        is_pull_request=False,
    )

    async def _resolve(_gh, _payload):
        return repo, issue

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve)
    github = _StubGithubForTriage(closing_prs=())

    await tasks.triage_issue(
        settings=settings,
        db=db,
        github=github,  # type: ignore[arg-type]
        git_transport=LocalGitTransport(token=None),
        sandbox=sandbox,  # type: ignore[arg-type]
        payload={"action": "opened", "issue": {"number": 42}, "repository": {"full_name": "octo/widget"}},
        delivery_id="t-skip-2",
    )

    assert github.calls == [("octo/widget", 42)]
    assert len(stub_run_task) == 1
    assert sandbox.ensure_calls, "workspace must be created when no closing PR"
    row = db.get_issue("octo/widget#42")
    assert row is not None and row.state == "reproducing"
    close_database()


async def test_triage_issue_fails_open_when_timeline_fetch_errors(
    settings: Settings, tmp_path: Path, stub_run_task, monkeypatch
) -> None:
    """A transient timeline fetch failure MUST NOT block legitimate triage."""
    from robomp import tasks
    from robomp.github_client import GitHubError, IssueInfo, RepoInfo

    sandbox = _RecordingSandbox(tmp_path)
    db = get_database(settings.sqlite_path)
    repo = RepoInfo(
        full_name="octo/widget", default_branch="main", clone_url="https://github.com/octo/widget.git", private=False
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=99,
        title="x",
        body="y",
        state="open",
        author="alice",
        labels=(),
        is_pull_request=False,
    )

    async def _resolve(_gh, _payload):
        return repo, issue

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve)
    github = _StubGithubForTriage(closing_prs=GitHubError(503, "upstream timeout"))

    await tasks.triage_issue(
        settings=settings,
        db=db,
        github=github,  # type: ignore[arg-type]
        git_transport=LocalGitTransport(token=None),
        sandbox=sandbox,  # type: ignore[arg-type]
        payload={"action": "opened", "issue": {"number": 99}, "repository": {"full_name": "octo/widget"}},
        delivery_id="t-skip-3",
    )

    assert len(stub_run_task) == 1, "transient timeline error must fail open"
    assert sandbox.ensure_calls
    close_database()


async def test_triage_issue_does_not_recheck_when_issue_row_exists(
    settings: Settings, tmp_path: Path, stub_run_task, monkeypatch
) -> None:
    """A second triage of the same issue (e.g. retry/replay) MUST NOT re-query the
    timeline — the bot is already committed and the row guards re-entry."""
    from robomp import tasks
    from robomp.github_client import IssueInfo, RepoInfo

    sandbox = _RecordingSandbox(tmp_path)
    db = get_database(settings.sqlite_path)
    # Pre-seed the issue row as if a prior triage created it.
    db.upsert_issue(key="octo/widget#7", repo="octo/widget", number=7, state="reproducing")

    repo = RepoInfo(
        full_name="octo/widget", default_branch="main", clone_url="https://github.com/octo/widget.git", private=False
    )
    issue = IssueInfo(
        repo="octo/widget",
        number=7,
        title="x",
        body="y",
        state="open",
        author="alice",
        labels=(),
        is_pull_request=False,
    )

    async def _resolve(_gh, _payload):
        return repo, issue

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve)
    github = _StubGithubForTriage(closing_prs=(1070,))  # would skip if called

    await tasks.triage_issue(
        settings=settings,
        db=db,
        github=github,  # type: ignore[arg-type]
        git_transport=LocalGitTransport(token=None),
        sandbox=sandbox,  # type: ignore[arg-type]
        payload={"action": "opened", "issue": {"number": 7}, "repository": {"full_name": "octo/widget"}},
        delivery_id="t-skip-4",
    )

    assert github.calls == [], "MUST NOT query timeline on a repeat-triage"
    assert len(stub_run_task) == 1
    close_database()


# -------- /webhook/github cancellation hooks --------------------------------


def _post_issue_comment_simple(
    client: TestClient,
    *,
    delivery: str,
    issue_number: int,
    user: str = "alice",
    secret: str = "test-webhook-secret",
):
    return _post_issue_comment(
        client,
        delivery=delivery,
        user=user,
        number=issue_number,
        body="follow-up",
        secret=secret,
    )


def _post_issues_closed(
    client: TestClient,
    *,
    delivery: str,
    issue_number: int,
    secret: str = "test-webhook-secret",
):
    payload = {
        "action": "closed",
        "issue": {"number": issue_number, "user": {"login": "alice"}},
        "repository": {"full_name": "octo/widget"},
    }
    body = json.dumps(payload).encode()
    return client.post(
        "/webhook/github",
        content=body,
        headers=_signed_headers(secret, body, event="issues", delivery=delivery),
    )


def _seed_pending_closure(db, *, key: str, number: int) -> None:
    db.upsert_pending_closure(
        issue_key=key,
        repo="octo/widget",
        number=number,
        comment_id=42,
        issue_author="alice",
        close_at="2999-01-01T00:00:00.000000Z",
    )


def test_webhook_issue_comment_cancels_pending_closure(settings: Settings) -> None:
    db = get_database(settings.sqlite_path)
    key = issue_key("octo/widget", 7)
    _seed_pending_closure(db, key=key, number=7)
    app = create_app(settings)
    with TestClient(app) as client:
        resp = _post_issue_comment_simple(client, delivery="d-cancel-comment", issue_number=7)
    assert resp.status_code == 202
    row = db.get_pending_closure(key)
    assert row is not None
    assert row.state == "cancelled"
    assert row.cancel_reason == "user_replied"
    close_database()


def test_webhook_issues_closed_cancels_pending_closure(settings: Settings) -> None:
    db = get_database(settings.sqlite_path)
    key = issue_key("octo/widget", 8)
    _seed_pending_closure(db, key=key, number=8)
    app = create_app(settings)
    with TestClient(app) as client:
        resp = _post_issues_closed(client, delivery="d-cancel-closed", issue_number=8)
    assert resp.status_code == 202
    row = db.get_pending_closure(key)
    assert row is not None
    assert row.state == "cancelled"
    assert row.cancel_reason == "externally_closed"
    close_database()


def test_webhook_pr_conversation_does_not_cancel_pending_closure(settings: Settings) -> None:
    """A comment on a PR (issue payload with `pull_request`) routes to
    `handle_pr_conversation`, which is unrelated to the question auto-close
    schedule on the originating issue."""
    db = get_database(settings.sqlite_path)
    key = issue_key("octo/widget", 9)
    _seed_pending_closure(db, key=key, number=9)
    app = create_app(settings)
    with TestClient(app) as client:
        # Use the existing PR-issue-comment helper (number 9 here is the PR).
        resp = _post_pr_issue_comment(
            client,
            delivery="d-pr-noop",
            user="alice",
            pr_number=9,
        )
    assert resp.status_code == 202
    row = db.get_pending_closure(key)
    # Row may have been touched only if the PR maps back to issue 9; safest
    # assertion: the row stays `pending` because routing went down a path
    # other than `handle_comment`.
    assert row is not None
    assert row.state == "pending"
    close_database()
