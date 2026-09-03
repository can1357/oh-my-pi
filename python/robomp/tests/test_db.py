from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from robomp.db import Database, iso_seconds_ago, issue_key


def test_record_event_dedupes_by_delivery(db: Database) -> None:
    payload = {"action": "opened", "issue": {"number": 1}}
    assert db.record_event(
        delivery_id="abc",
        event_type="issues",
        repo="octo/widget",
        issue_key=issue_key("octo/widget", 1),
        payload=payload,
    )
    assert not db.record_event(
        delivery_id="abc",
        event_type="issues",
        repo="octo/widget",
        issue_key=issue_key("octo/widget", 1),
        payload=payload,
    )


def test_claim_next_event_singleton_under_contention(db: Database) -> None:
    for i in range(5):
        db.record_event(
            delivery_id=f"d-{i}",
            event_type="issues",
            repo="octo/widget",
            issue_key=issue_key("octo/widget", i),
            payload={"i": i},
        )

    winners: list[str] = []
    lock = threading.Lock()

    def claim() -> None:
        row = db.claim_next_event()
        if row is not None:
            with lock:
                winners.append(row.delivery_id)

    with ThreadPoolExecutor(max_workers=8) as pool:
        for _ in range(5):
            futures = [pool.submit(claim) for _ in range(8)]
            for f in futures:
                f.result()

    # Each delivery id should appear exactly once.
    assert sorted(winners) == [f"d-{i}" for i in range(5)]
    assert all(db.get_event(f"d-{i}").state == "running" for i in range(5))


def test_claim_next_event_leaves_same_issue_queued_while_running(db: Database) -> None:
    key = issue_key("octo/widget", 4)
    db.record_event(
        delivery_id="running",
        event_type="issue_comment",
        repo="octo/widget",
        issue_key=key,
        payload={"action": "created"},
        state="running",
    )
    db.record_event(
        delivery_id="queued",
        event_type="issue_comment",
        repo="octo/widget",
        issue_key=key,
        payload={"action": "created"},
    )

    assert db.claim_next_event() is None
    assert db.get_event("queued").state == "queued"

    db.mark_event("running", "done")
    claimed = db.claim_next_event()
    assert claimed is not None
    assert claimed.delivery_id == "queued"
    assert db.get_event("queued").state == "running"


def test_claim_next_event_skips_blocked_issue_without_stalling_others(db: Database) -> None:
    blocked = issue_key("octo/widget", 4)
    ready = issue_key("octo/widget", 5)
    db.record_event(
        delivery_id="running",
        event_type="issue_comment",
        repo="octo/widget",
        issue_key=blocked,
        payload={"action": "created"},
        state="running",
    )
    db.record_event(
        delivery_id="blocked",
        event_type="issue_comment",
        repo="octo/widget",
        issue_key=blocked,
        payload={"action": "created"},
    )
    db.record_event(
        delivery_id="ready",
        event_type="issues",
        repo="octo/widget",
        issue_key=ready,
        payload={"action": "opened"},
    )

    claimed = db.claim_next_event()
    assert claimed is not None
    assert claimed.delivery_id == "ready"
    assert db.get_event("blocked").state == "queued"


def test_requeue_event_can_be_restricted_by_source_state(db: Database) -> None:
    db.record_event(
        delivery_id="done-event",
        event_type="issues",
        repo="octo/widget",
        issue_key=issue_key("octo/widget", 1),
        payload={},
        state="done",
    )
    db.record_event(
        delivery_id="running-event",
        event_type="issues",
        repo="octo/widget",
        issue_key=issue_key("octo/widget", 2),
        payload={},
        state="running",
    )

    assert db.requeue_event("done-event", from_states=("done", "failed", "skipped"))
    assert db.get_event("done-event").state == "queued"

    assert not db.requeue_event("running-event", from_states=("done", "failed", "skipped"))
    assert db.get_event("running-event").state == "running"


