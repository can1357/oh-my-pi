"""Task entry points dispatched off the durable event queue."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from robomp import persona
from robomp.config import Settings
from robomp.db import Database, IssueRow, IssueState, issue_key
from robomp.github_backend import GitHubBackend
from robomp.github_client import (
    CommentInfo,
    GitHubError,
    IssueInfo,
    PullRequestInfo,
    RepoInfo,
    parse_issue_payload,
)
from robomp.sandbox import GitTransport, SandboxManager
from robomp.worker import DirectiveInfo, TaskInputs, ThreadMessage, run_task

log = logging.getLogger(__name__)


def _comment_from_payload(payload: Mapping[str, Any]) -> CommentInfo:
    c = payload.get("comment") or {}
    user = c.get("user") or {}
    return CommentInfo(
        id=int(c.get("id") or 0),
        author=str(user.get("login") or ""),
        body=str(c.get("body") or ""),
        created_at=str(c.get("created_at") or ""),
    )


def _directive_from_payload(payload: Mapping[str, Any]) -> DirectiveInfo | None:
    """Extract the maintainer directive the webhook handler stashed, if any."""
    raw = payload.get("_robomp_directive")
    if not isinstance(raw, Mapping):
        return None
    body = raw.get("body")
    author = raw.get("author")
    if not isinstance(body, str) or not body.strip():
        return None
    if not isinstance(author, str) or not author.strip():
        return None
    pragmas: list[tuple[str, str]] = []
    raw_pragmas = raw.get("pragmas")
    if isinstance(raw_pragmas, list):
        for entry in raw_pragmas:
            if isinstance(entry, (list, tuple)) and len(entry) == 2:
                k, v = entry
                if isinstance(k, str) and isinstance(v, str):
                    pragmas.append((k, v))
    return DirectiveInfo(
        body=body,
        author=author,
        pragmas=tuple(pragmas),
        authorizes_impl=bool(raw.get("authorizes_impl")),
    )


async def _fetch_thread(
    github: GitHubBackend,
    repo: str,
    number: int,
    *,
    is_pr: bool,
) -> tuple[ThreadMessage, ...]:
    """Pull the full conversation thread (body + comments + reviews) for `number`.

    Best-effort: any sub-fetch that fails is logged + dropped so a stale
    review-comments endpoint doesn't block the directive from running.
    """
    messages: list[ThreadMessage] = []

    # 1. The issue / PR body itself. Use get_issue (issues endpoint also
    #    returns PRs in GitHub's data model).
    try:
        item = await github.get_issue(repo, number)
        if item.body and item.body.strip():
            messages.append(
                ThreadMessage(
                    kind="pr_body" if is_pr else "issue_body",
                    author=item.author or "",
                    body=item.body,
                    created_at="",  # not exposed by IssueInfo
                )
            )
    except GitHubError as exc:
        log.warning("thread body fetch failed", extra={"repo": repo, "n": number, "err": str(exc)})

    # 2. Conversation comments (issue OR PR conversation).
    try:
        for c in await github.list_comments(repo, number):
            messages.append(
                ThreadMessage(
                    kind="comment",
                    author=c.author,
                    body=c.body,
                    created_at=c.created_at,
                )
            )
    except GitHubError as exc:
        log.warning("thread comments fetch failed", extra={"err": str(exc)})

    if is_pr:
        # 3. Inline review comments (attached to a path:line).
        try:
            for r in await github.list_review_comments(repo, number):
                messages.append(
                    ThreadMessage(
                        kind="review_comment",
                        author=r.author,
                        body=r.body,
                        created_at=r.created_at,
                        path=r.path,
                        line=r.line,
                    )
                )
        except GitHubError as exc:
            log.warning("thread review-comments fetch failed", extra={"err": str(exc)})
        # 4. Top-level reviews (summaries).
        try:
            for rv in await github.list_pr_reviews(repo, number):
                messages.append(
                    ThreadMessage(
                        kind="review",
                        author=rv.author,
                        body=rv.body,
                        created_at=rv.submitted_at,
                        state=rv.state,
                    )
                )
        except GitHubError as exc:
            log.warning("thread reviews fetch failed", extra={"err": str(exc)})

    # ISO 8601 strings sort chronologically. Body has no timestamp so it
    # sorts first (empty string < any "2026-…" string).
    messages.sort(key=lambda m: m.created_at or "")
    return tuple(messages)


async def _attach_thread(
    github: GitHubBackend,
    directive: DirectiveInfo | None,
    repo: str,
    number: int,
    *,
    is_pr: bool,
) -> DirectiveInfo | None:
    """Hydrate a directive with the live conversation thread (or no-op if None)."""
    if directive is None:
        return None
    thread = await _fetch_thread(github, repo, number, is_pr=is_pr)
    return DirectiveInfo(
        body=directive.body,
        author=directive.author,
        thread=thread,
        pragmas=directive.pragmas,
        authorizes_impl=directive.authorizes_impl,
    )


async def _resolve_repo_and_issue(
    github: GitHubBackend,
    payload: Mapping[str, Any],
) -> tuple[RepoInfo, IssueInfo]:
    repo, issue = parse_issue_payload(payload)
    if not issue.body:
        # Webhook payloads sometimes omit body; refetch to be safe.
        try:
            issue = await github.get_issue(repo.full_name, issue.number)
        except GitHubError as exc:
            log.warning("issue refetch failed", extra={"err": str(exc)})
    return repo, issue


async def _resolve_issue_row_for_pr(
    *,
    db: Database,
    github: GitHubBackend,
    repo_full: str,
    pr_number: int,
) -> tuple[IssueRow | None, PullRequestInfo | None]:
    """Find the originating issue row for a PR, repairing stale mappings when possible."""
    issue_row = db.find_issue_by_pr(repo_full, pr_number)
    pr_info: PullRequestInfo | None = None
    if issue_row is None or issue_row.branch is None:
        try:
            pr_info = await github.get_pull_request(repo_full, pr_number)
        except GitHubError as exc:
            log.warning("PR metadata fetch failed", extra={"repo": repo_full, "pr": pr_number, "err": str(exc)})
            return issue_row, None

    if issue_row is None and pr_info is not None and pr_info.head_ref:
        issue_row = db.find_issue_by_branch(repo_full, pr_info.head_ref)
        if issue_row is not None:
            db.set_issue_pr(issue_row.key, pr_number)
            issue_row = db.get_issue(issue_row.key) or issue_row
    elif issue_row is not None and issue_row.branch is None and pr_info is not None and pr_info.head_ref:
        db.set_issue_branch(issue_row.key, pr_info.head_ref)
        issue_row = db.get_issue(issue_row.key) or issue_row
    return issue_row, pr_info


def _can_handle_pr_directly(*, settings: Settings, repo_full: str, pr: PullRequestInfo) -> bool:
    """Only bot-owned same-repo PR branches are safe to amend directly."""
    if not pr.head_ref:
        log.info("skip: PR has no head ref", extra={"repo": repo_full, "pr": pr.number})
        return False
    if pr.author.lower() != settings.bot_login.lower():
        log.info(
            "skip: unmapped PR not authored by bot",
            extra={"repo": repo_full, "pr": pr.number, "author": pr.author},
        )
        return False
    if pr.head_repo.lower() != repo_full.lower():
        log.info(
            "skip: unmapped PR head is not this repo",
            extra={"repo": repo_full, "pr": pr.number, "head_repo": pr.head_repo},
        )
        return False
    return True


async def triage_issue(
    *,
    settings: Settings,
    db: Database,
    github: GitHubBackend,
    sandbox: SandboxManager,
    git_transport: GitTransport,
    payload: Mapping[str, Any],
    delivery_id: str,
    attempts: int = 0,
    slot_uid: int | None = None,
) -> None:
    repo, issue = await _resolve_repo_and_issue(github, payload)
    if issue.is_pull_request:
        log.info("skip: triage on PR-like issue", extra={"repo": repo.full_name, "n": issue.number})
        return
    key = issue_key(repo.full_name, issue.number)
    if db.get_issue(key) is None:
        # First-time triage: bail if a PR (human or another bot) already
        # claims to close this issue via Closes/Fixes/Resolves syntax or
        # the Development panel. We never replay closing-PR detection on
        # a follow-up because by then the bot has already committed
        # resources (workspace, omp session) to this issue.
        try:
            closing_prs = await github.list_closing_pull_requests(repo.full_name, issue.number)
        except GitHubError as exc:
            # Fail-open: a transient timeline fetch failure shouldn't
            # block legitimate triage. Worst case we do redundant work.
            log.warning(
                "closing-PR check failed; proceeding with triage",
                extra={"key": key, "err": str(exc)},
            )
            closing_prs = ()
        if closing_prs:
            log.info(
                "skip: issue already covered by an open PR",
                extra={"key": key, "prs": list(closing_prs)},
            )
            return
    db.upsert_issue(key=key, repo=repo.full_name, number=issue.number, state="reproducing")
    clone_url = repo.clone_url
    workspace = sandbox.ensure_workspace(
        repo=repo.full_name,
        number=issue.number,
        title=issue.title,
        clone_url=clone_url,
        default_branch=repo.default_branch,
        author_name=settings.resolved_author_name,
        author_email=settings.git_author_email,
        slot_uid=slot_uid,
    )
    db.upsert_issue(
        key=key,
        repo=repo.full_name,
        number=issue.number,
        state="reproducing",
        branch=workspace.branch,
        session_dir=str(workspace.session_dir),
    )
    inputs = TaskInputs(
        settings=settings,
        db=db,
        github=github,
        git_transport=git_transport,
        repo=repo,
        issue=issue,
        workspace=workspace,
        delivery_id=delivery_id,
        attempts=attempts,
        slot_uid=slot_uid,
        natives_cache=sandbox.natives_cache,
    )
    await run_task(task_kind="triage_issue", inputs=inputs)


async def review_pr(
    *,
    settings: Settings,
    db: Database,
    github: GitHubBackend,
    sandbox: SandboxManager,
    git_transport: GitTransport,
    payload: Mapping[str, Any],
    delivery_id: str,
    attempts: int = 0,
    slot_uid: int | None = None,
) -> None:
    pr_node = payload.get("pull_request") or {}
    pr_number = int(pr_node.get("number") or 0)
    repo_payload = payload.get("repository") or {}
    repo_full = str(repo_payload.get("full_name") or "")
    if pr_number <= 0 or not repo_full:
        log.info("skip: review_pr missing repo/number")
        return
    try:
        repo = await github.get_repo(repo_full)
        issue = await github.get_issue(repo_full, pr_number)
        pr = await github.get_pull_request(repo_full, pr_number)
    except GitHubError as exc:
        log.warning("review_pr fetch failed", extra={"repo": repo_full, "pr": pr_number, "err": str(exc)})
        return

    labels = {label.lower() for label in issue.labels}
    key = issue_key(repo.full_name, pr_number)
    review_labeled = "triaged" in labels or any(label.startswith("review:") for label in labels)
    if db.has_successful_tool_call(key, "submit_pr_review"):
        log.info("skip: PR review already submitted", extra={"repo": repo_full, "pr": pr_number})
        return
    if review_labeled:
        log.info(
            "review labels present without submitted review; retrying",
            extra={"repo": repo_full, "pr": pr_number, "labels": sorted(labels)},
        )

    db.upsert_issue(key=key, repo=repo.full_name, number=pr_number, state="reviewing", pr_number=pr_number)
    workspace = sandbox.ensure_workspace(
        repo=repo.full_name,
        number=pr_number,
        title=issue.title,
        clone_url=repo.clone_url,
        default_branch=repo.default_branch,
        pr_head=pr_number,
        author_name=settings.resolved_author_name,
        author_email=settings.git_author_email,
        slot_uid=slot_uid,
    )
    db.upsert_issue(
        key=key,
        repo=repo.full_name,
        number=pr_number,
        state="reviewing",
        branch=workspace.branch,
        session_dir=str(workspace.session_dir),
        pr_number=pr_number,
    )
    inputs = TaskInputs(
        settings=settings,
        db=db,
        github=github,
        git_transport=git_transport,
        repo=repo,
        issue=issue,
        workspace=workspace,
        delivery_id=delivery_id,
        attempts=attempts,
        slot_uid=slot_uid,
        natives_cache=sandbox.natives_cache,
    )
    await run_task(task_kind="review_pr", inputs=inputs, pr_number=pr_number, pr=pr)
    return


async def handle_comment(
    *,
    settings: Settings,
    db: Database,
    github: GitHubBackend,
    sandbox: SandboxManager,
    git_transport: GitTransport,
    payload: Mapping[str, Any],
    delivery_id: str,
    attempts: int = 0,
    slot_uid: int | None = None,
) -> None:
    repo, issue = await _resolve_repo_and_issue(github, payload)
    key = issue_key(repo.full_name, issue.number)
    existing = db.get_issue(key)
    directive = _directive_from_payload(payload)
    comment = _comment_from_payload(payload)
    clone_url = repo.clone_url

    if existing is None:
        if directive is None:
            log.info("skip: comment on unknown issue", extra={"key": key})
            return
        # Maintainer summon on an untriaged issue: bootstrap a row + workspace,
        # then route through triage-with-directive so the agent classifies
        # first and executes the directive in the same RPC turn.
        log.info("directive bootstrap", extra={"key": key, "author": directive.author})
        db.upsert_issue(key=key, repo=repo.full_name, number=issue.number, state="reproducing")
        workspace = sandbox.ensure_workspace(
            repo=repo.full_name,
            number=issue.number,
            title=issue.title,
            clone_url=clone_url,
            default_branch=repo.default_branch,
            author_name=settings.resolved_author_name,
            author_email=settings.git_author_email,
            slot_uid=slot_uid,
        )
        db.upsert_issue(
            key=key,
            repo=repo.full_name,
            number=issue.number,
            state="reproducing",
            branch=workspace.branch,
            session_dir=str(workspace.session_dir),
        )
        inputs = TaskInputs(
            settings=settings,
            db=db,
            github=github,
            git_transport=git_transport,
            repo=repo,
            issue=issue,
            workspace=workspace,
            delivery_id=delivery_id,
            attempts=attempts,
            slot_uid=slot_uid,
            natives_cache=sandbox.natives_cache,
        )
        directive = await _attach_thread(github, directive, repo.full_name, issue.number, is_pr=False)
        await run_task(task_kind="triage_issue", inputs=inputs, directive=directive)
        return

    if existing.state in ("merged", "closed", "abandoned"):
        if directive is None:
            log.info("skip: comment on finalized issue", extra={"key": key, "state": existing.state})
            try:
                await github.post_comment(
                    repo.full_name,
                    issue.number,
                    persona.finalized_issue_comment(),
                )
            except GitHubError as exc:
                log.warning("ack comment failed", extra={"err": str(exc)})
            return
        # Maintainer reopen: tear down stale workspace, reset state, branch
        # afresh from default. The old branch may have been merged/deleted.
        log.info("directive reopen", extra={"key": key, "from_state": existing.state, "author": directive.author})
        sandbox.remove_workspace(repo=repo.full_name, number=issue.number)
        db.upsert_issue(key=key, repo=repo.full_name, number=issue.number, state="reproducing")
        workspace = sandbox.ensure_workspace(
            repo=repo.full_name,
            number=issue.number,
            title=issue.title,
            clone_url=clone_url,
            default_branch=repo.default_branch,
            author_name=settings.resolved_author_name,
            author_email=settings.git_author_email,
            slot_uid=slot_uid,
        )
        db.upsert_issue(
            key=key,
            repo=repo.full_name,
            number=issue.number,
            state="reproducing",
            branch=workspace.branch,
            session_dir=str(workspace.session_dir),
        )
        inputs = TaskInputs(
            settings=settings,
            db=db,
            github=github,
            git_transport=git_transport,
            repo=repo,
            issue=issue,
            workspace=workspace,
            delivery_id=delivery_id,
            attempts=attempts,
            slot_uid=slot_uid,
            natives_cache=sandbox.natives_cache,
        )
        directive = await _attach_thread(github, directive, repo.full_name, issue.number, is_pr=False)
        await run_task(task_kind="handle_comment", inputs=inputs, comment=comment, directive=directive)
        return

    workspace = sandbox.ensure_workspace(
        repo=repo.full_name,
        number=issue.number,
        title=issue.title,
        clone_url=clone_url,
        default_branch=repo.default_branch,
        existing_branch=existing.branch,
        author_name=settings.resolved_author_name,
        author_email=settings.git_author_email,
        slot_uid=slot_uid,
    )
    inputs = TaskInputs(
        settings=settings,
        db=db,
        github=github,
        git_transport=git_transport,
        repo=repo,
        issue=issue,
        workspace=workspace,
        delivery_id=delivery_id,
        attempts=attempts,
        slot_uid=slot_uid,
        natives_cache=sandbox.natives_cache,
    )
    directive = await _attach_thread(github, directive, repo.full_name, issue.number, is_pr=False)
    await run_task(task_kind="handle_comment", inputs=inputs, comment=comment, directive=directive)


async def handle_review(
    *,
    settings: Settings,
    db: Database,
    github: GitHubBackend,
    sandbox: SandboxManager,
    git_transport: GitTransport,
    payload: Mapping[str, Any],
    delivery_id: str,
    attempts: int = 0,
    slot_uid: int | None = None,
) -> None:
    pr = payload.get("pull_request") or {}
    pr_number = int(pr.get("number") or 0)
    if pr_number <= 0:
        log.info("skip: review without PR number")
        return
    repo_payload = payload.get("repository") or {}
    repo_full = str(repo_payload.get("full_name") or "")
    if not repo_full:
        log.info("skip: review without repo")
        return
    issue_row, pr_info = await _resolve_issue_row_for_pr(
        db=db,
        github=github,
        repo_full=repo_full,
        pr_number=pr_number,
    )
    if issue_row is None:
        if pr_info is None or not _can_handle_pr_directly(settings=settings, repo_full=repo_full, pr=pr_info):
            return
        issue_number = pr_number
        existing_branch = pr_info.head_ref
    else:
        if issue_row.branch is None:
            log.info("skip: review PR missing branch mapping", extra={"repo": repo_full, "pr": pr_number})
            return
        issue_number = issue_row.number
        existing_branch = issue_row.branch
    try:
        repo = await github.get_repo(repo_full)
        issue = await github.get_issue(repo_full, issue_number)
    except GitHubError as exc:
        log.warning("review fetch failed", extra={"err": str(exc)})
        return
    clone_url = repo.clone_url
    workspace = sandbox.ensure_workspace(
        repo=repo.full_name,
        number=issue.number,
        title=issue.title,
        clone_url=clone_url,
        default_branch=repo.default_branch,
        existing_branch=existing_branch,
        author_name=settings.resolved_author_name,
        author_email=settings.git_author_email,
        slot_uid=slot_uid,
    )
    if issue_row is None:
        db.upsert_issue(
            key=issue_key(repo_full, pr_number),
            repo=repo_full,
            number=pr_number,
            state="opened",
            branch=workspace.branch,
            session_dir=str(workspace.session_dir),
            pr_number=pr_number,
        )
    comment = payload.get("comment") or {}
    user = comment.get("user") or {}
    review_payload = {
        "author": str(user.get("login") or ""),
        "body": str(comment.get("body") or ""),
        "path": str(comment.get("path") or ""),
        "line": comment.get("line"),
        "start_line": comment.get("start_line"),
        "original_line": comment.get("original_line"),
    }
    inputs = TaskInputs(
        settings=settings,
        db=db,
        github=github,
        git_transport=git_transport,
        repo=repo,
        issue=issue,
        workspace=workspace,
        delivery_id=delivery_id,
        attempts=attempts,
        slot_uid=slot_uid,
        natives_cache=sandbox.natives_cache,
    )
    await run_task(
        task_kind="handle_review",
        inputs=inputs,
        pr_number=pr_number,
        review_payload=review_payload,
    )


async def handle_pr_conversation(
    *,
    settings: Settings,
    db: Database,
    github: GitHubBackend,
    sandbox: SandboxManager,
    git_transport: GitTransport,
    payload: Mapping[str, Any],
    delivery_id: str,
    attempts: int = 0,
    slot_uid: int | None = None,
) -> None:
    """Handle a regular (non-review) comment on a bot-authored PR.

    The `issue_comment.created` payload's `issue.number` IS the PR number on
    these events; we resolve back to the originating issue via the DB and
    drive `handle_comment` so the agent works on the same session/branch.
    """
    repo_payload = payload.get("repository") or {}
    repo_full = str(repo_payload.get("full_name") or "")
    issue_payload = payload.get("issue") or {}
    pr_number = issue_payload.get("number")
    if not repo_full or not isinstance(pr_number, int):
        log.info("skip: pr-conversation missing repo/number")
        return
    issue_row, pr_info = await _resolve_issue_row_for_pr(
        db=db,
        github=github,
        repo_full=repo_full,
        pr_number=pr_number,
    )
    if issue_row is None:
        if pr_info is None or not _can_handle_pr_directly(settings=settings, repo_full=repo_full, pr=pr_info):
            return
    directive = _directive_from_payload(payload)
    if issue_row is not None and issue_row.state == "reviewing":
        log.info("skip: incoming PR conversation unsupported", extra={"key": issue_row.key, "pr": pr_number})
        return
    if issue_row is not None and issue_row.state in ("merged", "closed", "abandoned"):
        if directive is None:
            log.info("skip: pr-conversation on finalized issue", extra={"key": issue_row.key, "state": issue_row.state})
            # Still acknowledge so the reporter knows the bot saw it.
            try:
                await github.post_comment(
                    repo_full,
                    pr_number,
                    persona.finalized_pr_comment(),
                )
            except GitHubError as exc:
                log.warning("ack comment failed", extra={"err": str(exc)})
            return
        # Maintainer reopen on a finalized PR: tear down stale workspace and
        # branch afresh on the originating issue. The agent will open a new
        # PR if code changes ship.
        log.info(
            "directive reopen (pr)",
            extra={"key": issue_row.key, "from_state": issue_row.state, "author": directive.author},
        )
        sandbox.remove_workspace(repo=issue_row.repo, number=issue_row.number)
        db.upsert_issue(key=issue_row.key, repo=issue_row.repo, number=issue_row.number, state="reproducing")
        issue_row = db.get_issue(issue_row.key) or issue_row
    # Bare @mention with no request body — the route stashes an empty
    # _robomp_directive; _directive_from_payload rejects it but the key
    # being present tells us a mention happened. Reply cheaply without omp.
    if directive is None and payload.get("_robomp_directive") is not None:
        comment = _comment_from_payload(payload)
        log.info(
            "bare mention, prompting for request", extra={"repo": repo_full, "pr": pr_number, "author": comment.author}
        )
        try:
            await github.post_comment(repo_full, pr_number, persona.bare_mention_reply())
        except GitHubError as exc:
            log.warning("bare mention reply failed", extra={"err": str(exc)})
        return
    issue_number = issue_row.number if issue_row is not None else pr_number
    try:
        repo = await github.get_repo(repo_full)
        issue = await github.get_issue(repo_full, issue_number)
    except GitHubError as exc:
        log.warning("pr-conversation fetch failed", extra={"err": str(exc)})
        return
    clone_url = repo.clone_url
    if issue_row is None:
        assert pr_info is not None
        existing_branch = pr_info.head_ref
    else:
        # On a reopen the prior branch is stale (merged/deleted), so branch from
        # default; otherwise reuse the existing branch.
        existing_branch = (
            None if directive and issue_row.state == "reproducing" and issue_row.branch is None else issue_row.branch
        )
        if existing_branch is None and not (directive and issue_row.state == "reproducing"):
            log.info("skip: pr-conversation PR missing branch mapping", extra={"repo": repo_full, "pr": pr_number})
            return
    workspace = sandbox.ensure_workspace(
        repo=repo.full_name,
        number=issue.number,
        title=issue.title,
        clone_url=clone_url,
        default_branch=repo.default_branch,
        existing_branch=existing_branch,
        author_name=settings.resolved_author_name,
        author_email=settings.git_author_email,
        slot_uid=slot_uid,
    )
    if issue_row is None:
        db.upsert_issue(
            key=issue_key(repo_full, pr_number),
            repo=repo_full,
            number=pr_number,
            state="opened",
            branch=workspace.branch,
            session_dir=str(workspace.session_dir),
            pr_number=pr_number,
        )
    elif directive is not None and (issue_row.branch is None or issue_row.branch != workspace.branch):
        db.upsert_issue(
            key=issue_row.key,
            repo=issue_row.repo,
            number=issue_row.number,
            state="reproducing",
            branch=workspace.branch,
            session_dir=str(workspace.session_dir),
        )
    comment = _comment_from_payload(payload)
    inputs = TaskInputs(
        settings=settings,
        db=db,
        github=github,
        git_transport=git_transport,
        repo=repo,
        issue=issue,
        workspace=workspace,
        delivery_id=delivery_id,
        attempts=attempts,
        slot_uid=slot_uid,
        natives_cache=sandbox.natives_cache,
    )
    thread: tuple[ThreadMessage, ...] = ()
    if directive is None:
        thread = await _fetch_thread(github, repo_full, pr_number, is_pr=True)
    else:
        directive = await _attach_thread(github, directive, repo_full, pr_number, is_pr=True)
    await run_task(
        task_kind="handle_comment",
        inputs=inputs,
        comment=comment,
        pr_number=pr_number,
        directive=directive,
        thread=thread,
    )


async def cleanup_workspace(
    *,
    settings: Settings,
    db: Database,
    sandbox: SandboxManager,
    payload: Mapping[str, Any],
    target_state: IssueState,
) -> None:
    """Tear down the workspace for a finished issue/PR."""
    repo_payload = payload.get("repository") or {}
    repo_full = str(repo_payload.get("full_name") or "")
    if not repo_full:
        return
    issue_payload = payload.get("issue") or payload.get("pull_request") or {}
    number = issue_payload.get("number")
    if not isinstance(number, int):
        return
    # If this is a PR close, map to the originating issue.
    issue_row: IssueRow | None
    if "pull_request" in payload:
        issue_row = db.find_issue_by_pr(repo_full, number)
    else:
        issue_row = db.get_issue(issue_key(repo_full, number))
    if issue_row is None:
        return
    sandbox.remove_workspace(repo=issue_row.repo, number=issue_row.number)
    db.set_issue_state(issue_row.key, target_state)
    log.info("cleanup", extra={"key": issue_row.key, "state": target_state})


__all__ = [
    "cleanup_workspace",
    "handle_comment",
    "handle_pr_conversation",
    "handle_review",
    "review_pr",
    "triage_issue",
]
