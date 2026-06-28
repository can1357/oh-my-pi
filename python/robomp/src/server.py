"""FastAPI receiver for GitHub webhooks."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from fastapi import Body, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from robomp import github_events
from robomp.autoclose import AutocloseScheduler
from robomp.config import Settings, get_settings
from robomp.dashboard import render_index, static_dir, tail_jsonl
from robomp.db import (
    INACTIVE_EVENT_STATES,
    Database,
    get_database,
    iso_seconds_ago,
)
from robomp.db import (
    issue_key as make_issue_key,
)
from robomp.github_backend import GitHubBackend
from robomp.github_client import GitHubError, IssueSummary
from robomp.manual_triage import (
    InvalidIssueRef,
    ManualTriageConflict,
    ManualTriageError,
    enqueue_manual_triage,
    parse_issue_ref,
)
from robomp.natives_cache import NativesCache
from robomp.proxy_client import GitHubProxyClient, ProxyGitTransport
from robomp.queue import WorkerPool
from robomp.sandbox import SandboxManager

log = logging.getLogger(__name__)


@dataclass(slots=True)
class _IssueBrowseCacheEntry:
    repos: tuple[str, ...]
    issues: list[IssueSummary]
    errors: list[dict[str, str]]
    fetched_at: float


class _IssueBrowseCache:
    """In-process cache for the dashboard's GitHub issue browser.

    The browse panel is a convenience picker. It should not hit GitHub's
    `/issues` endpoint on every browser reload because that endpoint returns PRs
    mixed into the issue list. Webhooks keep warmed entries fresh; the dashboard
    Refresh button can still force a live pull when an operator wants one.
    """

    def __init__(self) -> None:
        self._entries: dict[tuple[str, int, tuple[str, ...]], _IssueBrowseCacheEntry] = {}
        self._lock = asyncio.Lock()

    async def get_or_fetch(
        self,
        *,
        state: str,
        limit: int,
        repos: tuple[str, ...],
        force: bool,
        fetch: Callable[[], Awaitable[tuple[list[IssueSummary], list[dict[str, str]]]]],
    ) -> tuple[_IssueBrowseCacheEntry, bool]:
        key = (state, limit, repos)
        async with self._lock:
            if not force and (entry := self._entries.get(key)) is not None:
                return entry, True

        issues, errors = await fetch()
        issues.sort(key=lambda s: s.updated_at, reverse=True)
        entry = _IssueBrowseCacheEntry(
            repos=repos,
            issues=issues[:limit],
            errors=errors,
            fetched_at=time.time(),
        )
        async with self._lock:
            if not force and (current := self._entries.get(key)) is not None:
                return current, True
            self._entries[key] = entry
            return entry, False

    async def apply_webhook(
        self,
        *,
        event_type: str,
        payload: Mapping[str, Any],
        allowlist: frozenset[str],
    ) -> None:
        mutation = _issue_cache_mutation(event_type, payload, allowlist)
        if mutation is None:
            return
        repo, number, summary = mutation
        async with self._lock:
            for (state, limit, repos), entry in self._entries.items():
                if repo not in repos:
                    continue
                entry.issues = [item for item in entry.issues if not (item.repo == repo and item.number == number)]
                if summary is not None and _cache_state_includes(state, summary.state):
                    entry.issues.append(summary)
                    entry.issues.sort(key=lambda s: s.updated_at, reverse=True)
                    del entry.issues[limit:]


def _cache_state_includes(cache_state: str, issue_state: str) -> bool:
    return cache_state == "all" or issue_state == cache_state


def _repo_full_name(payload: Mapping[str, Any]) -> str | None:
    repo = payload.get("repository")
    if isinstance(repo, Mapping):
        full_name = repo.get("full_name")
        if isinstance(full_name, str) and full_name:
            return full_name
    return None


def _label_names(raw: Any) -> tuple[str, ...]:
    if not isinstance(raw, (list, tuple)):
        return ()
    return tuple(str(label.get("name") or "") if isinstance(label, Mapping) else str(label) for label in raw)


def _issue_summary_from_payload(repo: str, issue: Mapping[str, Any]) -> IssueSummary | None:
    number = issue.get("number")
    if not isinstance(number, int):
        return None
    user = issue.get("user")
    state = str(issue.get("state") or "open").lower()
    if state not in {"open", "closed"}:
        state = "open"
    comments = issue.get("comments")
    if not isinstance(comments, int):
        comments = 0
    return IssueSummary(
        repo=repo,
        number=number,
        title=str(issue.get("title") or ""),
        state=state,
        author=str(user.get("login") or "") if isinstance(user, Mapping) else "",
        labels=_label_names(issue.get("labels")),
        comments=comments,
        updated_at=str(issue.get("updated_at") or issue.get("created_at") or ""),
        created_at=str(issue.get("created_at") or ""),
        html_url=str(issue.get("html_url") or f"https://github.com/{repo}/issues/{number}"),
    )


def _issue_cache_mutation(
    event_type: str,
    payload: Mapping[str, Any],
    allowlist: frozenset[str],
) -> tuple[str, int, IssueSummary | None] | None:
    if event_type not in {"issues", "issue_comment"}:
        return None
    repo = _repo_full_name(payload)
    if repo is None or repo.lower() not in allowlist:
        return None
    issue = payload.get("issue")
    if not isinstance(issue, Mapping):
        return None
    number = issue.get("number")
    if not isinstance(number, int):
        return None
    if "pull_request" in issue:
        return repo, number, None
    if str(payload.get("action") or "") == "deleted":
        return repo, number, None
    summary = _issue_summary_from_payload(repo, issue)
    if summary is None:
        return None
    return repo, number, summary


def _issue_browse_payload(
    *,
    entry: _IssueBrowseCacheEntry,
    cache_hit: bool,
    processed_keys: frozenset[str],
) -> dict[str, Any]:
    return {
        "issues": [
            {
                "repo": s.repo,
                "number": s.number,
                "title": s.title,
                "state": s.state,
                "author": s.author,
                "labels": list(s.labels),
                "comments": s.comments,
                "updated_at": s.updated_at,
                "created_at": s.created_at,
                "html_url": s.html_url,
                "processed": make_issue_key(s.repo, s.number) in processed_keys,
            }
            for s in entry.issues
        ],
        "errors": [dict(error) for error in entry.errors],
        "repos": list(entry.repos),
        "cache": {"hit": cache_hit, "fetched_at": entry.fetched_at},
    }


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
    return cfg.gh_proxy_url, cfg.gh_proxy_hmac_key.get_secret_value().encode("utf-8")


def _build_orchestrator(cfg: Settings) -> tuple[GitHubBackend, ProxyGitTransport]:
    base_url, key = _require_proxy_mode(cfg)
    github = GitHubProxyClient(base_url=base_url, hmac_key=key)
    transport = ProxyGitTransport(base_url=base_url, hmac_key=key)
    return github, transport


def _build_state(settings: Settings) -> dict[str, Any]:
    db = get_database(settings.sqlite_path)
    github, git_transport = _build_orchestrator(settings)
    natives_cache: NativesCache | None = None
    if settings.natives_cache_enabled:
        natives_cache = NativesCache(
            settings.natives_cache_root,
            max_entries_per_repo=settings.natives_cache_max_entries_per_repo,
            max_bytes=settings.natives_cache_max_bytes,
        )
    sandbox = SandboxManager(
        settings.workspace_root,
        transport=git_transport,
        natives_cache=natives_cache,
    )
    pool = WorkerPool(settings=settings, db=db, github=github, sandbox=sandbox, git_transport=git_transport)
    autoclose = AutocloseScheduler(settings=settings, db=db, github=github)
    return {
        "settings": settings,
        "db": db,
        "github": github,
        "git_transport": git_transport,
        "sandbox": sandbox,
        "natives_cache": natives_cache,
        "pool": pool,
        "issue_browse_cache": _IssueBrowseCache(),
        "autoclose": autoclose,
    }


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the FastAPI app. `settings` parameter is for tests."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        cfg = settings or get_settings()
        cfg.ensure_paths()
        app.state.bag = _build_state(cfg)
        app.state.bag["started_at"] = time.time()
        pool: WorkerPool = app.state.bag["pool"]
        await pool.start()
        autoclose: AutocloseScheduler = app.state.bag["autoclose"]
        await autoclose.start()
        try:
            yield
        finally:
            await autoclose.stop()
            await pool.stop(
                drain_timeout=cfg.shutdown_drain_timeout_seconds,
                kill_timeout=cfg.shutdown_kill_timeout_seconds,
            )

    app = FastAPI(title="robomp", version="0.1.0", lifespan=lifespan)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    async def readyz(request: Request) -> dict[str, str]:
        pool = request.app.state.bag.get("pool")
        if pool is None:
            raise HTTPException(503, "not initialized")
        return {"status": "ready"}

    @app.post("/webhook/github")
    async def webhook(
        request: Request,
        x_github_event: str = Header(..., alias="X-GitHub-Event"),
        x_github_delivery: str = Header(..., alias="X-GitHub-Delivery"),
        x_hub_signature_256: str | None = Header(None, alias="X-Hub-Signature-256"),
    ) -> JSONResponse:
        bag = request.app.state.bag
        cfg: Settings = bag["settings"]
        body = await request.body()
        if not github_events.verify_signature(
            cfg.github_webhook_secret.get_secret_value(),
            body,
            x_hub_signature_256,
        ):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid signature")
        try:
            payload = await request.json()
        except Exception as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"invalid json: {exc}") from exc

        db: Database = bag["db"]
        issue_cache: _IssueBrowseCache = bag["issue_browse_cache"]
        await issue_cache.apply_webhook(
            event_type=x_github_event,
            payload=payload,
            allowlist=cfg.repo_allowlist,
        )

        def _resolve(repo_full: str, pr_number: int) -> str | None:
            row = db.find_issue_by_pr(repo_full, pr_number)
            return row.key if row else None

        decision = github_events.route(
            x_github_event,
            payload,
            allowlist=cfg.repo_allowlist,
            bot_login=cfg.bot_login,
            maintainers=cfg.maintainer_logins,
            reviewer_bots=cfg.reviewer_bots,
            pr_review_enabled=cfg.pr_review_enabled,
            pr_review_trigger=cfg.pr_review_trigger,
            vouch_review_label=cfg.vouch_review_label,
            vouch_review_labeler=cfg.vouch_review_labeler,
            resolve_issue_from_pr=_resolve,
        )

        # Auto-close cancellation hooks. A pending question-issue closure is
        # cancelled synchronously the moment any human signal arrives:
        # follow-up comment in the issue thread, or the issue being closed
        # externally. The DAO is a no-op when no row exists or it's already
        # past `pending`, so this is safe to fire on every routed event.
        if decision.issue_key:
            cancel_reason: str | None = None
            if (
                x_github_event == "issue_comment"
                and str(payload.get("action") or "") == "created"
                and decision.task == "handle_comment"
            ):
                cancel_reason = "user_replied"
            elif x_github_event == "issues" and str(payload.get("action") or "") == "closed":
                cancel_reason = "externally_closed"
            if cancel_reason is not None:
                cancelled = db.cancel_pending_closure(decision.issue_key, reason=cancel_reason)
                if cancelled:
                    log.info(
                        "autoclose cancelled",
                        extra={
                            "issue_key": decision.issue_key,
                            "reason": cancel_reason,
                            "event": x_github_event,
                        },
                    )

        # Persist directive metadata on the stored payload so the durable
        # queue (and any replay) carries the maintainer signal forward.
        if decision.directive:
            payload = dict(payload)
            payload["_robomp_directive"] = {
                "body": decision.directive_body,
                "author": decision.directive_author,
                "pragmas": [list(item) for item in decision.directive_pragmas],
                "authorizes_impl": decision.directive_authorizes_impl,
            }

        if not decision.should_queue:
            log.info("skip", extra={"event": x_github_event, "reason": decision.reason})
            db.record_event(
                delivery_id=x_github_delivery,
                event_type=x_github_event,
                repo=decision.repo,
                issue_key=decision.issue_key,
                payload=payload,
                state="skipped",
                last_error=decision.reason,
            )
            return JSONResponse({"delivery": x_github_delivery, "state": "skipped"}, status_code=202)

        # Per-user rate limiting. Lifecycle events (cleanup) carry no submitter
        # and are not gated. For everything user-driven, atomically record the
        # accepted delivery while checking the rolling window against the tier cap.
        submitter = decision.submitter
        if submitter:
            cap = github_events.rate_limit_cap(
                submitter,
                decision.association,
                unlimited=cfg.rate_limit_unlimited | cfg.maintainer_logins,
                default=cfg.rate_limit_default,
                contributor=cfg.rate_limit_contributor,
            )
            since = iso_seconds_ago(cfg.rate_limit_window_seconds)
            admission = db.admit_submission(
                delivery_id=x_github_delivery,
                login=submitter,
                repo=decision.repo,
                since=since,
                cap=cap,
            )
            if not admission.accepted:
                window = int(cfg.rate_limit_window_seconds)
                reason = f"rate limit: @{submitter} has used {admission.used}/{cap} submissions in the last {window}s"
                log.info(
                    "rate_limited",
                    extra={
                        "event": x_github_event,
                        "delivery": x_github_delivery,
                        "login": submitter,
                        "association": decision.association,
                        "used": admission.used,
                        "cap": cap,
                    },
                )
                db.record_event(
                    delivery_id=x_github_delivery,
                    event_type=x_github_event,
                    repo=decision.repo,
                    issue_key=decision.issue_key,
                    payload=payload,
                    state="skipped",
                    last_error=reason,
                )
                return JSONResponse(
                    {"delivery": x_github_delivery, "state": "skipped", "reason": "rate_limited"},
                    status_code=202,
                )

        inserted = db.record_event(
            delivery_id=x_github_delivery,
            event_type=x_github_event,
            repo=decision.repo,
            issue_key=decision.issue_key,
            payload=payload,
            state="queued",
        )
        if inserted:
            pool: WorkerPool = bag["pool"]
            pool.wake()
            log.info(
                "queued", extra={"event": x_github_event, "delivery": x_github_delivery, "key": decision.issue_key}
            )
        else:
            log.info("duplicate", extra={"event": x_github_event, "delivery": x_github_delivery})
        return JSONResponse({"delivery": x_github_delivery, "state": "queued"}, status_code=202)

    @app.post("/replay")
    async def replay(
        request: Request,
        x_robomp_token: str | None = Header(None, alias="X-Robomp-Replay-Token"),
        delivery_id: str = "",
    ) -> JSONResponse:
        bag = request.app.state.bag
        cfg: Settings = bag["settings"]
        if cfg.replay_token is None:
            raise HTTPException(404, "replay disabled")
        if x_robomp_token != cfg.replay_token.get_secret_value():
            raise HTTPException(401, "invalid replay token")
        db: Database = bag["db"]
        row = db.get_event(delivery_id)
        if row is None:
            raise HTTPException(404, "unknown delivery")
        if not db.requeue_event(delivery_id, from_states=INACTIVE_EVENT_STATES):
            raise HTTPException(409, f"delivery {delivery_id} is {row.state}; only inactive events can be replayed")
        bag["pool"].wake()
        return JSONResponse({"delivery": delivery_id, "state": "queued"})

    def _require_trigger_token(cfg: Settings, token: str | None) -> None:
        if cfg.replay_token is None:
            raise HTTPException(404, "trigger disabled (set ROBOMP_REPLAY_TOKEN to enable)")
        if token != cfg.replay_token.get_secret_value():
            raise HTTPException(401, "invalid replay token")

    @app.get("/api/github/issues")
    async def api_github_issues(
        request: Request,
        state: str = "open",
        limit: int = 30,
        refresh: bool = False,
        x_robomp_token: str | None = Header(None, alias="X-Robomp-Replay-Token"),
    ) -> dict[str, Any]:
        """Browse issues across `ROBOMP_REPO_ALLOWLIST` for the trigger picker.

        Token-gated identically to `/api/trigger`: this can expose titles from
        private repos. Normal dashboard loads use the server cache; only cache
        misses and explicit refreshes hit GitHub.
        """
        bag = request.app.state.bag
        cfg: Settings = bag["settings"]
        _require_trigger_token(cfg, x_robomp_token)

        if state not in ("open", "closed", "all"):
            raise HTTPException(400, "state must be open|closed|all")
        capped = max(1, min(int(limit), 100))
        github: GitHubBackend = bag["github"]
        issue_cache: _IssueBrowseCache = bag["issue_browse_cache"]
        repos = tuple(sorted(cfg.repo_allowlist))
        if not repos:
            return {"issues": [], "errors": [], "repos": [], "cache": {"hit": False, "fetched_at": time.time()}}

        async def _fetch() -> tuple[list[IssueSummary], list[dict[str, str]]]:
            # Fan out across allowlisted repos; per-repo failures don't take down the panel.
            async def _one(repo: str) -> tuple[str, list[IssueSummary], str | None]:
                try:
                    items = await github.list_issues(repo, state=state, limit=capped)
                    return repo, items, None
                except Exception as exc:  # GitHubError, network, etc.
                    log.warning("list_issues failed", extra={"repo": repo, "err": str(exc)})
                    return repo, [], str(exc)

            results = await asyncio.gather(*(_one(r) for r in repos))
            merged: list[IssueSummary] = []
            errors: list[dict[str, str]] = []
            for repo, items, err in results:
                if err is not None:
                    errors.append({"repo": repo, "error": err})
                merged.extend(items)
            return merged, errors

        entry, cache_hit = await issue_cache.get_or_fetch(
            state=state,
            limit=capped,
            repos=repos,
            force=refresh,
            fetch=_fetch,
        )
        # `processed` is not cached: a freshly-triaged issue must immediately
        # disappear from the "fresh issues" filter on the next dashboard refresh.
        db: Database = bag["db"]
        processed = frozenset(db.processed_issue_keys(make_issue_key(s.repo, s.number) for s in entry.issues))
        return _issue_browse_payload(entry=entry, cache_hit=cache_hit, processed_keys=processed)

    @app.post("/api/trigger")
    async def api_trigger(
        request: Request,
        payload: dict[str, Any] = Body(...),
        x_robomp_token: str | None = Header(None, alias="X-Robomp-Replay-Token"),
    ) -> JSONResponse:
        """Manually queue an issue. Modes:

        - `triage`: fetch fresh from GitHub and enqueue (or re-enqueue) as if `issues.opened`.
        - `retry`:  requeue an existing stored event. Identify it by `delivery_id` or `issue`.
        """
        bag = request.app.state.bag
        cfg: Settings = bag["settings"]
        _require_trigger_token(cfg, x_robomp_token)

        db: Database = bag["db"]
        github: GitHubBackend = bag["github"]
        pool: WorkerPool = bag["pool"]

        mode = str(payload.get("mode") or "").strip().lower()
        if mode not in ("triage", "retry"):
            raise HTTPException(400, "mode must be 'triage' or 'retry'")

        issue_ref = payload.get("issue")
        delivery_id = payload.get("delivery_id")

        if mode == "triage":
            if not isinstance(issue_ref, str) or not issue_ref:
                raise HTTPException(400, "triage requires 'issue' = 'owner/repo#NN'")
            try:
                repo_full, number = parse_issue_ref(issue_ref)
            except InvalidIssueRef as exc:
                raise HTTPException(400, str(exc)) from exc
            if not cfg.allows(repo_full):
                raise HTTPException(403, f"{repo_full} not in ROBOMP_REPO_ALLOWLIST")
            try:
                delivery = await enqueue_manual_triage(
                    db=db,
                    github=github,
                    repo_full=repo_full,
                    number=number,
                )
            except ManualTriageConflict as exc:
                raise HTTPException(409, str(exc)) from exc
            except ManualTriageError as exc:
                raise HTTPException(400, str(exc)) from exc
            except GitHubError as exc:
                raise HTTPException(502, f"github error: {exc.status} {exc.message}") from exc
            pool.wake()
            log.info("manual triage", extra={"delivery": delivery, "issue": f"{repo_full}#{number}"})
            return JSONResponse(
                {"delivery": delivery, "state": "queued", "mode": "triage"},
                status_code=202,
            )

        # mode == "retry"
        if isinstance(delivery_id, str) and delivery_id:
            target = delivery_id
        elif isinstance(issue_ref, str) and issue_ref:
            try:
                repo_full, number = parse_issue_ref(issue_ref)
            except InvalidIssueRef as exc:
                raise HTTPException(400, str(exc)) from exc
            if not cfg.allows(repo_full):
                raise HTTPException(403, f"{repo_full} not in ROBOMP_REPO_ALLOWLIST")
            row = db.latest_event_for_issue(make_issue_key(repo_full, number))
            if row is None:
                raise HTTPException(404, f"no retryable stored event for {repo_full}#{number}")
            target = row.delivery_id
        else:
            raise HTTPException(400, "retry requires 'delivery_id' or 'issue'")

        event = db.get_event(target)
        if event is None:
            raise HTTPException(404, f"unknown delivery {target}")
        if not db.requeue_event(target, from_states=INACTIVE_EVENT_STATES):
            raise HTTPException(409, f"delivery {target} is {event.state}; only inactive events can be retried")
        pool.wake()
        log.info("manual retry", extra={"delivery": target})
        return JSONResponse(
            {"delivery": target, "state": "queued", "mode": "retry"},
            status_code=202,
        )

    @app.post("/api/cancel")
    async def api_cancel(
        request: Request,
        payload: dict[str, Any] = Body(...),
        x_robomp_token: str | None = Header(None, alias="X-Robomp-Replay-Token"),
    ) -> JSONResponse:
        """Stop a running event. The omp subprocess is killed; the row lands in
        `failed` with `cancelled by operator` as the error.
        """
        bag = request.app.state.bag
        cfg: Settings = bag["settings"]
        _require_trigger_token(cfg, x_robomp_token)

        delivery_id = payload.get("delivery_id")
        if not isinstance(delivery_id, str) or not delivery_id:
            raise HTTPException(400, "cancel requires 'delivery_id'")

        db: Database = bag["db"]
        event = db.get_event(delivery_id)
        if event is None:
            raise HTTPException(404, f"unknown delivery {delivery_id}")
        if event.state != "running":
            raise HTTPException(409, f"delivery {delivery_id} is {event.state}; only running deliveries can be cancelled")

        pool: WorkerPool = bag["pool"]
        fired = await pool.cancel_event(delivery_id)
        log.info(
            "manual cancel",
            extra={"delivery": delivery_id, "fired": fired, "state": event.state},
        )
        return JSONResponse(
            {"delivery": delivery_id, "fired": fired, "previous_state": event.state},
            status_code=202,
        )

    @app.get("/events")
    async def events(request: Request, limit: int = 50) -> dict[str, Any]:
        rows = request.app.state.bag["db"].list_events(limit=limit)
        return {
            "events": [
                {
                    "delivery_id": r.delivery_id,
                    "event_type": r.event_type,
                    "repo": r.repo,
                    "issue_key": r.issue_key,
                    "state": r.state,
                    "attempts": r.attempts,
                    "received_at": r.received_at,
                    "last_error": r.last_error,
                }
                for r in rows
            ]
        }

    @app.get("/issues")
    async def issues(request: Request, limit: int = 100) -> dict[str, Any]:
        rows = request.app.state.bag["db"].list_issues(limit=limit)
        return {
            "issues": [
                {
                    "key": r.key,
                    "repo": r.repo,
                    "number": r.number,
                    "branch": r.branch,
                    "pr_number": r.pr_number,
                    "state": r.state,
                    "classification": r.classification,
                    "updated_at": r.updated_at,
                }
                for r in rows
            ]
        }

    @app.get("/", response_class=HTMLResponse)
    async def index(request: Request) -> HTMLResponse:
        cfg: Settings = request.app.state.bag["settings"]
        token = cfg.replay_token.get_secret_value() if cfg.replay_token else None
        return HTMLResponse(render_index(token))

    @app.get("/api/status")
    async def api_status(request: Request) -> dict[str, Any]:
        bag = request.app.state.bag
        cfg: Settings = bag["settings"]
        db: Database = bag["db"]
        pool: WorkerPool = bag["pool"]
        started = float(bag.get("started_at") or time.time())

        def _collect() -> dict[str, Any]:
            # All SQLite reads run off the event loop. The dashboard polls this
            # every 3s, and the queries (200 issues + per-issue latest events +
            # state counts) can take seconds under load; doing them inline
            # would block the loop and stall every other endpoint — including
            # /healthz — which is how the dashboard ends up "never loading".
            issues_rows = db.list_issues(limit=200)
            latest_events = db.latest_events_for_issues(r.key for r in issues_rows)

            def _latest_event_payload(key: str) -> dict[str, Any] | None:
                latest = latest_events.get(key)
                if latest is None:
                    return None
                return {
                    "delivery_id": latest.delivery_id,
                    "event_type": latest.event_type,
                    "state": latest.state,
                    "attempts": latest.attempts,
                    "received_at": latest.received_at,
                    "last_error": latest.last_error,
                }

            events_rows = db.list_events(limit=25)

            # Recent events can reference issues outside the capped 200-issue
            # `issues` window above. Surface each event's current DB issue state
            # so the dashboard can suppress failures for issues that have since
            # gone terminal (merged/closed/abandoned) without a row to consult.
            # Reuse the already-loaded issue states; fall back to a per-key
            # lookup (bounded by the 25-event cap) for keys outside the window.
            issue_state_by_key: dict[str, str | None] = {r.key: r.state for r in issues_rows}

            def _recent_issue_state(issue_key: str | None) -> str | None:
                if not issue_key:
                    return None
                if issue_key not in issue_state_by_key:
                    row = db.get_issue(issue_key)
                    issue_state_by_key[issue_key] = row.state if row is not None else None
                return issue_state_by_key[issue_key]

            return {
                "event_counts": db.event_state_counts(),
                "issue_event_counts": db.latest_issue_event_state_counts(),
                "running_events": db.list_running_events(),
                "issues": [
                    {
                        "key": r.key,
                        "repo": r.repo,
                        "number": r.number,
                        "branch": r.branch,
                        "pr_number": r.pr_number,
                        "state": r.state,
                        "classification": r.classification,
                        "updated_at": r.updated_at,
                        "latest_event": _latest_event_payload(r.key),
                    }
                    for r in issues_rows
                ],
                "recent_events": [
                    {
                        "delivery_id": r.delivery_id,
                        "event_type": r.event_type,
                        "repo": r.repo,
                        "issue_key": r.issue_key,
                        "state": r.state,
                        "attempts": r.attempts,
                        "received_at": r.received_at,
                        "last_error": r.last_error,
                        "issue_state": _recent_issue_state(r.issue_key),
                    }
                    for r in events_rows
                ],
            }

        collected = await asyncio.to_thread(_collect)
        inflight = await pool.inflight_snapshot()
        return {
            "runtime": {
                "bot_login": cfg.bot_login,
                "repo_allowlist": sorted(cfg.repo_allowlist),
                "max_concurrency": cfg.max_concurrency,
                "model": cfg.model,
                "thinking_level": cfg.thinking_level,
                "uptime_seconds": max(0.0, time.time() - started),
            },
            "inflight": inflight,
            **collected,
        }

    @app.get("/api/logs")
    async def api_logs(request: Request, limit: int = 400) -> dict[str, Any]:
        cfg: Settings = request.app.state.bag["settings"]
        capped = max(1, min(int(limit), 2000))
        entries = tail_jsonl(cfg.log_dir / "robomp.log.jsonl", limit=capped)
        return {"entries": entries, "count": len(entries), "limit": capped}

    # Mount the built dashboard bundle. The `index.html` itself is served by
    # the `@app.get("/")` handler above so the per-instance replay-token can
    # be substituted; `/static/*` carries the hashed JS/CSS produced by Vite.
    app.mount("/static", StaticFiles(directory=static_dir()), name="static")

    return app


__all__ = ["create_app"]
