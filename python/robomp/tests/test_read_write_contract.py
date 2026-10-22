"""Server/UI contract: every dashboard read and write carries the same token.

The token never ships in the page HTML (`GET /` is unauthenticated), so the
SPA round-trips its credential through the token-gated `GET /api/config` and
attaches it to every call it makes — reads included. Token-less deployments
(loopback dev) keep every read open: there is no credential to protect, and
the bind address is the mitigation.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from robomp.config import Settings, reset_settings_cache
from robomp.db import close_database, get_database
from robomp.server import create_app


class _PausedPool:
    def __init__(self) -> None:
        self.started = False
        self.stopped = False

    async def start(self) -> None:
        self.started = True

    async def stop(self, *, drain_timeout: float = 25.0, kill_timeout: float = 5.0) -> None:
        self.stopped = True

    def wake(self) -> None:
        pass

    async def cancel_event(self, delivery_id: str) -> bool:
        return False

    async def inflight_snapshot(self) -> list[str]:
        return []


class _PausedPoolFactory:
    def __call__(self, settings, db, github, sandbox, git_transport):
        return _PausedPool()


def _create_app(settings: Settings):
    return create_app(settings, pool_factory=_PausedPoolFactory())


def _enable_token(monkeypatch: pytest.MonkeyPatch) -> str:
    token = "contract-secret-1"
    monkeypatch.setenv("ROBOMP_REPLAY_TOKEN", token)
    reset_settings_cache()
    return token


def _tokened_settings() -> Settings:
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    return cfg


READ_PATHS = ("/api/status", "/api/logs", "/events", "/issues", "/releases")


def test_read_endpoints_gated_with_token_configured(
    env, monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    """With a token configured, dashboard reads require the auth header —
    they expose the same delivery/issue data as the gated write paths, so a
    read hole would make the write gating illusory. 401 without the header
    (missing or wrong), 200 with the valid token."""
    token = _enable_token(monkeypatch)
    cfg = _tokened_settings()
    app = _create_app(cfg)
    with TestClient(app) as client:
        for path in READ_PATHS:
            missing = client.get(path)
            assert missing.status_code == 401, f"{path} must be gated: got {missing.status_code}"
            wrong = client.get(path, headers={"X-Robomp-Replay-Token": f"{token}-wrong"})
            assert wrong.status_code == 401, f"{path} must reject a wrong token"
            valid = client.get(path, headers={"X-Robomp-Replay-Token": token})
            assert valid.status_code == 200, f"{path} must accept the token: {valid.text}"
    close_database()


def test_read_endpoints_open_without_token(env, settings: Settings) -> None:
    """Token-less dev deployments keep reads open: no header, no 401, no 404."""
    app = _create_app(settings)
    with TestClient(app) as client:
        for path in READ_PATHS:
            resp = client.get(path)
            assert resp.status_code == 200, f"{path} must stay open in dev: got {resp.status_code}"
    close_database()


def test_api_config_gate_with_token_configured(env, monkeypatch: pytest.MonkeyPatch) -> None:
    """/api/config is the only route that hands out the token, and only to
    callers who already present it. `GET /` must never contain it."""
    token = _enable_token(monkeypatch)
    cfg = _tokened_settings()
    app = _create_app(cfg)
    with TestClient(app) as client:
        page = client.get("/")
        assert page.status_code == 200
        assert '"replayEnabled":true' in page.text
        assert token not in page.text, "the dashboard HTML must never embed the token"

        missing = client.get("/api/config")
        assert missing.status_code == 401

        wrong = client.get("/api/config", headers={"X-Robomp-Replay-Token": f"{token}-wrong"})
        assert wrong.status_code == 401

        valid = client.get("/api/config", headers={"X-Robomp-Replay-Token": token})
        assert valid.status_code == 200
        assert valid.json() == {"replayEnabled": True, "replayToken": token}
    close_database()


def test_api_config_open_when_disabled(env, settings: Settings) -> None:
    """No token configured: /api/config is unauthenticated and reports replay
    as disabled (open dev mode — no auth round-trip for the SPA)."""
    app = _create_app(settings)
    with TestClient(app) as client:
        resp = client.get("/api/config")
        assert resp.status_code == 200
        assert resp.json() == {"replayEnabled": False, "replayToken": ""}

        page = client.get("/")
        assert '"replayEnabled":false' in page.text
    close_database()


def test_write_endpoints_still_gated_with_token_configured(
    env, monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    """The same configured token must still enforce auth on write/replay
    endpoints: 401 without the header, accepted with the valid token."""
    token = _enable_token(monkeypatch)
    cfg = _tokened_settings()
    app = _create_app(cfg)
    with TestClient(app) as client:
        db = get_database(cfg.sqlite_path)
        db.record_event(
            delivery_id="contract-d-1",
            event_type="issues",
            repo="octo/widget",
            issue_key="octo/widget#1",
            payload={"action": "opened"},
            state="failed",
        )

        missing = client.post("/replay", params={"delivery_id": "contract-d-1"})
        assert missing.status_code == 401

        wrong = client.post(
            "/replay",
            params={"delivery_id": "contract-d-1"},
            headers={"X-Robomp-Replay-Token": f"{token}-wrong"},
        )
        assert wrong.status_code == 401

        valid = client.post(
            "/replay",
            params={"delivery_id": "contract-d-1"},
            headers={"X-Robomp-Replay-Token": token},
        )
        assert valid.status_code == 200, valid.text

        missing_trigger = client.post("/api/trigger", json={"mode": "triage", "issue": "octo/widget#1"})
        assert missing_trigger.status_code == 401
    close_database()
