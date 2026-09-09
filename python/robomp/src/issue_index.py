"""Local issue/PR search index: webhook ingest, periodic reconcile, query parsing.

The `issue_index` table mirrors every issue and PR of the allowlisted repos so
`gh_search_issues` answers from SQLite FTS5 instead of the GitHub search API.
Freshness comes from two directions:

  - `ingest_webhook_payload` upserts on every `issues` / `issue_comment` /
    `pull_request*` delivery, keeping the hot path current in real time.
  - `IssueIndexSync` reconciles each repo every `issue_index_sync_seconds`
    (and backfills on first run) via `/repos/{repo}/issues?since=…`, catching
    anything webhooks missed while the orchestrator was down.

`parse_search_query` translates the GitHub-search-flavored tool query into the
structured filters `Database.search_issue_index` takes, so the agent keeps one
query language whether the lookup is served locally or remotely.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from robomp.config import Settings
from robomp.db import Database
from robomp.github_backend import GitHubBackend
from robomp.github_client import (
    GitHubError,
    index_entry_from_issue_object,
    index_entry_from_pr_object,
)

log = logging.getLogger(__name__)

# Overlap subtracted from the watermark on every reconcile so a sync that
# raced a concurrent update can never permanently skip it.
_SYNC_OVERLAP = timedelta(minutes=2)
_PAGE_SIZE = 100
_MAX_PAGES_PER_TICK = 30


@dataclass(slots=True, frozen=True)
class ParsedSearchQuery:
    """Structured form of a GitHub-issue-search style query string."""

    keywords: tuple[str, ...]
    is_pr: bool | None = None
    state: str | None = None
    merged: bool | None = None
    label: str | None = None
    author: str | None = None


def parse_search_query(query: str) -> ParsedSearchQuery:
    """Split a GitHub-search style string into keywords + structured filters.

    Supported qualifiers: `is:pr` / `is:issue` / `is:open` / `is:closed` /
    `is:merged`, `label:<name>`, `author:<login>`. Unrecognized `key:value`
    qualifiers are dropped rather than fed to FTS5 (a bare `in:title` token
    would otherwise be a syntax error). Everything else is a keyword.
    """
    keywords: list[str] = []
    is_pr: bool | None = None
    state: str | None = None
    merged: bool | None = None
    label: str | None = None
    author: str | None = None
    for token in query.split():
        key, sep, value = token.partition(":")
        if not sep or not value or " " in key:
            keywords.append(token)
            continue
        key = key.lower()
        if key == "is":
            v = value.lower()
            if v == "pr":
                is_pr = True
            elif v == "issue":
                is_pr = False
            elif v in ("open", "closed"):
                state = v
            elif v == "merged":
                is_pr = True
                merged = True
        elif key == "label":
            label = value.strip('"')
        elif key == "author":
            author = value.lstrip("@")
        # Any other qualifier (in:, sort:, created:, …) is intentionally dropped.
    return ParsedSearchQuery(
        keywords=tuple(keywords),
        is_pr=is_pr,
        state=state,
        merged=merged,
        label=label,
        author=author,
    )


def ingest_webhook_payload(db: Database, repo: str, event_type: str, payload: Mapping[str, object]) -> bool:
    """Upsert the issue/PR carried by a webhook delivery into the index.

    Returns True when the payload contained an indexable object. Runs before
    routing so even deliveries the router skips (bot comments, unhandled
    actions) still refresh the index.
    """
    if event_type in ("issues", "issue_comment"):
        obj = payload.get("issue")
        if isinstance(obj, Mapping) and obj.get("number") is not None:
            db.upsert_issue_index(index_entry_from_issue_object(repo, obj))
            return True
        return False
    if event_type.startswith("pull_request"):
        obj = payload.get("pull_request")
        if isinstance(obj, Mapping) and obj.get("number") is not None:
            db.upsert_issue_index(index_entry_from_pr_object(repo, obj))
            return True
        return False
    return False


def _utcnow_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _overlapped(watermark: str) -> str:
    """Rewind an ISO watermark by the sync overlap; fall back to the raw value."""
    try:
        parsed = datetime.strptime(watermark, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except ValueError:
        return watermark
    return (parsed - _SYNC_OVERLAP).strftime("%Y-%m-%dT%H:%M:%SZ")


class IssueIndexSync:
    """Background reconciler for the local issue index.

    First tick per repo backfills everything (`since=None`); later ticks pull
    only issues updated after the stored watermark (minus a small overlap).
    Pagination is bounded per tick — a huge backlog finishes across ticks
    rather than hogging one.
    """

    def __init__(self, *, settings: Settings, db: Database, github: GitHubBackend) -> None:
        self._settings = settings
        self._db = db
        self._github = github
        self._task: asyncio.Task[None] | None = None
        self._stop_event: asyncio.Event | None = None

    @property
    def enabled(self) -> bool:
        return self._settings.issue_index_sync_seconds > 0

    async def start(self) -> None:
        """Spawn the background loop. No-op when disabled."""
        if not self.enabled:
            log.info("issue index sync disabled")
            return
        if self._task is not None:
            return
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="issue-index-sync")
        log.info(
            "issue index sync started",
            extra={"interval_seconds": self._settings.issue_index_sync_seconds},
        )

    async def stop(self) -> None:
        """Signal the loop to exit and await its termination."""
        if self._task is None:
            return
        assert self._stop_event is not None
        self._stop_event.set()
        try:
            await asyncio.wait_for(self._task, timeout=5.0)
        except TimeoutError:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        finally:
            self._task = None
            self._stop_event = None

    async def _run(self) -> None:
        assert self._stop_event is not None
        interval = float(self._settings.issue_index_sync_seconds)
        while not self._stop_event.is_set():
            try:
                await self.tick()
            except Exception:
                log.exception("issue index sync tick failed")
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=interval)
            except TimeoutError:
                continue

    async def tick(self) -> None:
        """Reconcile every allowlisted repo once."""
        for repo in self._settings.repo_allowlist:
            try:
                await self.sync_repo(repo)
            except GitHubError as exc:
                log.warning(
                    "issue index sync failed; will retry next tick",
                    extra={"repo": repo, "status": exc.status, "gh_message": exc.message},
                )

    async def sync_repo(self, repo: str) -> int:
        """Pull updated issues/PRs for one repo into the index. Returns count ingested."""
        started_at = _utcnow_iso()
        watermark = self._db.issue_index_watermark(repo)
        since = _overlapped(watermark) if watermark else None
        ingested = 0
        exhausted = False
        last_seen = ""
        for page in range(1, _MAX_PAGES_PER_TICK + 1):
            batch = await self._github.list_issue_index_entries(repo, since=since, page=page, per_page=_PAGE_SIZE)
            for entry in batch:
                self._db.upsert_issue_index(entry)
                if entry.updated_at > last_seen:
                    last_seen = entry.updated_at
            ingested += len(batch)
            if len(batch) < _PAGE_SIZE:
                exhausted = True
                break
        if exhausted:
            # Everything up to tick start is ingested; later updates are the
            # next tick's problem (or a webhook's).
            self._db.set_issue_index_watermark(repo, started_at)
        elif last_seen:
            # Page budget hit mid-backfill: advance the watermark only to the
            # newest updated_at actually ingested, so the next tick resumes there.
            self._db.set_issue_index_watermark(repo, last_seen)
        log.info(
            "issue index synced",
            extra={"repo": repo, "ingested": ingested, "backfill": watermark is None, "complete": exhausted},
        )
        return ingested


__all__ = [
    "IssueIndexSync",
    "ParsedSearchQuery",
    "ingest_webhook_payload",
    "parse_search_query",
]
