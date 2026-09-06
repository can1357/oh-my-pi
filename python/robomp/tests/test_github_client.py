"""GitHub REST client tests against httpx.MockTransport."""

from __future__ import annotations

import asyncio
import json
import logging

import httpx
import pytest

from robomp.github_client import _MAX_LABEL_PAGES, GitHubClient, GitHubError


def _run_async(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_4xx_maps_to_github_error_with_message() -> None:
    transport = httpx.MockTransport(lambda req: httpx.Response(404, json={"message": "Not Found"}))
    client = GitHubClient("tok", transport=transport)
    with pytest.raises(GitHubError) as exc:
        asyncio.new_event_loop().run_until_complete(client.get_repo("o/r"))
    assert exc.value.status == 404
    assert "Not Found" in str(exc.value)


def test_rate_limit_retry_after_parsed() -> None:
    transport = httpx.MockTransport(
        lambda req: httpx.Response(
            403,
            json={"message": "rate limited"},
            headers={"retry-after": "42"},
        )
    )
    client = GitHubClient("tok", transport=transport)
    with pytest.raises(GitHubError) as exc:
        asyncio.new_event_loop().run_until_complete(client.get_repo("o/r"))
    assert exc.value.retry_after == 42.0


def test_redirect_without_follow_raises_github_error() -> None:
    """If a moved repo returns 301 and the redirect target is unreachable,
    we must raise a clean GitHubError instead of parsing the response body."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        # First request: simulate a 301 redirect that the client cannot follow
        # because the new location resolves to a 410 Gone.
        if len(calls) == 1:
            return httpx.Response(
                301,
                headers={"location": "https://api.github.com/repositories/12345"},
            )
        return httpx.Response(410, json={"message": "Gone"})

    transport = httpx.MockTransport(handler)
    client = GitHubClient("tok", transport=transport)
    with pytest.raises(GitHubError) as exc:
        asyncio.new_event_loop().run_until_complete(client.get_repo("old-owner/old-repo"))
    # Either we end up at 410 after following, or we surface the redirect itself
    # — both are GitHubError, not an internal exception.
    assert exc.value.status in (301, 410)


def test_transient_5xx_retries_get_but_not_post(monkeypatch: pytest.MonkeyPatch) -> None:
    """A transient upstream 500 must be replayed for idempotent GETs (the
    manual-triage fetch path) and surfaced immediately for non-idempotent
    POSTs, where a blind replay could double-apply a write."""
    monkeypatch.setattr(GitHubClient, "_TRANSIENT_RETRY_DELAYS", (0.01, 0.01))
    get_calls = 0
    post_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal get_calls, post_calls
        if request.method == "POST":
            post_calls += 1
            return httpx.Response(500, json={"message": "boom"})
        get_calls += 1
        if get_calls == 1:
            return httpx.Response(500, json={"message": "boom"})
        return httpx.Response(200, json={"ok": True})

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    assert _run_async(client.request("GET", "/x")) == {"ok": True}
    assert get_calls == 2

    with pytest.raises(GitHubError) as exc:
        _run_async(client.request("POST", "/x", json={}))
    assert exc.value.status == 500
    assert post_calls == 1


def test_redirect_target_succeeds_when_followable() -> None:
    """A 301 → 200 chain should resolve to the followed payload."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/old/repo":
            return httpx.Response(
                301,
                headers={"location": "https://api.github.com/repos/new/repo"},
            )
        return httpx.Response(
            200,
            json={
                "full_name": "new/repo",
                "default_branch": "main",
                "clone_url": "https://github.com/new/repo.git",
                "private": False,
            },
        )

    transport = httpx.MockTransport(handler)
    client = GitHubClient("tok", transport=transport)
    repo = asyncio.new_event_loop().run_until_complete(client.get_repo("old/repo"))
    assert repo.full_name == "new/repo"


def test_get_pull_request_parses_head_repo_and_author() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/octo/widget/pulls/9"
        return httpx.Response(
            200,
            json={
                "number": 9,
                "html_url": "https://github.com/octo/widget/pull/9",
                "head": {
                    "ref": "farm/abc12345/fix",
                    "sha": "abc1234567890123456789012345678901234567",
                    "repo": {"full_name": "octo/widget"},
                },
                "base": {"ref": "main"},
                "state": "open",
                "user": {"login": "robomp-bot"},
            },
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    pr = _run_async(client.get_pull_request("octo/widget", 9))
    assert pr.head_ref == "farm/abc12345/fix"
    assert pr.head_sha == "abc1234567890123456789012345678901234567"
    assert pr.head_repo == "octo/widget"
    assert pr.author == "robomp-bot"


def test_get_pull_request_parses_title_and_body() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/octo/widget/pulls/9"
        return httpx.Response(
            200,
            json={
                "number": 9,
                "html_url": "https://github.com/octo/widget/pull/9",
                "title": "Fix crash",
                "body": "Fixes #1",
                "head": {"ref": "fix", "repo": {"full_name": "fork/widget"}},
                "base": {"ref": "main"},
                "state": "open",
                "user": {"login": "alice"},
            },
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    pr = _run_async(client.get_pull_request("octo/widget", 9))
    assert pr.title == "Fix crash"
    assert pr.body == "Fixes #1"


def test_list_pr_files_parses_changed_file_summary() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/octo/widget/pulls/9/files"
        assert request.url.params.get("per_page") == "100"
        return httpx.Response(
            200,
            json=[
                {
                    "filename": "src/app.py",
                    "status": "modified",
                    "additions": 5,
                    "deletions": 2,
                    "patch": "@@ -8,3 +8,5 @@\n ctx\n+added\n ctx2",
                }
            ],
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    files = _run_async(client.list_pr_files("octo/widget", 9))
    assert len(files) == 1
    assert files[0].path == "src/app.py"
    assert files[0].additions == 5
    assert files[0].deletions == 2
    assert files[0].patch.startswith("@@ -8,3 +8,5")


def test_list_pr_files_defaults_missing_patch_to_empty() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/octo/widget/pulls/9/files"
        return httpx.Response(
            200,
            json=[{"filename": "src/app.py", "status": "modified", "additions": 5, "deletions": 2}],
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    files = _run_async(client.list_pr_files("octo/widget", 9))
    assert files[0].patch == ""


def test_list_pr_files_paginates_past_first_page() -> None:
    seen_pages: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/octo/widget/pulls/9/files"
        page = request.url.params.get("page")
        seen_pages.append(page)
        if page == "1":
            return httpx.Response(
                200,
                json=[
                    {
                        "filename": f"src/file-{idx}.py",
                        "status": "modified",
                        "additions": 1,
                        "deletions": 0,
                    }
                    for idx in range(100)
                ],
            )
        assert page == "2"
        return httpx.Response(
            200,
            json=[{"filename": "src/final.py", "status": "added", "additions": 2, "deletions": 0}],
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    files = _run_async(client.list_pr_files("octo/widget", 9))
    assert seen_pages == ["1", "2"]
    assert len(files) == 101
    assert files[-1].path == "src/final.py"


def test_submit_pr_review_posts_comment_event_and_inline_comments() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "id": 44,
                "user": {"login": "robomp-bot"},
                "body": "summary",
                "state": "COMMENTED",
                "submitted_at": "t",
            },
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    review = _run_async(
        client.submit_pr_review(
            repo="octo/widget",
            pr_number=9,
            body="summary",
            event="COMMENT",
            comments=[{"path": "src/app.py", "line": 12, "side": "RIGHT", "body": "finding"}],
        )
    )
    assert review.id == 44
    assert captured["path"] == "/repos/octo/widget/pulls/9/reviews"
    assert captured["body"] == {
        "body": "summary",
        "event": "COMMENT",
        "comments": [{"path": "src/app.py", "line": 12, "side": "RIGHT", "body": "finding"}],
    }


def test_submit_pr_review_forgejo_uses_new_position_payload() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "id": 44,
                "user": {"login": "robomp-bot"},
                "body": "summary",
                "state": "COMMENTED",
                "submitted_at": "t",
            },
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    review = _run_async(
        client.submit_pr_review(
            repo="octo/widget",
            pr_number=9,
            body="summary",
            event="COMMENT",
            comments=[
                {"path": "src/app.py", "line": 12, "side": "RIGHT", "body": "finding"},
                {"path": "src/old.py", "line": 5, "side": "LEFT", "body": "removed-line finding"},
            ],
        )
    )
    assert review.id == 44
    assert captured["path"] == "/repos/octo/widget/pulls/9/reviews"
    assert captured["body"] == {
        "body": "summary",
        "event": "COMMENT",
        "comments": [
            {"path": "src/app.py", "body": "finding", "new_position": 12},
            {"path": "src/old.py", "body": "removed-line finding", "old_position": 5},
        ],
    }


def test_204_no_content_returns_none() -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(204))
    client = GitHubClient("tok", transport=transport)
    # add_assignees with empty list short-circuits without a request; pass one to force the call.
    asyncio.new_event_loop().run_until_complete(client.add_assignees("o/r", 1, ["alice"]))


def test_list_closing_pull_requests_filters_disconnected_and_closed() -> None:
    """Net connected−disconnected open PRs only."""
    captured: dict[str, str] = {}

    timeline = [
        # PR #100 connected and still open → included
        {
            "event": "connected",
            "source": {"issue": {"number": 100, "state": "open", "pull_request": {"url": "..."}}},
        },
        # PR #200 connected then disconnected → excluded
        {
            "event": "connected",
            "source": {"issue": {"number": 200, "state": "open", "pull_request": {"url": "..."}}},
        },
        {
            "event": "disconnected",
            "source": {"issue": {"number": 200, "state": "open", "pull_request": {"url": "..."}}},
        },
        # PR #300 connected but currently closed (e.g. rejected) → excluded
        {
            "event": "connected",
            "source": {"issue": {"number": 300, "state": "closed", "pull_request": {"url": "..."}}},
        },
        # Cross-referenced (not connected) — not a closing link → excluded
        {
            "event": "cross-referenced",
            "source": {"issue": {"number": 400, "state": "open", "pull_request": {"url": "..."}}},
        },
        # Plain issue cross-ref (no pull_request) → excluded
        {
            "event": "connected",
            "source": {"issue": {"number": 500, "state": "open"}},
        },
        # Unrelated timeline events → ignored
        {"event": "labeled", "label": {"name": "bug"}},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["per_page"] = request.url.params.get("per_page", "")
        return httpx.Response(200, json=timeline)

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    prs = _run_async(client.list_closing_pull_requests("octo/widget", 42))
    assert prs == (100,)
    assert captured["path"] == "/repos/octo/widget/issues/42/timeline"
    assert captured["per_page"] == "100"


def test_list_closing_pull_requests_empty_timeline() -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json=[]))
    client = GitHubClient("tok", transport=transport)
    assert _run_async(client.list_closing_pull_requests("octo/widget", 7)) == ()


def test_list_comment_reactions_filters_to_thumbs_down() -> None:
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["content"] = request.url.params.get("content", "")
        captured["per_page"] = request.url.params.get("per_page", "")
        return httpx.Response(
            200,
            json=[
                {"content": "-1", "user": {"login": "Alice", "type": "User"}},
                {"content": "-1", "user": {"login": "rando", "type": "User"}},
            ],
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    reactions = _run_async(client.list_comment_reactions("octo/widget", 999))
    assert captured["path"] == "/repos/octo/widget/issues/comments/999/reactions"
    assert captured["content"] == "-1"
    assert captured["per_page"] == "100"
    assert tuple(r.user_login for r in reactions) == ("Alice", "rando")
    assert all(r.content == "-1" for r in reactions)


def test_close_issue_sends_completed_state_reason() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={})

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    assert _run_async(client.close_issue("octo/widget", 42)) is None
    assert captured["method"] == "PATCH"
    assert captured["path"] == "/repos/octo/widget/issues/42"
    assert captured["body"] == {"state": "closed", "state_reason": "completed"}


def test_close_issue_propagates_error() -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(404, json={"message": "Not Found"}))
    client = GitHubClient("tok", transport=transport)
    with pytest.raises(GitHubError) as exc:
        _run_async(client.close_issue("octo/widget", 42))
    assert exc.value.status == 404


def test_search_issues_forgejo_uses_scoped_list_issues_endpoint() -> None:
    """The Forgejo branch uses the repo-scoped, PR-inclusive `ListIssues` GET
    (`/repos/{owner}/{repo}/issues`) with the first keyword as `q` (the API is
    only reliable for single-word full-text) and omits the `type` param so both
    issues AND pull requests come back, parsing the bare JSON array through
    `_summary_from_item`. Every page requests the API-max `limit=50`."""
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["params"] = dict(request.url.params)
        return httpx.Response(
            200,
            json=[
                {
                    "number": 9,
                    "title": "parser crash",
                    "state": "open",
                    "user": {"login": "bob"},
                    "labels": [{"name": "bug"}],
                    "comments": 2,
                    "updated_at": "2026-02-01T00:00:00Z",
                    "created_at": "2026-01-15T00:00:00Z",
                    "html_url": "https://example/9",
                    "state_reason": "",
                }
            ],
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    results = _run_async(client.search_issues("my_org/widget", "parser"))

    assert captured["path"] == "/repos/my_org/widget/issues"
    assert captured["params"] == {
        "q": "parser",
        "state": "all",
        # API max per page; the branch fetches a full page for headroom.
        "limit": "50",
        # no `type` -> returns both issues AND pull requests
    }
    assert len(results) == 1
    assert results[0].number == 9
    assert results[0].author == "bob"
    assert results[0].title == "parser crash"
    assert results[0].is_pull_request is False


def test_search_issues_forgejo_maps_is_pr_to_type_pulls() -> None:
    """A query asking for pull requests maps to Gitea's `type=pulls` param for PR
    inclusive behavior via `is:pr`."""
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["params"] = dict(request.url.params)
        return httpx.Response(
            200,
            json=[
                {
                    "number": 12,
                    "title": "fix flaky test",
                    "state": "open",
                    "user": {"login": "alice"},
                    "labels": [],
                    "comments": 3,
                    "updated_at": "2026-02-02T00:00:00Z",
                    "created_at": "2026-01-20T00:00:00Z",
                    "html_url": "https://example/12",
                    "state_reason": "",
                    "pull_request": {},
                }
            ],
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    results = _run_async(client.search_issues("my_org/widget", "flaky is:pr"))

    assert captured["path"] == "/repos/my_org/widget/issues"
    assert captured["params"]["type"] == "pulls"
    # Only the first keyword goes to the API; qualifiers stay client-side.
    assert captured["params"]["q"] == "flaky"
    assert captured["params"]["state"] == "all"
    assert captured["params"]["limit"] == "50"
    assert len(results) == 1
    assert results[0].number == 12
    assert results[0].is_pull_request is True


def _forgejo_issue(number: int, *, title: str = "", body: str = "", **extra) -> dict:
    item = {
        "number": number,
        "title": title,
        "body": body,
        "state": "open",
        "user": {"login": "bob"},
        "labels": [],
        "comments": 0,
        "updated_at": "2026-02-01T00:00:00Z",
        "created_at": "2026-01-01T00:00:00Z",
        "html_url": f"https://example/{number}",
    }
    item.update(extra)
    return item


def test_search_issues_forgejo_and_filters_multi_word() -> None:
    """Only items whose title AND body together contain ALL keywords survive
    the client-side AND filter; the API `q` carries just the first keyword."""
    items = [
        _forgejo_issue(1, title="signed update broke"),  # both keywords in title
        _forgejo_issue(2, title="signed release notes"),  # missing "update"
        _forgejo_issue(3, title="update notes", body="signed off"),  # keywords split across fields
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=items)

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    results = _run_async(client.search_issues("my_org/widget", "signed update"))
    assert [r.number for r in results] == [1, 3]


def test_search_issues_forgejo_zero_keyword_query_sends_no_q() -> None:
    """A pure-qualifier query has no bare keywords, so `q` is omitted entirely
    and recent items of the requested type come back unfiltered."""
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["params"] = dict(request.url.params)
        return httpx.Response(200, json=[_forgejo_issue(7, title="anything")])

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    results = _run_async(client.search_issues("my_org/widget", "is:pr"))
    assert "q" not in captured["params"]
    assert captured["params"]["type"] == "pulls"
    assert captured["params"]["state"] == "all"
    assert captured["params"]["limit"] == "50"
    assert [r.number for r in results] == [7]


def test_search_issues_forgejo_fetch_headroom_and_truncation() -> None:
    """Page 2 is fetched only when page 1 returned the API max (50) AND the
    caller's limit is large enough to need headroom (limit > 25); matches
    beyond `limit` are truncated; a non-full first page stops at one request."""
    full_page = [_forgejo_issue(1000 + i, title="crash everywhere") for i in range(50)]
    page_two = [_forgejo_issue(2000 + i, title="crash again") for i in range(10)]

    def run(page1: list, page2: list, limit: int):
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            page = request.url.params.get("page", "1")
            calls.append(page)
            return httpx.Response(200, json=page1 if page == "1" else page2)

        client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
        results = _run_async(client.search_issues("my_org/widget", "crash", limit=limit))
        return calls, results

    # Full first page + small limit -> no headroom fetch, truncated to limit.
    calls, results = run(full_page, page_two, limit=10)
    assert calls == ["1"]
    assert len(results) == 10

    # Full first page + large limit -> second page fetched, truncated to limit.
    calls, results = run(full_page, page_two, limit=30)
    assert calls == ["1", "2"]
    assert len(results) == 30

    # Non-full first page -> exactly one request even with a large limit.
    calls, results = run(full_page[:5], page_two, limit=30)
    assert calls == ["1"]
    assert len(results) == 5


def test_search_issues_forgejo_keyword_match_is_case_insensitive() -> None:
    """An uppercase keyword matches lowercase title/body text."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[
                _forgejo_issue(1, title="Crash Report", body="the app crashes"),
                _forgejo_issue(2, title="unrelated", body="nothing here"),
            ],
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    results = _run_async(client.search_issues("my_org/widget", "CRASH"))
    assert [r.number for r in results] == [1]


def test_search_issues_github_uses_search_issues_with_items() -> None:
    """The GitHub branch still hits `/search/issues` with a `repo:`-qualified query
    and parses the `items` array."""
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["params"] = dict(request.url.params)
        return httpx.Response(
            200,
            json={
                "total_count": 1,
                "items": [
                    {
                        "number": 9,
                        "title": "parser crash",
                        "state": "open",
                        "user": {"login": "bob"},
                        "labels": [],
                        "comments": 0,
                        "updated_at": "",
                        "created_at": "",
                        "html_url": "",
                        "state_reason": "",
                    }
                ],
            },
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    results = _run_async(client.search_issues("octo/widget", "parser is:pr"))

    assert captured["path"] == "/search/issues"
    assert captured["params"]["q"] == "repo:octo/widget parser is:pr"
    assert captured["params"]["per_page"] == "10"
    assert len(results) == 1
    assert results[0].number == 9


def test_get_review_comment_fetches_canonical_endpoint() -> None:
    """`get_review_comment` (the Forgejo #7935 workaround) reads the actual text
    from the canonical `/repos/{repo}/pulls/comments/{id}` endpoint (GitHub;
    Forgejo resolves via the reviews walk instead — see the tests below)."""
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        return httpx.Response(
            200,
            json={
                "id": 42,
                "body": "the real comment text",
                "path": "src/app.py",
                "line": 5,
                "user": {"login": "alice"},
                "created_at": "2026-01-01T00:00:00Z",
            },
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="github")
    rc = _run_async(client.get_review_comment("octo/widget", 42))

    assert captured["path"] == "/repos/octo/widget/pulls/comments/42"
    assert rc.id == 42
    assert rc.body == "the real comment text"
    assert rc.path == "src/app.py"
    assert rc.line == 5


def test_list_issues_treats_pull_request_null_as_plain_issue() -> None:
    """An item whose `pull_request` is explicitly `null` is a plain issue and
    must NOT be skipped as a pull request."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[
                {
                    "number": 9,
                    "title": "a real issue",
                    "state": "open",
                    "pull_request": None,
                    "user": {"login": "alice"},
                    "labels": [],
                }
            ],
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    issues = _run_async(client.list_issues("octo/widget"))

    assert len(issues) == 1
    assert issues[0].number == 9
    assert issues[0].is_pull_request is False


def test_release_action_reads_parse_runs_jobs_and_failed_steps() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/actions/runs":
            assert request.url.params["head_sha"] == "abc"
            assert request.url.params["per_page"] == "100"
            return httpx.Response(
                200,
                json={
                    "workflow_runs": [
                        {
                            "id": 10,
                            "name": "CI",
                            "event": "push",
                            "status": "completed",
                            "conclusion": "failure",
                            "head_branch": "main",
                            "head_sha": "abc",
                            "html_url": "https://example/runs/10",
                            "run_attempt": 2,
                        }
                    ]
                },
            )
        assert request.url.path == "/repos/octo/widget/actions/runs/10/jobs"
        assert request.url.params["filter"] == "latest"
        return httpx.Response(
            200,
            json={
                "jobs": [
                    {
                        "id": 20,
                        "run_id": 10,
                        "name": "test",
                        "status": "completed",
                        "conclusion": "failure",
                        "html_url": "https://example/jobs/20",
                        "steps": [
                            {"name": "checkout", "conclusion": "success"},
                            {"name": "tests", "conclusion": "failure"},
                            {"name": "cleanup", "conclusion": "skipped"},
                        ],
                    }
                ]
            },
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    runs = _run_async(client.list_workflow_runs("octo/widget", head_sha="abc"))
    jobs = _run_async(client.list_workflow_jobs("octo/widget", runs[0].id))
    assert runs[0].run_attempt == 2
    assert runs[0].head_sha == "abc"
    assert jobs[0].failed_steps == ("tests",)


def test_job_log_tail_follows_redirect_and_caps_retained_bytes() -> None:
    payload = b"discard\n" + (b"x" * (4 * 1024 * 1024)) + b"\nlast\n"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/logs"):
            return httpx.Response(302, headers={"location": "https://logs.example/job.txt"})
        assert request.url.host == "logs.example"
        return httpx.Response(200, content=payload)

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    tail = _run_async(client.get_job_log_tail("octo/widget", 20, tail_lines=2))
    assert len(tail.encode()) <= 4 * 1024 * 1024
    assert tail.endswith("\nlast")
    assert "discard" not in tail


def test_tag_dereference_and_release_metadata() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/git/ref/tags/v1.2.3"):
            return httpx.Response(200, json={"object": {"type": "tag", "sha": "tag-object"}})
        if request.url.path.endswith("/git/tags/tag-object"):
            return httpx.Response(200, json={"object": {"type": "commit", "sha": "commit-sha"}})
        assert request.url.path.endswith("/releases/tags/v1.2.3")
        return httpx.Response(
            200,
            json={
                "tag_name": "v1.2.3",
                "name": "1.2.3",
                "draft": False,
                "prerelease": False,
                "html_url": "https://example/releases/v1.2.3",
                "assets": [{"name": "omp-darwin-arm64.tar.gz"}],
            },
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    assert _run_async(client.get_tag_sha("octo/widget", "v1.2.3")) == "commit-sha"
    release = _run_async(client.get_release_by_tag("octo/widget", "v1.2.3"))
    assert release is not None
    assert release.asset_names == ("omp-darwin-arm64.tar.gz",)


def test_missing_tag_and_release_return_none() -> None:
    client = GitHubClient(
        "tok",
        transport=httpx.MockTransport(lambda request: httpx.Response(404, json={"message": "Not Found"})),
    )
    assert _run_async(client.get_tag_sha("octo/widget", "v1.2.3")) is None
    assert _run_async(client.get_release_by_tag("octo/widget", "v1.2.3")) is None


def test_add_issue_labels_forgejo_creates_missing_labels_first() -> None:
    """Forgejo drops missing names on add, so the client must create absent
    labels (and only absent ones) before the additive issue-label POST."""
    list_calls = 0
    created: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal list_calls
        if request.method == "GET" and request.url.path == "/repos/octo/widget/labels":
            list_calls += 1
            return httpx.Response(200, json=[{"name": "bug"}])
        if request.method == "POST" and request.url.path == "/repos/octo/widget/labels":
            created.append(json.loads(request.content))
            return httpx.Response(201, json={"name": "needs-triage"})
        if request.method == "POST" and request.url.path == "/repos/octo/widget/issues/7/labels":
            assert json.loads(request.content) == {"labels": ["bug", "needs-triage"]}
            return httpx.Response(200, json=[{"name": "bug"}, {"name": "needs-triage"}])
        raise AssertionError(f"unexpected request {request.method} {request.url.path}")

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    result = _run_async(client.add_issue_labels("octo/widget", 7, ["bug", "needs-triage"]))
    assert result == ("bug", "needs-triage")
    assert list_calls == 1
    assert created == [{"name": "needs-triage", "color": "#cccccc"}]


def test_add_issue_labels_forgejo_existing_labels_not_recreated() -> None:
    created: list[dict[str, str]] = []
    added: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/repos/octo/widget/labels":
            return httpx.Response(200, json=[{"name": "bug"}])
        if request.method == "POST" and request.url.path == "/repos/octo/widget/labels":
            created.append(json.loads(request.content))
            return httpx.Response(201, json={"name": "bug"})
        if request.method == "POST" and request.url.path == "/repos/octo/widget/issues/7/labels":
            added.append(json.loads(request.content))
            return httpx.Response(200, json=[{"name": "bug"}])
        raise AssertionError(f"unexpected request {request.method} {request.url.path}")

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    assert _run_async(client.add_issue_labels("octo/widget", 7, ["bug"])) == ("bug",)
    assert created == []
    assert added == [{"labels": ["bug"]}]


def test_add_issue_labels_github_does_not_list_or_create() -> None:
    """GitHub auto-creates on add; the client must not add extra requests."""
    paths: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append((request.method, request.url.path))
        if request.method == "POST" and request.url.path == "/repos/octo/widget/issues/7/labels":
            return httpx.Response(200, json=[{"name": "bug"}])
        raise AssertionError(f"unexpected request {request.method} {request.url.path}")

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    assert _run_async(client.add_issue_labels("octo/widget", 7, ["bug"])) == ("bug",)
    assert paths == [("POST", "/repos/octo/widget/issues/7/labels")]


def test_add_issue_labels_forgejo_409_create_already_exists_is_ignored() -> None:
    """A concurrent creator wins the label-create race: the 409 'already
    exists' is swallowed and the attach still happens."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/repos/octo/widget/labels":
            return httpx.Response(200, json=[])
        if request.method == "POST" and request.url.path == "/repos/octo/widget/labels":
            return httpx.Response(409, json={"message": "Label already exists"})
        if request.method == "POST" and request.url.path == "/repos/octo/widget/issues/7/labels":
            return httpx.Response(200, json=[{"name": "needs-triage"}])
        raise AssertionError(f"unexpected request {request.method} {request.url.path}")

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    assert _run_async(client.add_issue_labels("octo/widget", 7, ["needs-triage"])) == ("needs-triage",)


def test_list_repo_labels_paginates_forgejo() -> None:
    seen_params: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_params.append(dict(request.url.params))
        if request.url.params["page"] == "1":
            return httpx.Response(200, json=[{"name": f"lbl-{i}"} for i in range(50)])
        return httpx.Response(200, json=[])

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    names = _run_async(client.list_repo_labels("octo/widget"))
    assert names == tuple(f"lbl-{i}" for i in range(50))
    assert seen_params[0] == {"limit": "50", "page": "1"}
    assert seen_params[1] == {"limit": "50", "page": "2"}


def test_list_repo_labels_paginates_github() -> None:
    """The GitHub branch uses `per_page` (100) instead of Forgejo's `limit`."""
    seen_params: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_params.append(dict(request.url.params))
        if request.url.params["page"] == "1":
            return httpx.Response(200, json=[{"name": f"lbl-{i}"} for i in range(100)])
        return httpx.Response(200, json=[])

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    names = _run_async(client.list_repo_labels("octo/widget"))
    assert names == tuple(f"lbl-{i}" for i in range(100))
    assert seen_params[0] == {"per_page": "100", "page": "1"}
    assert seen_params[1] == {"per_page": "100", "page": "2"}


def test_list_repo_labels_truncates_at_page_bound(caplog: pytest.LogCaptureFixture) -> None:
    """A server returning full pages forever must stop at the page bound and
    log a warning rather than paginate unbounded."""
    requests_seen: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests_seen.append(int(request.url.params["page"]))
        return httpx.Response(200, json=[{"name": f"lbl-{int(request.url.params['page'])}-{i}"} for i in range(50)])

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    with caplog.at_level(logging.WARNING, logger="robomp.github_client"):
        names = _run_async(client.list_repo_labels("octo/widget"))
    assert len(names) == _MAX_LABEL_PAGES * 50
    assert len(requests_seen) == _MAX_LABEL_PAGES
    assert requests_seen == list(range(1, _MAX_LABEL_PAGES + 1))
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert any("truncated" in r.getMessage() for r in warnings)


def test_forgejo_list_review_comments_walks_reviews() -> None:
    """Forgejo's flat `/pulls/{n}/comments` route 404s, so the client walks the
    PR's reviews and fetches each review's comments; `position` (new-file line)
    maps to `line` — Forgejo items carry no `line`/`original_line` keys."""
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(request.url.path)
        if request.url.path == "/repos/o/r/pulls/1664/reviews":
            return httpx.Response(
                200,
                json=[{"id": 535, "user": {"login": "mira"}, "body": "lgtm", "state": "approved"}],
            )
        if request.url.path == "/repos/o/r/pulls/1664/reviews/535/comments":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 10925,
                        "user": {"login": "miracodeai-bot"},
                        "body": "**Bug**",
                        "path": ".forgejo/workflows/ci.yml",
                        "position": 655,
                        "original_position": 654,
                        "diff_hunk": "@@ -652,3 +652,4 @@",
                        "created_at": "2026-09-01T12:00:00Z",
                    }
                ],
            )
        return httpx.Response(404, json={"message": "unexpected " + request.url.path})

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    comments = _run_async(client.list_review_comments("o/r", 1664))

    assert len(comments) == 1
    rc = comments[0]
    assert rc.id == 10925
    assert rc.line == 655
    assert rc.path == ".forgejo/workflows/ci.yml"
    assert rc.author == "miracodeai-bot"
    assert rc.body == "**Bug**"
    # The dead flat route must never be requested on Forgejo.
    assert "/repos/o/r/pulls/1664/comments" not in requested
    assert requested == [
        "/repos/o/r/pulls/1664/reviews",
        "/repos/o/r/pulls/1664/reviews/535/comments",
    ]


def test_forgejo_list_review_comments_flattens_reviews() -> None:
    """Comments from several reviews flatten into one list, in review order."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/o/r/pulls/1664/reviews":
            return httpx.Response(
                200,
                json=[
                    {"id": 535, "user": {"login": "mira"}, "body": "first"},
                    {"id": 536, "user": {"login": "bob"}, "body": "second"},
                ],
            )
        if request.url.path == "/repos/o/r/pulls/1664/reviews/535/comments":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 1,
                        "user": {"login": "mira"},
                        "body": "a",
                        "path": "x.py",
                        "position": 10,
                        "created_at": "2026-09-01T00:00:00Z",
                    }
                ],
            )
        if request.url.path == "/repos/o/r/pulls/1664/reviews/536/comments":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 2,
                        "user": {"login": "bob"},
                        "body": "b",
                        "path": "y.py",
                        "position": 20,
                        "created_at": "2026-09-01T00:00:00Z",
                    }
                ],
            )
        return httpx.Response(404, json={"message": "unexpected " + request.url.path})

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    comments = _run_async(client.list_review_comments("o/r", 1664))

    assert [(c.id, c.body, c.author) for c in comments] == [(1, "a", "mira"), (2, "b", "bob")]


def test_forgejo_list_review_comments_paginates() -> None:
    """A review with more than 50 inline comments must paginate with
    `limit=50` (Forgejo's MaxResponseItems clamp) until a short page."""
    seen_params: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/o/r/pulls/1664/reviews":
            return httpx.Response(200, json=[{"id": 535, "user": {"login": "mira"}, "body": "many"}])
        if request.url.path == "/repos/o/r/pulls/1664/reviews/535/comments":
            seen_params.append(dict(request.url.params))
            if request.url.params.get("page") == "1":
                return httpx.Response(
                    200,
                    json=[
                        {
                            "id": i,
                            "user": {"login": "mira"},
                            "body": f"c{i}",
                            "path": "x.py",
                            "position": i,
                            "created_at": "2026-09-01T00:00:00Z",
                        }
                        for i in range(50)
                    ],
                )
            assert request.url.params["page"] == "2"
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 999,
                        "user": {"login": "mira"},
                        "body": "last",
                        "path": "x.py",
                        "position": 51,
                        "created_at": "2026-09-01T00:00:00Z",
                    }
                ],
            )
        return httpx.Response(404, json={"message": "unexpected " + request.url.path})

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    comments = _run_async(client.list_review_comments("o/r", 1664))

    assert len(comments) == 51
    assert comments[-1].id == 999
    assert comments[-1].line == 51
    assert seen_params[0] == {"limit": "50", "page": "1"}
    assert seen_params[1] == {"limit": "50", "page": "2"}


