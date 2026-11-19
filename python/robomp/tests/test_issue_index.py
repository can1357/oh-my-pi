"""Local issue index: query parsing, webhook ingest, FTS search, reconcile sync."""

from __future__ import annotations

from pathlib import Path

from robomp.db import Database
from robomp.github_client import IssueIndexEntry
from robomp.issue_index import IssueIndexSync, ingest_webhook_payload, parse_search_query


def _entry(number: int, **overrides) -> IssueIndexEntry:
    base = {
        "repo": "octo/widget",
        "number": number,
        "is_pull_request": False,
        "title": f"issue {number}",
        "body": "",
        "state": "open",
        "state_reason": "",
        "merged_at": "",
        "author": "alice",
        "labels": (),
        "comments": 0,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "html_url": f"https://example/{number}",
    }
    base.update(overrides)
    return IssueIndexEntry(**base)


# ---- parse_search_query ----


def test_parse_search_query_extracts_supported_qualifiers() -> None:
    parsed = parse_search_query("colon selector is:pr is:merged label:bug author:@alice in:title")
    assert parsed.keywords == ("colon", "selector")  # `in:title` dropped, not fed to FTS
    assert parsed.is_pr is True
    assert parsed.merged is True
    assert parsed.label == "bug"
    assert parsed.author == "alice"


def test_parse_search_query_state_and_issue_kind() -> None:
    parsed = parse_search_query("is:issue is:closed crash")
    assert parsed.is_pr is False
    assert parsed.state == "closed"
    assert parsed.keywords == ("crash",)


# ---- db index: upsert + search ----


def test_search_issue_index_matches_body_text_and_ranks(db: Database) -> None:
    db.upsert_issue_index(_entry(1, title="TUI crash on resize", body="stack trace mentions overlay"))
    db.upsert_issue_index(_entry(2, title="unrelated docs typo", body="readme wording"))
    found = db.search_issue_index("octo/widget", keywords=("resize", "crash"))
    assert [e.number for e in found] == [1]
    # body-only terms also hit
    found = db.search_issue_index("octo/widget", keywords=("overlay",))
    assert [e.number for e in found] == [1]


def test_search_issue_index_filters(db: Database) -> None:
    db.upsert_issue_index(
        _entry(1, title="fix crash", is_pull_request=True, merged_at="2026-02-01T00:00:00Z", state="closed")
    )
    db.upsert_issue_index(
        _entry(2, title="crash report", state="closed", state_reason="not_planned", labels=("wontfix",))
    )
    db.upsert_issue_index(_entry(3, title="crash report open", state="open"))

    merged_prs = db.search_issue_index("octo/widget", keywords=("crash",), is_pr=True, merged=True)
    assert [e.number for e in merged_prs] == [1]
    wontfixed = db.search_issue_index("octo/widget", keywords=("crash",), label="wontfix")
    assert [e.number for e in wontfixed] == [2]
    open_only = db.search_issue_index("octo/widget", keywords=("crash",), state="open")
    assert [e.number for e in open_only] == [3]


def test_upsert_refreshes_fts_so_stale_text_stops_matching(db: Database) -> None:
    """The UPDATE trigger must swap FTS content, not accumulate it."""
    db.upsert_issue_index(_entry(1, title="original scrollback wipe"))
    db.upsert_issue_index(_entry(1, title="renamed: alternate screen request", state="closed"))
    assert db.search_issue_index("octo/widget", keywords=("scrollback",)) == []
    found = db.search_issue_index("octo/widget", keywords=("alternate",))
    assert len(found) == 1 and found[0].state == "closed"


def test_search_issue_index_quotes_fts_metacharacters(db: Database) -> None:
    """Reporter text like `"AND (` must never raise an FTS5 syntax error."""
    db.upsert_issue_index(_entry(1, title='crash with "quoted" AND (parens)'))
    found = db.search_issue_index("octo/widget", keywords=('"quoted"', "AND", "(parens)"))
    assert [e.number for e in found] == [1]