def test_latest_issue_events_ignore_skipped_noise(db: Database) -> None:
    fixed = issue_key("octo/widget", 1)
    still_failed = issue_key("octo/widget", 2)
    db.record_event(
        delivery_id="fixed-failed",
        event_type="issues",
        repo="octo/widget",
        issue_key=fixed,
        payload={"action": "opened"},
        state="failed",
    )
    db.record_event(
        delivery_id="fixed-done",
        event_type="issues",
        repo="octo/widget",
        issue_key=fixed,
        payload={"action": "opened"},
        state="done",
    )
    db.record_event(
        delivery_id="failed-run",
        event_type="issues",
        repo="octo/widget",
        issue_key=still_failed,
        payload={"action": "opened"},
        state="failed",
    )
    db.record_event(
        delivery_id="label-noise",
        event_type="issues",
        repo="octo/widget",
        issue_key=still_failed,
        payload={"action": "labeled"},
        state="skipped",
        last_error="issues.labeled ignored",
    )

    latest_failed = db.latest_event_for_issue(still_failed)
    latest_raw = db.latest_event_for_issue(still_failed, include_skipped=True)
    assert latest_failed is not None
    assert latest_raw is not None
    assert latest_failed.delivery_id == "failed-run"
    assert latest_raw.delivery_id == "label-noise"

    latest = db.latest_events_for_issues((fixed, still_failed))
    assert latest[fixed].delivery_id == "fixed-done"
    assert latest[still_failed].delivery_id == "failed-run"

    counts = db.latest_issue_event_state_counts()
    assert counts["done"] == 1
    assert counts["failed"] == 1
    assert counts["skipped"] == 0


def test_reset_stuck_running_recovers(db: Database) -> None:
    db.record_event(
        delivery_id="d1",
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#1",
        payload={},
    )
    row = db.claim_next_event()
    assert row is not None
    # Capture `started_at` set by the claim so we can prove the recovery flip preserves it.
    with db._lock:  # noqa: SLF001
        before = db._conn.execute(  # noqa: SLF001
            "SELECT started_at FROM events WHERE delivery_id=?", ("d1",)
        ).fetchone()
    assert before is not None
    assert before["started_at"] is not None
    # Simulate crash: row still running.
    recovered = db.reset_stuck_running()
    assert recovered == 1
    assert db.get_event("d1").state == "queued"
    with db._lock:  # noqa: SLF001
        after = db._conn.execute(  # noqa: SLF001
            "SELECT started_at FROM events WHERE delivery_id=?", ("d1",)
        ).fetchone()
    assert after is not None
    assert after["started_at"] == before["started_at"]


def test_upsert_issue_round_trip(db: Database) -> None:
    key = issue_key("octo/widget", 7)
    row = db.upsert_issue(
        key=key,
        repo="octo/widget",
        number=7,
        state="new",
    )
    assert row.state == "new"
    row = db.upsert_issue(
        key=key,
        repo="octo/widget",
        number=7,
        state="opened",
        branch="farm/abcd1234/some-issue",
        session_dir="/tmp/s",
        pr_number=42,
    )
    assert row.state == "opened"
    assert row.branch == "farm/abcd1234/some-issue"
    assert row.pr_number == 42
    fetched = db.get_issue(key)
    assert fetched and fetched.pr_number == 42

    found = db.find_issue_by_pr("octo/widget", 42)
    assert found and found.key == key
    by_branch = db.find_issue_by_branch("octo/widget", "farm/abcd1234/some-issue")
    assert by_branch and by_branch.key == key


def test_log_tool_call(db: Database) -> None:
    db.upsert_issue(key="octo/widget#1", repo="octo/widget", number=1, state="new")
    row_id = db.log_tool_call(
        issue_key="octo/widget#1",
        tool="gh_post_comment",
        args={"body": "hi"},
        result={"comment_id": 9},
    )
    assert row_id > 0


