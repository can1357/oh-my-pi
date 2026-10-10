"""Dispatcher recovery and readiness when the SQLite queue cannot be claimed."""

from __future__ import annotations

import asyncio
import sqlite3
import time
from threading import Event

from fastapi.testclient import TestClient

from robomp import tasks
from robomp.db import Database
from robomp.server import create_app
from tests.test_server import _post_issue_opened


def test_transient_claim_error_does_not_strand_webhooks(settings, monkeypatch) -> None:
    fault_seen = Event()
    dispatched = Event()
    real_claim = Database.claim_next_event

    def flaky_claim(self):
        if not fault_seen.is_set():
            fault_seen.set()
            raise sqlite3.OperationalError("database is locked")
        return real_claim(self)

    async def record_triage(**kwargs):
        dispatched.set()

    monkeypatch.setattr(Database, "claim_next_event", flaky_claim)
    monkeypatch.setattr(tasks, "triage_issue", record_triage)

    app = create_app(settings)
    with TestClient(app) as client:
        assert fault_seen.wait(2)
        response = _post_issue_opened(client, delivery="locked-1", user="reporter", number=11)
        assert response.status_code == 202
        assert dispatched.wait(3), (
            f"event state={app.state.bag['db'].get_event('locked-1').state}, "
            f"readiness={client.get('/readyz').status_code}"
        )
        deadline = time.monotonic() + 2
        while app.state.bag["db"].get_event("locked-1").state != "done" and time.monotonic() < deadline:
            time.sleep(0.02)
        assert app.state.bag["db"].get_event("locked-1").state == "done"
        assert client.get("/readyz").status_code == 200


def test_readyz_rejects_stopped_dispatcher(settings) -> None:
    app = create_app(settings)
    with TestClient(app) as client:

        async def stop_dispatcher() -> None:
            task = app.state.bag["pool"]._workers[0]
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        client.portal.call(stop_dispatcher)
        assert client.get("/readyz").status_code == 503
        assert client.get("/healthz").status_code == 200