def test_forgejo_get_review_comment_found() -> None:
    """With `pr_number`, a Forgejo comment resolves via the reviews walk and
    returns the mapped item (no flat `/pulls/comments/{id}` fetch)."""
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(request.url.path)
        if request.url.path == "/repos/o/r/pulls/1664/reviews":
            return httpx.Response(200, json=[{"id": 535, "user": {"login": "mira"}, "body": "review"}])
        if request.url.path == "/repos/o/r/pulls/1664/reviews/535/comments":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 10925,
                        "user": {"login": "miracodeai-bot"},
                        "body": "**Bug**",
                        "path": ".forgejo/workflows/ci.yml",
                        "position": 655,
                        "created_at": "2026-09-01T00:00:00Z",
                    }
                ],
            )
        return httpx.Response(404, json={"message": "unexpected " + request.url.path})

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    rc = _run_async(client.get_review_comment("o/r", 10925, pr_number=1664))

    assert rc.id == 10925
    assert rc.line == 655
    assert rc.path == ".forgejo/workflows/ci.yml"
    assert rc.author == "miracodeai-bot"
    assert "/repos/o/r/pulls/comments/10925" not in requested


def test_forgejo_get_review_comment_not_found() -> None:
    """A Forgejo id the reviews walk never yields raises `GitHubError(404)` —
    the caller's except path already falls back to the webhook body."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/o/r/pulls/1664/reviews":
            return httpx.Response(200, json=[{"id": 535, "user": {"login": "mira"}, "body": "review"}])
        if request.url.path == "/repos/o/r/pulls/1664/reviews/535/comments":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 10925,
                        "user": {"login": "miracodeai-bot"},
                        "body": "**Bug**",
                        "path": ".forgejo/workflows/ci.yml",
                        "position": 655,
                        "created_at": "2026-09-01T00:00:00Z",
                    }
                ],
            )
        return httpx.Response(404, json={"message": "unexpected " + request.url.path})

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    with pytest.raises(GitHubError) as exc:
        _run_async(client.get_review_comment("o/r", 999999, pr_number=1664))

    assert exc.value.status == 404


def test_forgejo_review_comments_204_treated_empty() -> None:
    """A `204` from the review-comments fetch is treated as an empty comment
    list, not an error (the shared `_check` 204 -> `None` path)."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/o/r/pulls/1664/reviews":
            return httpx.Response(200, json=[{"id": 535, "user": {"login": "mira"}, "body": "review"}])
        if request.url.path == "/repos/o/r/pulls/1664/reviews/535/comments":
            return httpx.Response(204)
        return httpx.Response(404, json={"message": "unexpected " + request.url.path})

    client = GitHubClient("tok", transport=httpx.MockTransport(handler), platform="forgejo")
    assert _run_async(client.list_review_comments("o/r", 1664)) == []


