"""Background scheduler that closes question issues after a quiet window.

Driven entirely by rows in `pending_closures`:
  - `_build_post_comment` inserts a row when the bot answers a `question` issue.
  - The webhook handler cancels the row when the original author replies, the
    issue is closed externally, or any other event signals the human is still
    engaged.
  - This loop atomically claims due rows, checks for a 👎 from the issue's
    original author on the watched comment, and either cancels (author voted
    down) or closes the issue with `state_reason=completed`.

The loop is the only writer of terminal `closed`/`cancelled` states for rows
it has claimed, so the cancellation hook + the scheduler never race on the
same row.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from robomp.config import Settings
from robomp.db import Database, PendingClosureRow
from robomp.github_backend import GitHubBackend
from robomp.github_client import GitHubError

log = logging.getLogger(__name__)


def _utcnow_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class AutocloseScheduler:
    """Long-lived coroutine that closes due `pending_closures` rows.

    Design choices:
      - One DB claim per tick (atomic `pending -> claimed`) prevents two
        ticks from acting on the same row, even if a previous tick was
        interrupted.
      - GitHub calls happen sequentially per tick. Auto-close volume is bounded
        by question-issue volume; concurrency would buy nothing here.
      - A failed close requeues the row to `pending` so the next tick retries.
      - 404 on close (issue already gone) finalizes as `cancelled` with reason
        `already_closed` rather than retrying forever.
    """

    def __init__(
        self,
        *,
        settings: Settings,
        db: Database,
        github: GitHubBackend,
    ) -> None:
        self._settings = settings
        self._db = db
        self._github = github
        self._task: asyncio.Task[None] | None = None
        self._stop_event: asyncio.Event | None = None

    @property
    def enabled(self) -> bool:
        return (
            self._settings.question_autoclose_enabled
            and self._settings.question_autoclose_hours > 0
            and self._settings.question_autoclose_scan_seconds > 0
        )

    async def start(self) -> None:
        """Spawn the background loop. No-op when the feature is disabled."""
        if not self.enabled:
            log.info(
                "autoclose disabled",
                extra={
                    "enabled": self._settings.question_autoclose_enabled,
                    "hours": self._settings.question_autoclose_hours,
                },
            )
            return
        if self._task is not None:
            return
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="autoclose-scheduler")
        log.info(
            "autoclose started",
            extra={
                "scan_seconds": self._settings.question_autoclose_scan_seconds,
                "hours": self._settings.question_autoclose_hours,
            },
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
        scan_seconds = float(self._settings.question_autoclose_scan_seconds)
        while not self._stop_event.is_set():
            try:
                await self.tick()
            except Exception:
                log.exception("autoclose tick failed")
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=scan_seconds)
            except TimeoutError:
                continue

    async def tick(self) -> dict[str, int]:
        """Process all due rows. Exposed for tests.

        Returns a counter dict (`closed`, `cancelled`, `retried`) summarizing
        what happened on this tick.
        """
        rows = self._db.claim_due_closures(now=_utcnow_iso())
        counts = {"closed": 0, "cancelled": 0, "retried": 0}
        for row in rows:
            outcome = await self._process_row(row)
            counts[outcome] = counts.get(outcome, 0) + 1
        if rows:
            log.info(
                "autoclose tick",
                extra={
                    "closed": counts["closed"],
                    "cancelled": counts["cancelled"],
                    "retried": counts["retried"],
                    "total": len(rows),
                },
            )
        return counts

    async def _process_row(self, row: PendingClosureRow) -> str:
        """Resolve a single claimed row. Returns `closed`/`cancelled`/`retried`."""
        try:
            reactions = await self._github.list_comment_reactions(row.repo, row.comment_id)
        except GitHubError as exc:
            log.warning(
                "autoclose: list_comment_reactions failed; will retry",
                extra={"issue_key": row.issue_key, "status": exc.status, "gh_message": exc.message},
            )
            self._db.requeue_claimed_closure(row.issue_key)
            return "retried"

        author = row.issue_author.lower()
        author_downvoted = any(r.content == "-1" and r.user_login.lower() == author for r in reactions)
        if author_downvoted:
            self._db.finalize_closure(row.issue_key, state="cancelled", reason="author_downvoted")
            log.info(
                "autoclose cancelled by author 👎",
                extra={"issue_key": row.issue_key, "comment_id": row.comment_id},
            )
            return "cancelled"

        try:
            await self._github.close_issue(row.repo, row.number, reason="completed")
        except GitHubError as exc:
            if exc.status == 404:
                self._db.finalize_closure(row.issue_key, state="cancelled", reason="already_closed")
                log.info(
                    "autoclose: issue already gone",
                    extra={"issue_key": row.issue_key},
                )
                return "cancelled"
            log.warning(
                "autoclose: close_issue failed; will retry",
                extra={"issue_key": row.issue_key, "status": exc.status, "gh_message": exc.message},
            )
            self._db.requeue_claimed_closure(row.issue_key)
            return "retried"

        self._db.finalize_closure(row.issue_key, state="closed", reason=None)
        log.info(
            "autoclose closed issue",
            extra={"issue_key": row.issue_key, "number": row.number},
        )
        return "closed"


__all__ = ["AutocloseScheduler"]
