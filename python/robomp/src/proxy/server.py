"""gh-proxy FastAPI app: HMAC-gated GitHub REST + git proxy.

Robomp calls every endpoint with HMAC headers (see `robomp.proxy_hmac`).
Authenticated requests dispatch to a single `GitHubClient` instance holding
the PAT, or to `robomp.git_ops` for git transport. The PAT never leaves
this process.

Endpoint payloads are deliberately typed (no generic GitHub passthrough):
each one names exactly one operation robomp performs.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import subprocess
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse

from robomp.config import Settings
from robomp.git_ops import (
    GitCommandError,
    HeadDriftError,
)
from robomp.git_ops import (
    clone as git_clone,
)
from robomp.git_ops import (
    fetch_pr_head as git_fetch_pr_head,
)
from robomp.git_ops import (
    fetch_prune as git_fetch_prune,
)
from robomp.git_ops import (
    fetch_ref as git_fetch_ref,
)
from robomp.git_ops import (
    push as git_push,
)
from robomp.github_client import GitHubClient, GitHubError
from robomp.proxy_hmac import HEADER_SIGNATURE, HEADER_TIMESTAMP, verify
from robomp.sandbox import _safe_directory_env, _slot_subprocess_kwargs
from robomp.sandbox import workspace_key as compute_workspace_key

log = logging.getLogger(__name__)


def _serialize(obj: Any) -> Any:
    """Best-effort serializer for dataclasses + tuples → JSON-safe payload."""
    if hasattr(obj, "__dataclass_fields__"):
        data = asdict(obj)
        return {k: _serialize(v) for k, v in data.items()}
    if isinstance(obj, tuple):
        return [_serialize(v) for v in obj]
    if isinstance(obj, list):
        return [_serialize(v) for v in obj]
    if isinstance(obj, dict):
        return {k: _serialize(v) for k, v in obj.items()}
    return obj


def _gh_error_response(exc: GitHubError) -> JSONResponse:
    return JSONResponse(
        {
            "error": {
                "kind": "github",
                "status": exc.status,
                "message": exc.message,
                "retry_after": exc.retry_after,
            }
        },
        status_code=exc.status,
    )


def _git_error_response(exc: GitCommandError, *, head_drift: bool = False) -> JSONResponse:
    payload: dict[str, Any] = {
        "error": {
            "kind": "head_drift" if head_drift else "git",
            "returncode": exc.returncode,
            "cmd": exc.cmd,
            "stdout": exc.stdout,
            "stderr": exc.stderr,
        }
    }
    # 409 for head drift (concurrent commit detected); 502 for everything else.
    return JSONResponse(payload, status_code=409 if head_drift else 502)


def _require_str(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise HTTPException(400, f"missing/invalid '{field}'")
    return value


def _require_int(value: Any, field: str) -> int:
    if not isinstance(value, int):
        raise HTTPException(400, f"missing/invalid '{field}'")
    return value


_SAFE_REF_BODY_RE = re.compile(r"[A-Za-z0-9._/-]+")


def _require_fetch_ref(value: Any) -> str:
    """Validate the base-branch ref for `/gh/v1/git/fetch_ref`.

    The orchestrator only ever fetches a branch — a bare name (`main`,
    `farm/x/y`, `alice/fix-parser`) or `refs/heads/<name>`. Reject anything
    `git_ops._branch_refspec` would otherwise pass verbatim into the fetch
    refspec: `:` (refspec injection — write arbitrary refs in the shared
    pool), a leading `-` (argv option injection), and (via the charset) `*`
    `+` `~` `^` `@` `?` `[` `\\`, whitespace, and control bytes; plus the
    git-invalid `..` / `//` / leading-or-trailing `/` / trailing `.`|`.lock`
    forms. Normal slashy branch names still pass.
    """
    ref = _require_str(value, "ref")
    body = ref.removeprefix("refs/heads/")
    if (
        not body
        or ref.startswith("-")
        or body.startswith("/")
        or body.endswith(("/", ".", ".lock"))
        or "//" in body
        or ".." in body
        or not _SAFE_REF_BODY_RE.fullmatch(body)
    ):
        raise HTTPException(400, "invalid ref")
    return ref


def _optional_slot_uid(value: Any) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or not (0 < value < 65536):
        raise HTTPException(400, "missing/invalid 'slot_uid'")
    return value


def _optional_str_list(value: Any, field: str) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise HTTPException(400, f"invalid '{field}': must be array of strings")
    return list(value)


def _require_review_comments(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise HTTPException(400, "missing/invalid 'comments'")
    comments: list[dict[str, Any]] = []
    for idx, item in enumerate(value):
        if not isinstance(item, dict):
            raise HTTPException(400, f"comments[{idx}] must be an object")
        path = _require_str(item.get("path"), f"comments[{idx}].path")
        line = _require_int(item.get("line"), f"comments[{idx}].line")
        body = _require_str(item.get("body"), f"comments[{idx}].body")
        side = str(item.get("side") or "RIGHT")
        if side not in ("RIGHT", "LEFT"):
            raise HTTPException(400, f"comments[{idx}].side must be RIGHT or LEFT")
        comment: dict[str, Any] = {"path": path, "line": line, "side": side, "body": body}
        start_line = item.get("start_line")
        if start_line is not None:
            comment["start_line"] = _require_int(start_line, f"comments[{idx}].start_line")
        start_side = item.get("start_side")
        if start_side is not None:
            start_side_str = _require_str(start_side, f"comments[{idx}].start_side")
            if start_side_str not in ("RIGHT", "LEFT"):
                raise HTTPException(400, f"comments[{idx}].start_side must be RIGHT or LEFT")
            comment["start_side"] = start_side_str
        comments.append(comment)
    return comments

def _pool_dir(cfg: Settings, repo: str) -> Path:
    _validate_repo_name(repo)
    return Path(cfg.workspace_root) / "_pool" / repo.replace("/", "__")


def _workspace_repo_dir(cfg: Settings, workspace_key: str) -> Path:
    # Defense-in-depth: workspace_key is constructed by `sandbox.workspace_key`
    # as `<repo_with_underscores>__<number>`. Reject anything outside that shape.
    if "/" in workspace_key or workspace_key.startswith(".") or ".." in workspace_key:
        raise HTTPException(400, f"invalid workspace_key {workspace_key!r}")
    return Path(cfg.workspace_root) / workspace_key / "repo"


def _resolve_token(cfg: Settings) -> str:
    if cfg.github_token is None:
        # Will already have been caught at startup, but stay defensive.
        raise HTTPException(500, "gh-proxy: GITHUB_TOKEN not configured")
    return cfg.github_token.get_secret_value()


def _resolve_hmac_key(cfg: Settings) -> bytes:
    if cfg.gh_proxy_hmac_key is None:
        raise HTTPException(500, "gh-proxy: ROBOMP_GH_PROXY_HMAC_KEY not configured")
    return cfg.gh_proxy_hmac_key.get_secret_value().encode("utf-8")


_ORIGIN_READ_TIMEOUT_SECONDS = 5.0


_REMOTE_HELPER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*::")
_FORBIDDEN_URL_BYTES_RE = re.compile(r"[\x00-\x1f\x7f]|%(?:00|0a|0d)", re.IGNORECASE)
_GITHUB_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]+$")
_GIT_PROBE_SCRUBBED_ENV_KEYS = (
    "ROBOMP_GIT_HTTP_AUTH",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_WEBHOOK_SECRET",
    "ROBOMP_REPLAY_TOKEN",
    "ROBOMP_GH_PROXY_HMAC_KEY",
)


@dataclass(slots=True, frozen=True)
class _RemoteAuth:
    url: str
    token: str | None
    auth_url: str | None


def _validate_repo_name(repo: str) -> None:
    if not _GITHUB_REPO_RE.fullmatch(repo) or "/.." in repo or "../" in repo:
        raise HTTPException(400, f"invalid repo {repo!r}")


def _github_url_for_repo(repo: str) -> str:
    _validate_repo_name(repo)
    return f"https://github.com/{repo}.git"


def _git_probe_env(repo_dir: Path) -> dict[str, str]:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "", "SSH_ASKPASS": ""}
    for key in _GIT_PROBE_SCRUBBED_ENV_KEYS:
        env.pop(key, None)
    env.update(_safe_directory_env(repo_dir))
    return env


def _read_remote_urls(repo_dir: Path, slot_uid: int | None = None, *, push: bool = False) -> list[str]:
    """Read every configured fetch URL or push URL for `origin` without contacting it."""
    env = _git_probe_env(repo_dir)
    slot_kwargs = _slot_subprocess_kwargs(slot_uid)
    selector = ["--push", "--all"] if push else ["--all"]
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo_dir), "remote", "get-url", *selector, "origin"],
            capture_output=True,
            text=True,
            check=False,
            timeout=_ORIGIN_READ_TIMEOUT_SECONDS,
            env=env,
            **slot_kwargs,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(504, "timeout reading origin url") from exc
    if proc.returncode != 0:
        # `git remote get-url` writes nothing useful to stdout on failure; do
        # NOT echo stderr to the client (may leak local paths). The proxy log
        # already captured the failure.
        log.warning("gh-proxy: failed to read origin url", extra={"repo_dir": str(repo_dir)})
        raise HTTPException(400, "could not read origin url for worktree")
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def _read_single_remote_url(repo_dir: Path, expected_repo: str, *, push: bool, slot_uid: int | None = None) -> str:
    urls = list(dict.fromkeys(_read_remote_urls(repo_dir, slot_uid=slot_uid, push=push)))
    if len(urls) != 1:
        kind = "push" if push else "fetch"
        log.warning(
            "gh-proxy: refusing git op — origin has ambiguous remote urls",
            extra={"expected_repo": expected_repo, "kind": kind, "count": len(urls)},
        )
        raise HTTPException(400, f"origin must have exactly one {kind} url")
    return urls[0]


def _normalized_github_https_url(url: str, expected_repo: str) -> str:
    _validate_repo_name(expected_repo)
    parsed = urlparse(url)
    if (parsed.scheme or "").lower() != "https":
        raise HTTPException(400, f"remote url must be https://github.com/{expected_repo}[.git]")
    if parsed.username or parsed.password:
        raise HTTPException(400, "remote url must not contain embedded credentials")
    try:
        port = parsed.port
    except ValueError as exc:
        raise HTTPException(400, "remote url has invalid port") from exc
    if port is not None:
        raise HTTPException(400, "remote url must not specify a port")
    if (parsed.hostname or "").lower() != "github.com":
        raise HTTPException(400, f"remote url host must be github.com for repo {expected_repo!r}")
    if parsed.params or parsed.query or parsed.fragment:
        raise HTTPException(400, "remote url must not contain params, query, or fragment")
    path = parsed.path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    if path.lower() != expected_repo.lower():
        raise HTTPException(400, f"remote url does not match repo {expected_repo!r}")
    return _github_url_for_repo(expected_repo)


def _remote_auth_for_url(url: str, expected_repo: str, token: str) -> _RemoteAuth:
    raw = url.strip()
    if not raw or raw != url:
        raise HTTPException(400, "remote url must not be empty or padded")
    if _FORBIDDEN_URL_BYTES_RE.search(raw):
        raise HTTPException(400, "remote url contains forbidden control bytes")
    if raw.startswith("-"):
        raise HTTPException(400, "remote url must not start with '-'")
    if _REMOTE_HELPER_RE.match(raw):
        raise HTTPException(400, "git remote helper transports are disabled")
    scheme = (urlparse(raw).scheme or "").lower()
    if scheme in ("http", "https"):
        normalized = _normalized_github_https_url(raw, expected_repo)
        return _RemoteAuth(url=normalized, token=token, auth_url=normalized)
    return _RemoteAuth(url=raw, token=None, auth_url=None)


def _clone_remote_auth(clone_url: str, expected_repo: str, token: str) -> _RemoteAuth:
    try:
        return _remote_auth_for_url(clone_url, expected_repo, token)
    except HTTPException:
        log.warning(
            "gh-proxy: refusing clone — clone_url is not permitted",
            extra={"expected_repo": expected_repo},
        )
        raise


def _origin_remote_auth(
    repo_dir: Path,
    expected_repo: str,
    token: str,
    *,
    push: bool = False,
    slot_uid: int | None = None,
) -> _RemoteAuth:
    url = _read_single_remote_url(repo_dir, expected_repo, push=push, slot_uid=slot_uid)
    try:
        return _remote_auth_for_url(url, expected_repo, token)
    except HTTPException:
        log.warning(
            "gh-proxy: refusing git op — origin url is not permitted",
            extra={"expected_repo": expected_repo, "push": push},
        )
        raise


def create_proxy_app(settings: Settings) -> FastAPI:
    """Build the gh-proxy FastAPI app bound to `settings`."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.github = GitHubClient(_resolve_token(settings))
        app.state.settings = settings
        yield

    app = FastAPI(title="robomp-gh-proxy", version="0.1.0", lifespan=lifespan)

    def _request_target(request: Request) -> str:
        """Canonical signing target: `path` plus raw query string if any.

        Binding the query into the HMAC stops an attacker from replaying a
        signed `/gh/v1/issue?repo=octo/widget&number=1` against
        `?repo=octo/widget&number=2`.
        """
        query = request.url.query
        return f"{request.url.path}?{query}" if query else request.url.path

    async def _read_body_capped(request: Request) -> bytes:
        """Read the request body with a hard byte cap.

        Checks `Content-Length` first (cheap reject before any read), then
        streams chunks via `request.stream()` with a running counter so a
        client that lies about (or omits) the header still can't get more
        than `max_bytes` into memory. We deliberately do NOT call
        `request.body()` first — that would buffer the full payload before
        auth checks ever run.
        """
        max_bytes = settings.gh_proxy_max_body_bytes
        cl = request.headers.get("content-length")
        if cl is not None:
            try:
                declared = int(cl)
            except ValueError as exc:
                raise HTTPException(400, "invalid content-length") from exc
            if declared > max_bytes:
                raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "request body too large")
        chunks: list[bytes] = []
        total = 0
        async for chunk in request.stream():
            if not chunk:
                continue
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "request body too large")
            chunks.append(chunk)
        body = b"".join(chunks)
        # Starlette's `request.body()` / `request.json()` re-read from
        # `request._body`. We consumed the stream above, so seed the cache
        # to keep downstream JSON parsing working without a second read.
        request._body = body  # type: ignore[attr-defined]
        return body

    async def _authenticate(request: Request) -> bytes:
        body = await _read_body_capped(request)
        ts = request.headers.get(HEADER_TIMESTAMP)
        sig = request.headers.get(HEADER_SIGNATURE)
        target = _request_target(request)
        result = verify(
            method=request.method,
            path=target,
            body=body,
            timestamp=ts,
            signature=sig,
            key=_resolve_hmac_key(settings),
        )
        if not result.ok:
            log.warning(
                "gh-proxy auth rejected",
                extra={"reason": result.reason, "path": request.url.path},
            )
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "unauthenticated")
        return body

    # ---- meta ----
    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    # ---- reads ----
    @app.get("/gh/v1/authenticated_login")
    async def authenticated_login(request: Request) -> dict[str, str]:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            login = await github.get_authenticated_login()
        except GitHubError as exc:
            raise HTTPException(exc.status, exc.message) from exc
        return {"login": login}

    @app.get("/gh/v1/repo")
    async def get_repo(request: Request, repo: str) -> JSONResponse:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            info = await github.get_repo(repo)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse(_serialize(info))

    @app.get("/gh/v1/issue")
    async def get_issue(request: Request, repo: str, number: int) -> JSONResponse:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            info = await github.get_issue(repo, number)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse(_serialize(info))

    @app.get("/gh/v1/closing_prs")
    async def list_closing_prs(request: Request, repo: str, number: int) -> JSONResponse:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            prs = await github.list_closing_pull_requests(repo, number)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"pr_numbers": list(prs)})

    @app.get("/gh/v1/pull_request")
    async def get_pull_request(request: Request, repo: str, number: int) -> JSONResponse:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            info = await github.get_pull_request(repo, number)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse(_serialize(info))

    @app.get("/gh/v1/pr_files")
    async def list_pr_files(request: Request, repo: str, pr_number: int) -> JSONResponse:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            items = await github.list_pr_files(repo, pr_number)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"items": [_serialize(item) for item in items]})

    @app.get("/gh/v1/issues")
    async def list_issues(request: Request, repo: str, state: str = "open", limit: int = 30) -> JSONResponse:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            items = await github.list_issues(repo, state=state, limit=limit)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"items": [_serialize(s) for s in items]})

    @app.get("/gh/v1/comments")
    async def list_comments(request: Request, repo: str, number: int) -> JSONResponse:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            items = await github.list_comments(repo, number)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"items": [_serialize(c) for c in items]})

    @app.get("/gh/v1/review_comments")
    async def list_review_comments(request: Request, repo: str, pr_number: int) -> JSONResponse:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            items = await github.list_review_comments(repo, pr_number)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"items": [_serialize(c) for c in items]})

    @app.get("/gh/v1/pr_reviews")
    async def list_pr_reviews(request: Request, repo: str, pr_number: int) -> JSONResponse:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            items = await github.list_pr_reviews(repo, pr_number)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"items": [_serialize(r) for r in items]})

    # ---- writes ----
    async def _json_body(request: Request) -> dict[str, Any]:
        await _authenticate(request)
        try:
            data = await request.json()
        except Exception as exc:
            raise HTTPException(400, f"invalid json: {exc}") from exc
        if not isinstance(data, dict):
            raise HTTPException(400, "json body must be an object")
        return data

    @app.post("/gh/v1/post_comment")
    async def post_comment(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        number = _require_int(data.get("number"), "number")
        body = _require_str(data.get("body"), "body")
        github: GitHubClient = request.app.state.github
        try:
            info = await github.post_comment(repo, number, body)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse(_serialize(info))

    @app.post("/gh/v1/open_pull_request")
    async def open_pull_request(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        head = _require_str(data.get("head"), "head")
        base = _require_str(data.get("base"), "base")
        title = _require_str(data.get("title"), "title")
        body = _require_str(data.get("body"), "body")
        draft = bool(data.get("draft", False))
        mcm = bool(data.get("maintainer_can_modify", True))
        github: GitHubClient = request.app.state.github
        try:
            pr = await github.open_pull_request(
                repo=repo,
                head=head,
                base=base,
                title=title,
                body=body,
                draft=draft,
                maintainer_can_modify=mcm,
            )
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse(_serialize(pr))

    @app.post("/gh/v1/request_reviewers")
    async def request_reviewers(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        pr_number = _require_int(data.get("pr_number"), "pr_number")
        reviewers = _optional_str_list(data.get("reviewers"), "reviewers")
        team_reviewers = _optional_str_list(data.get("team_reviewers"), "team_reviewers")
        github: GitHubClient = request.app.state.github
        try:
            await github.request_reviewers(
                repo=repo,
                pr_number=pr_number,
                reviewers=reviewers,
                team_reviewers=team_reviewers,
            )
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"ok": True})

    @app.post("/gh/v1/add_issue_labels")
    async def add_issue_labels(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        number = _require_int(data.get("number"), "number")
        labels = _optional_str_list(data.get("labels"), "labels") or []
        github: GitHubClient = request.app.state.github
        try:
            applied = await github.add_issue_labels(repo, number, labels)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"labels": list(applied)})

    @app.post("/gh/v1/remove_issue_label")
    async def remove_issue_label(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        number = _require_int(data.get("number"), "number")
        label = _require_str(data.get("label"), "label")
        github: GitHubClient = request.app.state.github
        try:
            await github.remove_issue_label(repo, number, label)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"ok": True})

    @app.post("/gh/v1/submit_pr_review")
    async def submit_pr_review(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        pr_number = _require_int(data.get("pr_number"), "pr_number")
        body = _require_str(data.get("body"), "body")
        event = str(data.get("event") or "COMMENT")
        comments = _require_review_comments(data.get("comments"))
        github: GitHubClient = request.app.state.github
        try:
            review = await github.submit_pr_review(
                repo=repo,
                pr_number=pr_number,
                body=body,
                event=event,
                comments=comments,
            )
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse(_serialize(review))

    @app.post("/gh/v1/add_assignees")
    async def add_assignees(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        number = _require_int(data.get("number"), "number")
        assignees = _optional_str_list(data.get("assignees"), "assignees") or []
        github: GitHubClient = request.app.state.github
        try:
            await github.add_assignees(repo, number, assignees)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"ok": True})

    @app.get("/gh/v1/comment_reactions")
    async def list_comment_reactions(request: Request, repo: str, comment_id: int) -> JSONResponse:
        await _authenticate(request)
        github: GitHubClient = request.app.state.github
        try:
            reactions = await github.list_comment_reactions(repo, comment_id)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"items": [_serialize(r) for r in reactions]})

    @app.post("/gh/v1/close_issue")
    async def close_issue(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        number = _require_int(data.get("number"), "number")
        reason_raw = data.get("reason")
        reason = reason_raw if isinstance(reason_raw, str) and reason_raw else "completed"
        github: GitHubClient = request.app.state.github
        try:
            await github.close_issue(repo, number, reason=reason)
        except GitHubError as exc:
            return _gh_error_response(exc)
        return JSONResponse({"ok": True})

    # ---- git transport ----
    #
    # The underlying `robomp.git_ops` primitives are blocking `subprocess.run`
    # calls. Running them directly from an `async def` handler pins the
    # event loop until the subprocess returns; a hung git would freeze the
    # whole proxy. We bridge with `asyncio.to_thread` (work on a threadpool
    # worker) wrapped in `asyncio.wait_for` (hard wall-clock cap, returns
    # 504 on timeout). The subprocess itself can outlive the timeout — a
    # proper subprocess.kill plumbing would have to live inside
    # `git_ops._run_git`; flagged for follow-up.

    async def _run_git_op(fn, *args, **kwargs):  # type: ignore[no-untyped-def]
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(fn, *args, **kwargs),
                timeout=settings.gh_proxy_git_timeout_seconds,
            )
        except TimeoutError as exc:
            log.warning(
                "gh-proxy: git op exceeded timeout",
                extra={"op": fn.__name__, "timeout": settings.gh_proxy_git_timeout_seconds},
            )
            raise HTTPException(504, f"git {fn.__name__} timed out") from exc

    @app.post("/gh/v1/git/clone")
    async def git_clone_endpoint(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        clone_url = _require_str(data.get("clone_url"), "clone_url")
        default_branch = _require_str(data.get("default_branch"), "default_branch")
        remote = _clone_remote_auth(clone_url, repo, _resolve_token(settings))
        target = _pool_dir(settings, repo)
        try:
            await _run_git_op(
                git_clone,
                target,
                clone_url=remote.url,
                default_branch=default_branch,
                token=remote.token,
                auth_url=remote.auth_url,
            )
        except GitCommandError as exc:
            return _git_error_response(exc)
        return JSONResponse({"pool_dir": str(target)})

    @app.post("/gh/v1/git/fetch")
    async def git_fetch_endpoint(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        target = _pool_dir(settings, repo)
        remote = await asyncio.to_thread(_origin_remote_auth, target, repo, _resolve_token(settings))
        try:
            await _run_git_op(
                git_fetch_prune,
                target,
                token=remote.token,
                remote_url=remote.url,
                auth_url=remote.auth_url,
            )
        except GitCommandError as exc:
            return _git_error_response(exc)
        return JSONResponse({"pool_dir": str(target)})

    @app.post("/gh/v1/git/fetch_ref")
    async def git_fetch_ref_endpoint(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        ref = _require_fetch_ref(data.get("ref"))
        target = _pool_dir(settings, repo)
        remote = await asyncio.to_thread(_origin_remote_auth, target, repo, _resolve_token(settings))
        # fetch_ref is intentionally best-effort; never surfaces a 5xx.
        await _run_git_op(
            git_fetch_ref,
            target,
            ref,
            token=remote.token,
            remote_url=remote.url,
            auth_url=remote.auth_url,
        )
        return JSONResponse({"pool_dir": str(target)})

    @app.post("/gh/v1/git/fetch_pr_head")
    async def git_fetch_pr_head_endpoint(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        pr_number = _require_int(data.get("pr_number"), "pr_number")
        target = _pool_dir(settings, repo)
        remote = await asyncio.to_thread(_origin_remote_auth, target, repo, _resolve_token(settings))
        try:
            await _run_git_op(
                git_fetch_pr_head,
                target,
                pr_number,
                token=remote.token,
                remote_url=remote.url,
                auth_url=remote.auth_url,
            )
        except GitCommandError as exc:
            return _git_error_response(exc)
        return JSONResponse({"pool_dir": str(target)})

    @app.post("/gh/v1/git/push")
    async def git_push_endpoint(request: Request) -> JSONResponse:
        data = await _json_body(request)
        repo = _require_str(data.get("repo"), "repo")
        workspace_key = _require_str(data.get("workspace_key"), "workspace_key")
        branch = _require_str(data.get("branch"), "branch")
        expected_head = _require_str(data.get("expected_head"), "expected_head")
        slot_uid = _optional_slot_uid(data.get("slot_uid"))
        # Sanity-check workspace_key matches the repo claim.
        expected_prefix = repo.replace("/", "__") + "__"
        if not workspace_key.startswith(expected_prefix):
            raise HTTPException(400, "workspace_key does not match repo")
        repo_dir = _workspace_repo_dir(settings, workspace_key)
        if not repo_dir.is_dir():
            raise HTTPException(404, f"workspace not found: {workspace_key}")
        remote = await asyncio.to_thread(
            _origin_remote_auth,
            repo_dir,
            repo,
            _resolve_token(settings),
            push=True,
            slot_uid=slot_uid,
        )
        try:
            result = await _run_git_op(
                git_push,
                repo_dir,
                branch=branch,
                expected_head=expected_head,
                token=remote.token,
                remote_url=remote.url,
                auth_url=remote.auth_url,
                slot_uid=slot_uid,
            )
        except HeadDriftError as exc:
            return _git_error_response(exc, head_drift=True)
        except GitCommandError as exc:
            return _git_error_response(exc)
        return JSONResponse({"head": result.head, "branch": result.branch})

    # Expose for tests
    app.state.workspace_key_fn = compute_workspace_key  # type: ignore[attr-defined]
    return app


__all__ = ["create_proxy_app"]