def test_pr_review_comment_staging_round_trip(db: Database) -> None:
    first = db.stage_review_comment(
        issue_key="octo/widget#9",
        path="src/app.py",
        line=12,
        side="RIGHT",
        start_line=10,
        start_side="RIGHT",
        body="blocking finding",
    )
    db.stage_review_comment(
        issue_key="octo/widget#9",
        path="src/other.py",
        line=3,
        body="nit",
    )
    db.stage_review_comment(issue_key="octo/widget#10", path="x.py", line=1, body="other")

    rows = db.list_staged_review_comments("octo/widget#9")
    assert [row.id for row in rows] == [first.id, first.id + 1]
    assert rows[0].path == "src/app.py"
    assert rows[0].start_line == 10
    assert rows[0].start_side == "RIGHT"
    assert rows[1].side == "RIGHT"

    assert db.clear_staged_review_comments("octo/widget#9") == 2
    assert db.list_staged_review_comments("octo/widget#9") == []
    assert len(db.list_staged_review_comments("octo/widget#10")) == 1


def test_processed_issue_keys_returns_only_known(db: Database) -> None:
    db.upsert_issue(key=issue_key("octo/widget", 1), repo="octo/widget", number=1, state="new")
    db.upsert_issue(key=issue_key("octo/widget", 2), repo="octo/widget", number=2, state="reproducing")
    queried = [
        issue_key("octo/widget", 1),
        issue_key("octo/widget", 2),
        issue_key("octo/widget", 3),  # never upserted
        issue_key("octo/other", 7),  # different repo, never upserted
    ]
    result = db.processed_issue_keys(queried)
    assert result == {issue_key("octo/widget", 1), issue_key("octo/widget", 2)}


def test_processed_issue_keys_empty_input(db: Database) -> None:
    assert db.processed_issue_keys([]) == set()
    # Empty strings are filtered out, not sent as a parameter.
    assert db.processed_issue_keys(["", ""]) == set()


def test_processed_issue_keys_handles_large_batch(db: Database) -> None:
    # Confirms the 500-batch chunking path (>500 parameters would otherwise hit
    # SQLite's SQLITE_MAX_VARIABLE_NUMBER default of 999 on older builds).
    keys = [issue_key("octo/widget", n) for n in range(1, 750)]
    # Persist only every 3rd one.
    for k, n in zip(keys, range(1, 750), strict=True):
        if n % 3 == 0:
            db.upsert_issue(key=k, repo="octo/widget", number=n, state="new")
    result = db.processed_issue_keys(keys + ["bogus#1"])
    expected = {issue_key("octo/widget", n) for n in range(1, 750) if n % 3 == 0}
    assert result == expected


def test_classification_roundtrip(db: Database) -> None:
    key = issue_key("octo/widget", 7)
    db.upsert_issue(key=key, repo="octo/widget", number=7, state="new")
    row = db.get_issue(key)
    assert row is not None and row.classification is None
    db.set_issue_classification(key, "question")
    row = db.get_issue(key)
    assert row is not None and row.classification == "question"
    # Round-trip via list_issues too.
    items = db.list_issues()
    assert any(r.key == key and r.classification == "question" for r in items)