def test_github_review_comments_regression_pins() -> None:
    """The GitHub path stays on the flat canonical routes: `list_review_comments`
    hits `/pulls/{n}/comments` (mapping `line`, falling back to `original_line`)
    and `get_review_comment` hits `/pulls/comments/{id}`."""
    requested: list[str] = []

    def list_handler(request: httpx.Request) -> httpx.Response:
        requested.append(request.url.path)
        return httpx.Response(
            200,
            json=[
                {
                    "id": 1,
                    "user": {"login": "alice"},
                    "body": "a",
                    "path": "x.py",
                    "line": 5,
                    "created_at": "2026-09-01T00:00:00Z",
                },
                {
                    "id": 2,
                    "user": {"login": "bob"},
                    "body": "b",
                    "path": "y.py",
                    "original_line": 7,
                    "created_at": "2026-09-01T00:00:00Z",
                },
            ],
        )

    list_client = GitHubClient("tok", transport=httpx.MockTransport(list_handler), platform="github")
    comments = _run_async(list_client.list_review_comments("o/r", 1664))

    assert requested == ["/repos/o/r/pulls/1664/comments"]
    assert [c.line for c in comments] == [5, 7]
    assert [c.author for c in comments] == ["alice", "bob"]

    requested.clear()

    def get_handler(request: httpx.Request) -> httpx.Response:
        requested.append(request.url.path)
        return httpx.Response(
            200,
            json={
                "id": 10925,
                "body": "**Bug**",
                "path": ".forgejo/workflows/ci.yml",
                "line": 655,
                "user": {"login": "miracodeai-bot"},
                "created_at": "2026-09-01T00:00:00Z",
            },
        )

    get_client = GitHubClient("tok", transport=httpx.MockTransport(get_handler), platform="github")
    rc = _run_async(get_client.get_review_comment("o/r", 10925))

    assert requested == ["/repos/o/r/pulls/comments/10925"]
    assert rc.id == 10925
    assert rc.line == 655
