"""Structural protocol shared by `GitHubClient` and `GitHubProxyClient`.

Callers (worker, host tools, tasks, server, CLI) reference `GitHubBackend`
so they accept either the direct PAT-bearing REST client or the HMAC-RPC
proxy client without changing signatures. Both impls return the same typed
dataclasses (`IssueInfo`, `RepoInfo`, …) defined in `github_client`.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

from robomp.github_client import (
    CommentInfo,
    IssueIndexEntry,
    IssueInfo,
    IssueSummary,
    PullRequestFileInfo,
    PullRequestInfo,
    PullRequestReviewInfo,
    ReactionInfo,
    ReleaseInfo,
    RepoInfo,
    ReviewCommentInfo,
    WorkflowJobInfo,
    WorkflowRunInfo,
)


class GitHubBackend(Protocol):
    """Methods every caller in roboomp uses against GitHub."""

    # ---- reads ----
    async def get_repo(self, repo: str) -> RepoInfo: ...

    async def list_workflow_runs(self, repo: str, *, head_sha: str) -> list[WorkflowRunInfo]: ...
    async def list_workflow_jobs(self, repo: str, run_id: int) -> list[WorkflowJobInfo]: ...
    async def get_job_log_tail(self, repo: str, job_id: int, *, tail_lines: int = 200) -> str: ...
    async def get_tag_sha(self, repo: str, tag: str) -> str | None: ...
    async def get_release_by_tag(self, repo: str, tag: str) -> ReleaseInfo | None: ...

    async def get_issue(self, repo: str, number: int) -> IssueInfo: ...

    async def list_closing_pull_requests(self, repo: str, number: int) -> tuple[int, ...]: ...

    async def get_pull_request(self, repo: str, number: int) -> PullRequestInfo: ...

    async def list_pr_files(self, repo: str, pr_number: int) -> list[PullRequestFileInfo]: ...

    async def list_issues(
        self,
        repo: str,
        *,
        state: str = "open",
        limit: int = 30,
    ) -> list[IssueSummary]: ...

    async def search_issues(self, repo: str, query: str, *, limit: int = 10) -> list[IssueSummary]: ...
    async def list_issue_index_entries(
        self,
        repo: str,
        *,
        since: str | None = None,
        page: int = 1,
        per_page: int = 100,
    ) -> list[IssueIndexEntry]: ...

    async def list_comments(self, repo: str, number: int) -> list[CommentInfo]: ...

    async def list_review_comments(self, repo: str, pr_number: int) -> list[ReviewCommentInfo]: ...

    async def get_review_comment(self, repo: str, comment_id: int) -> ReviewCommentInfo: ...

    async def list_pr_reviews(self, repo: str, pr_number: int) -> list[PullRequestReviewInfo]: ...

    async def get_authenticated_login(self) -> str: ...

    # ---- writes ----
    async def post_comment(self, repo: str, number: int, body: str) -> CommentInfo: ...

    async def open_pull_request(
        self,
        *,
        repo: str,
        head: str,
        base: str,
        title: str,
        body: str,
        draft: bool = False,
        maintainer_can_modify: bool = True,
    ) -> PullRequestInfo: ...

    async def request_reviewers(
        self,
        *,
        repo: str,
        pr_number: int,
        reviewers: list[str] | None = None,
        team_reviewers: list[str] | None = None,
    ) -> None: ...

    async def add_issue_labels(self, repo: str, number: int, labels: list[str]) -> tuple[str, ...]: ...
    async def remove_issue_label(self, repo: str, number: int, label: str) -> None: ...

    async def submit_pr_review(
        self,
        *,
        repo: str,
        pr_number: int,
        body: str,
        event: str,
        comments: list[Mapping[str, Any]],
        commit_id: str | None = None,
    ) -> PullRequestReviewInfo: ...

    async def add_assignees(self, repo: str, number: int, assignees: list[str]) -> None: ...

    async def list_comment_reactions(self, repo: str, comment_id: int) -> tuple[ReactionInfo, ...]: ...

    async def close_issue(self, repo: str, number: int, *, reason: str = "completed") -> None: ...


__all__ = ["GitHubBackend"]