def test_migration_adds_classification_to_existing_db(tmp_path: Path) -> None:
    """Open a DB without the classification column and verify the migration."""
    import sqlite3

    path = tmp_path / "legacy.sqlite"
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE events (delivery_id TEXT PRIMARY KEY, event_type TEXT, payload_json TEXT,
          received_at TEXT, state TEXT CHECK(state IN ('queued','running','done','failed','skipped')),
          attempts INTEGER DEFAULT 0, last_error TEXT, repo TEXT, issue_key TEXT,
          started_at TEXT, finished_at TEXT);
        CREATE TABLE issues (key TEXT PRIMARY KEY, repo TEXT, number INTEGER, branch TEXT,
          session_dir TEXT, pr_number INTEGER, state TEXT, updated_at TEXT);
        CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_key TEXT,
          tool TEXT, args_json TEXT, result_json TEXT, error TEXT, ts TEXT);
        INSERT INTO issues VALUES ('octo/widget#1', 'octo/widget', 1, 'farm/x', '/tmp/s', NULL,
          'reproducing', '2026-01-01T00:00:00Z');
        """
    )
    conn.commit()
    conn.close()
    # Opening through our Database class should auto-migrate.
    database = Database(path)
    row = database.get_issue("octo/widget#1")
    assert row is not None
    assert row.classification is None  # column exists, default NULL
    database.set_issue_classification("octo/widget#1", "bug")
    assert database.get_issue("octo/widget#1").classification == "bug"
    database.close()


def test_set_event_model_persists_on_running_event(db: Database) -> None:
    """`set_event_model` writes the picked model so the dashboard can attribute behavior."""
    db.record_event(
        delivery_id="d-model",
        event_type="issues",
        repo="octo/widget",
        issue_key=issue_key("octo/widget", 42),
        payload={"action": "opened"},
    )
    row = db.claim_next_event()
    assert row is not None and row.delivery_id == "d-model"
    db.set_event_model("d-model", "claude-sonnet-4-5")
    running = db.list_running_events()
    assert len(running) == 1
    assert running[0]["model"] == "claude-sonnet-4-5"
    # Setting a different model later (e.g. retry) overwrites in place.
    db.set_event_model("d-model", "claude-opus-4-5")
    running = db.list_running_events()
    assert running[0]["model"] == "claude-opus-4-5"


def test_list_running_events_surfaces_last_tool_since_start(db: Database) -> None:
    """`list_running_events` joins the most recent tool_call newer than `started_at`.

    Tool calls logged before the current run (e.g. an earlier triage on the same
    issue) MUST NOT be reported as the current activity.
    """
    key = issue_key("octo/widget", 7)
    db.upsert_issue(key=key, repo="octo/widget", number=7, state="reproducing")
    # Stale tool call from a previous run (no started_at yet).
    db.log_tool_call(issue_key=key, tool="stale_tool", args={})
    db.record_event(
        delivery_id="d-7",
        event_type="issues",
        repo="octo/widget",
        issue_key=key,
        payload={"action": "opened"},
    )
    db.claim_next_event()  # sets started_at
    # Before any current-run tool call: last_tool must be NULL, not "stale_tool".
    running = db.list_running_events()
    assert len(running) == 1
    assert running[0]["last_tool"] is None
    assert running[0]["last_tool_ts"] is None
    # New tool call after start → surfaces in the snapshot.
    db.log_tool_call(issue_key=key, tool="gh_post_comment", args={"body": "hi"})
    db.log_tool_call(issue_key=key, tool="set_issue_labels", args={"labels": ["bug"]})
    running = db.list_running_events()
    assert running[0]["last_tool"] == "set_issue_labels"  # latest by ts
    assert running[0]["last_tool_ts"] is not None


def test_record_submission_dedupes_by_delivery(db: Database) -> None:
    assert db.record_submission(delivery_id="d-1", login="Alice", repo="octo/widget")
    # Retry of the same delivery id is a no-op (idempotent webhook delivery).
    assert not db.record_submission(delivery_id="d-1", login="alice", repo="octo/widget")


def test_admit_submission_dedupes_by_delivery_before_rate_limit(db: Database) -> None:
    since = iso_seconds_ago(60)
    first = db.admit_submission(
        delivery_id="d-1",
        login="Alice",
        repo="octo/widget",
        since=since,
        cap=1,
    )
    assert first.accepted
    assert not first.duplicate
    assert first.used == 1

    duplicate = db.admit_submission(
        delivery_id="d-1",
        login="alice",
        repo="octo/widget",
        since=since,
        cap=1,
    )
    assert duplicate.accepted
    assert duplicate.duplicate
    assert duplicate.used == 1

    rejected = db.admit_submission(
        delivery_id="d-2",
        login="ALICE",
        repo="octo/widget",
        since=since,
        cap=1,
    )
    assert not rejected.accepted
    assert not rejected.duplicate
    assert rejected.used == 1
    assert db.count_submissions_since("alice", since) == 1


def test_admit_submission_enforces_cap_atomically_across_connections(tmp_path: Path) -> None:
    path = tmp_path / "admission.sqlite"
    # Pre-warm: open + migrate the schema once so the two racing threads below
    # collide only on `admit_submission` (which is what the test is exercising),
    # not on `Database.__init__`. `executescript(SCHEMA)` flips journal_mode to
    # WAL, which needs a brief exclusive lock — without pre-warming, one
    # thread can lose that race and never reach `barrier.wait()`, deadlocking
    # its peer at the barrier (no timeout) and hanging `future.result()`.
    Database(path).close()
    barrier = threading.Barrier(2, timeout=10)

    def admit(delivery_id: str) -> bool:
        database = Database(path)
        try:
            barrier.wait()
            return database.admit_submission(
                delivery_id=delivery_id,
                login="alice",
                repo="octo/widget",
                since=iso_seconds_ago(60),
                cap=1,
            ).accepted
        finally:
            database.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(admit, f"d-{i}") for i in range(2)]
        accepted = [future.result(timeout=15) for future in futures]

    verifier = Database(path)
    try:
        assert sorted(accepted) == [False, True]
        assert verifier.count_submissions_since("alice", iso_seconds_ago(60)) == 1
    finally:
        verifier.close()


def test_count_submissions_since_is_case_insensitive(db: Database) -> None:
    db.record_submission(delivery_id="d-1", login="Alice", repo="octo/widget")
    db.record_submission(delivery_id="d-2", login="ALICE", repo="octo/widget")
    db.record_submission(delivery_id="d-3", login="bob", repo="octo/widget")
    # Window covering the whole test run.
    since = iso_seconds_ago(60)
    assert db.count_submissions_since("alice", since) == 2
    assert db.count_submissions_since("ALICE", since) == 2
    assert db.count_submissions_since("bob", since) == 1
    assert db.count_submissions_since("nobody", since) == 0


def test_count_submissions_since_respects_window(db: Database) -> None:
    db.record_submission(delivery_id="d-1", login="alice", repo="octo/widget")
    # Future cutoff means the just-inserted row is *before* the window.
    future = iso_seconds_ago(-60)
    assert db.count_submissions_since("alice", future) == 0


# -------- pending_closures ---------------------------------------------


_KEY = issue_key("octo/widget", 42)


def _seed_pending(db: Database, *, close_at: str = "2026-05-15T00:00:00.000000Z") -> None:
    db.upsert_pending_closure(
        issue_key=_KEY,
        repo="octo/widget",
        number=42,
        comment_id=999,
        issue_author="Alice",
        close_at=close_at,
    )


def test_upsert_pending_closure_lowercases_author_and_starts_pending(db: Database) -> None:
    _seed_pending(db)
    row = db.get_pending_closure(_KEY)
    assert row is not None
    assert row.state == "pending"
    assert row.cancel_reason is None
    assert row.issue_author == "alice"  # author stored lower-cased for cheap eq
    assert row.comment_id == 999


def test_upsert_pending_closure_overwrites_prior_schedule(db: Database) -> None:
    _seed_pending(db)
    db.finalize_closure(_KEY, state="cancelled", reason="user_replied")
    # A follow-up bot answer should reset the row to pending and update fields.
    db.upsert_pending_closure(
        issue_key=_KEY,
        repo="octo/widget",
        number=42,
        comment_id=1234,
        issue_author="alice",
        close_at="2030-01-01T00:00:00.000000Z",
    )
    row = db.get_pending_closure(_KEY)
    assert row is not None
    assert row.state == "pending"
    assert row.cancel_reason is None
    assert row.comment_id == 1234
    assert row.close_at == "2030-01-01T00:00:00.000000Z"


def test_claim_due_closures_only_returns_due_pending(db: Database) -> None:
    _seed_pending(db, close_at="2000-01-01T00:00:00.000000Z")  # past
    db.upsert_pending_closure(
        issue_key=issue_key("octo/widget", 7),
        repo="octo/widget",
        number=7,
        comment_id=10,
        issue_author="bob",
        close_at="2999-01-01T00:00:00.000000Z",  # future
    )
    claimed = db.claim_due_closures(now="2026-05-15T00:00:00.000000Z")
    assert [r.issue_key for r in claimed] == [_KEY]
    assert all(r.state == "claimed" for r in claimed)
    # And re-claiming returns nothing because the first one is no longer pending.
    again = db.claim_due_closures(now="2026-05-15T00:00:00.000000Z")
    assert again == []


def test_claim_due_closures_atomic_under_contention(db: Database) -> None:
    """Two concurrent claims see disjoint rows."""
    for n in range(5):
        db.upsert_pending_closure(
            issue_key=issue_key("octo/widget", n),
            repo="octo/widget",
            number=n,
            comment_id=100 + n,
            issue_author="alice",
            close_at="2000-01-01T00:00:00.000000Z",
        )
    seen: list[str] = []
    lock = threading.Lock()

    def claim_some() -> None:
        rows = db.claim_due_closures(now="2026-05-15T00:00:00.000000Z", limit=2)
        with lock:
            seen.extend(r.issue_key for r in rows)

    with ThreadPoolExecutor(max_workers=4) as pool:
        for _ in range(4):
            list(pool.map(lambda _: claim_some(), range(4)))
    # Each row must appear at most once across all claims.
    assert sorted(seen) == sorted({issue_key("octo/widget", n) for n in range(5)})


def test_cancel_pending_closure_only_fires_when_pending(db: Database) -> None:
    _seed_pending(db)
    assert db.cancel_pending_closure(_KEY, reason="user_replied")
    row = db.get_pending_closure(_KEY)
    assert row is not None
    assert row.state == "cancelled"
    assert row.cancel_reason == "user_replied"
    # A second cancel against an already-cancelled row is a no-op.
    assert not db.cancel_pending_closure(_KEY, reason="user_replied")


def test_cancel_pending_closure_skips_claimed_rows(db: Database) -> None:
    """A `claimed` row must be left for the scheduler tick that owns it."""
    _seed_pending(db, close_at="2000-01-01T00:00:00.000000Z")
    claimed = db.claim_due_closures(now="2026-05-15T00:00:00.000000Z")
    assert claimed and claimed[0].state == "claimed"
    assert not db.cancel_pending_closure(_KEY, reason="user_replied")
    row = db.get_pending_closure(_KEY)
    assert row is not None and row.state == "claimed"


def test_finalize_closure_rejects_non_terminal_state(db: Database) -> None:
    _seed_pending(db)
    import pytest

    with pytest.raises(ValueError):
        db.finalize_closure(_KEY, state="pending", reason=None)  # type: ignore[arg-type]


def test_requeue_claimed_closure_only_flips_claimed(db: Database) -> None:
    _seed_pending(db, close_at="2000-01-01T00:00:00.000000Z")
    db.claim_due_closures(now="2026-05-15T00:00:00.000000Z")
    assert db.requeue_claimed_closure(_KEY)
    row = db.get_pending_closure(_KEY)
    assert row is not None and row.state == "pending"
    # Now in pending state, requeue is a no-op.
    assert not db.requeue_claimed_closure(_KEY)


def test_release_lifecycle_and_active_selection(db: Database) -> None:
    first = db.upsert_release(
        repo="octo/widget",
        tag="v1.2.3",
        version="1.2.3",
        current_sha="sha-1",
        session_dir="/sessions/v1.2.3",
    )
    assert first.state == "awaiting_ci"
    assert db.get_active_release("octo/widget") == first

    fixing = db.bump_release_round(first.key, failed_sha="sha-1")
    assert fixing.rounds == 1
    assert fixing.state == "fixing"
    assert fixing.last_failed_sha == "sha-1"

    db.set_release_sha(first.key, "sha-2")
    db.set_release_state(first.key, "awaiting_ci")
    updated = db.get_release(first.key)
    assert updated is not None
    assert updated.current_sha == "sha-2"
    assert updated.last_error is None

    second = db.upsert_release(
        repo="octo/widget",
        tag="v1.2.4",
        version="1.2.4",
        current_sha="sha-3",
        session_dir="/sessions/v1.2.4",
    )
    assert db.get_active_release("octo/widget") == second
    db.set_release_state(second.key, "superseded")
    active = db.get_active_release("octo/widget")
    assert active is not None and active.key == first.key
    db.set_release_state(first.key, "green")
    assert db.get_active_release("octo/widget") is None
    assert {row.state for row in db.list_releases()} == {"green", "superseded"}