def test_issue_index_watermark_roundtrip(db: Database) -> None:
    assert db.issue_index_watermark("octo/widget") is None
    db.set_issue_index_watermark("octo/widget", "2026-07-01T00:00:00Z")
    assert db.issue_index_watermark("octo/widget") == "2026-07-01T00:00:00Z"
    db.set_issue_index_watermark("octo/widget", "2026-07-02T00:00:00Z")
    assert db.issue_index_watermark("octo/widget") == "2026-07-02T00:00:00Z"


# ---- webhook ingest ----


def test_ingest_webhook_issue_and_pr_payloads(db: Database) -> None:
    ingested = ingest_webhook_payload(
        db,
        "octo/widget",
        "issues",
        {"issue": {"number": 5, "title": "boom", "body": "b", "state": "open", "user": {"login": "alice"}}},
    )
    assert ingested
    # PR-flavored issue payload (issue_comment on a PR) carries pull_request.merged_at.
    ingest_webhook_payload(
        db,
        "octo/widget",
        "issue_comment",
        {
            "issue": {
                "number": 6,
                "title": "fixes boom",
                "state": "closed",
                "user": {"login": "bob"},
                "pull_request": {"merged_at": "2026-03-01T00:00:00Z"},
            }
        },
    )
    # Native pull_request payload: merged_at at top level.
    ingest_webhook_payload(
        db,
        "octo/widget",
        "pull_request",
        {"pull_request": {"number": 7, "title": "another fix", "state": "closed", "merged_at": "2026-04-01T00:00:00Z"}},
    )
    assert not ingest_webhook_payload(db, "octo/widget", "push", {"ref": "refs/heads/main"})

    boom = db.search_issue_index("octo/widget", keywords=("boom",))
    assert {e.number for e in boom} == {5, 6}
    pr6 = next(e for e in boom if e.number == 6)
    assert pr6.is_pull_request and pr6.merged_at == "2026-03-01T00:00:00Z"
    pr7 = db.search_issue_index("octo/widget", keywords=("another",))[0]
    assert pr7.is_pull_request and pr7.merged_at == "2026-04-01T00:00:00Z"


# ---- reconcile sync ----


class _FakeBackend:
    """Pages of index entries keyed by page number; records `since` per call."""

    def __init__(self, pages: dict[int, list[IssueIndexEntry]]) -> None:
        self.pages = pages
        self.calls: list[tuple[str | None, int]] = []

    async def list_issue_index_entries(
        self, repo: str, *, since: str | None = None, page: int = 1, per_page: int = 100
    ) -> list[IssueIndexEntry]:
        self.calls.append((since, page))
        return self.pages.get(page, [])


class _SyncSettings:
    issue_index_sync_seconds = 900.0
    repo_allowlist = frozenset({"octo/widget"})


async def test_sync_repo_backfills_pages_and_sets_watermark(db: Database, tmp_path: Path) -> None:
    full_page = [_entry(n, updated_at=f"2026-06-{n:02d}T00:00:00Z") for n in range(1, 101)]
    short_page = [_entry(101, updated_at="2026-07-01T00:00:00Z")]
    backend = _FakeBackend({1: full_page, 2: short_page})
    sync = IssueIndexSync(settings=_SyncSettings(), db=db, github=backend)  # type: ignore[arg-type]

    ingested = await sync.sync_repo("octo/widget")
    assert ingested == 101
    # First run is a backfill: no `since` on any call, pages walked in order.
    assert backend.calls == [(None, 1), (None, 2)]
    watermark = db.issue_index_watermark("octo/widget")
    assert watermark is not None
    assert db.search_issue_index("octo/widget", keywords=("issue",), limit=5)

    # Second run is incremental: `since` derives from the stored watermark.
    backend.calls.clear()
    backend.pages = {1: []}
    await sync.sync_repo("octo/widget")
    assert backend.calls and backend.calls[0][0] is not None
