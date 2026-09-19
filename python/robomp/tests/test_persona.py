"""Coverage for the directive prompt assembly."""

from __future__ import annotations

from dataclasses import dataclass

from robomp import persona
from robomp.worker import DirectiveInfo, ReleaseTaskContext, ThreadMessage


@dataclass(slots=True, frozen=True)
class _Repo:
    full_name: str = "octo/widget"
    default_branch: str = "main"
    clone_url: str = ""
    private: bool = False


@dataclass(slots=True, frozen=True)
class _Issue:
    repo: str = "octo/widget"
    number: int = 1080
    title: str = "broken thing"
    body: str = "the body text"
    state: str = "open"
    author: str = "alice"
    labels: tuple[str, ...] = ()
    is_pull_request: bool = False


@dataclass(slots=True, frozen=True)
class _Workspace:
    branch: str = "farm/abc/test"
    session_dir: str = "/tmp/session"
    context_dir: str = "/tmp/ctx"
    repo_dir: str = "/tmp/repo"


@dataclass(slots=True, frozen=True)
class _Pr:
    number: int = 99
    author: str = "alice"
    head_ref: str = "fix-crash"
    base_ref: str = "main"
    head_repo: str = "alice/widget"
    html_url: str = "https://github.com/octo/widget/pull/99"


@dataclass(slots=True, frozen=True)
class _Comment:
    id: int = 1
    author: str = "can1357"
    body: str = "@roboomp please fix"
    created_at: str = "2026-05-14T20:00:00Z"


def test_render_thread_empty_yields_placeholder() -> None:
    assert persona._render_thread(()).startswith("(no prior")


def test_render_thread_orders_kinds_with_appropriate_headers() -> None:
    thread = (
        ThreadMessage(kind="issue_body", author="alice", body="orig report", created_at=""),
        ThreadMessage(kind="comment", author="bob", body="me too", created_at="2026-05-01T10:00:00Z"),
        ThreadMessage(
            kind="review_comment",
            author="codex",
            body="leak here",
            created_at="2026-05-02T10:00:00Z",
            path="src/foo.py",
            line=42,
        ),
        ThreadMessage(
            kind="review",
            author="codex",
            body="two issues",
            created_at="2026-05-02T10:01:00Z",
            state="CHANGES_REQUESTED",
        ),
    )
    out = persona._render_thread(thread)
    # Issue body header (no timestamp).
    assert "### @alice — issue body" in out
    assert "orig report" in out
    # Comment header with timestamp.
    assert "### @bob — comment *(2026-05-01T10:00:00Z)*" in out
    assert "me too" in out
    # Review comment with file:line anchor.
    assert "### @codex — review comment on `src/foo.py`:L42" in out
    assert "leak here" in out
    # Review with state badge.
    assert "### @codex — review (CHANGES_REQUESTED)" in out
    assert "two issues" in out


def test_directive_prompt_embeds_thread_and_directive_body() -> None:
    thread = (
        ThreadMessage(kind="comment", author="alice", body="follow up please", created_at="2026-05-01T10:00:00Z"),
    )
    out = persona.directive(
        repo=_Repo(),
        issue=_Issue(),
        comment=_Comment(),
        workspace=_Workspace(),
        directive=DirectiveInfo(body="apply fix Y", author="can1357", thread=thread),
        pr_status="PR #1080 is open",
    )
    assert "octo/widget#1080" in out
    assert "@can1357" in out
    assert "apply fix Y" in out
    assert "follow up please" in out
    assert "PR #1080 is open" in out


def test_followup_comment_prompt_embeds_thread_context() -> None:
    thread = (
        ThreadMessage(kind="pr_body", author="roboomp", body="PR body", created_at=""),
        ThreadMessage(kind="comment", author="can1357", body="prior request", created_at="2026-05-01T10:00:00Z"),
    )
    out = persona.followup_comment(
        repo=_Repo(),
        issue=_Issue(),
        comment=_Comment(body="current request"),
        workspace=_Workspace(),
        pr_status="PR #1080 is open",
        pr_number=1080,
        thread=thread,
    )

    assert "Prior conversation" in out
    assert "PR body" in out
    assert "prior request" in out
    assert "current request" in out


def test_followup_review_prompt_embeds_thread_context() -> None:
    thread = (
        ThreadMessage(kind="pr_body", author="robomp", body="PR body", created_at=""),
        ThreadMessage(
            kind="review_comment",
            author="mira",
            body="Trailing descriptor issue",
            created_at="2026-08-07T21:48:00Z",
            path="internal/import/person_credit.go",
            line=141,
        ),
    )
    out = persona.followup_review(
        repo=_Repo(),
        workspace=_Workspace(),
        pr_number=997,
        comment_author="mira",
        comment_body="Trailing descriptor parse misses the case when the imported person has no credit.",
        comment_path="internal/import/person_credit.go",
        comment_line_range=":L141",
        thread=thread,
    )

    assert "Prior conversation" in out
    assert "PR body" in out
    assert "Trailing descriptor issue" in out
    assert "Trailing descriptor parse misses" in out
    assert ":L141" in out


def test_kickoff_directive_prompt_embeds_thread_and_classify_instruction() -> None:
    thread = (ThreadMessage(kind="issue_body", author="alice", body="failing on macos", created_at=""),)
    out = persona.kickoff_directive(
        repo=_Repo(),
        issue=_Issue(),
        workspace=_Workspace(),
        directive=DirectiveInfo(body="reproduce + fix", author="can1357", thread=thread),
    )
    assert "octo/widget#1080" in out
    assert "failing on macos" in out
    assert "reproduce + fix" in out
    # The kickoff variant must still tell the agent to classify first.
    assert "Classify first" in out


def test_resume_triage_renders_branch_and_issue() -> None:
    out = persona.resume_triage(
        repo=_Repo(),
        issue=_Issue(),
        workspace=_Workspace(),
    )
    # Working branch surfaces literally so the agent sees what it's on.
    assert "farm/abc/test" in out
    # Issue identity surfaces with the title.
    assert "octo/widget#1080" in out
    assert "broken thing" in out
    # The prompt instructs the agent to reconcile drift via fetch_issue_thread.
    assert "fetch_issue_thread" in out


def test_kickoff_pr_review_formats_head_repo_and_origin_base() -> None:
    out = persona.kickoff_pr_review(
        repo=_Repo(),
        pr=_Pr(),
        workspace=_Workspace(),
    )
    assert "`fix-crash` from `alice/widget`" in out
    assert "git diff origin/main...HEAD" in out


def test_review_completion_reminder_mentions_submit_only() -> None:
    out = persona.review_completion_reminder(
        repo=_Repo(),
        issue=_Issue(number=99, title="Fix parser"),
        workspace=_Workspace(branch="review/pr-99"),
    )
    assert "submit_pr_review" in out
    assert "gh_open_pr" not in out


def test_completion_reminder_limits_mark_unable_to_reporter_details() -> None:
    out = persona.completion_reminder(
        repo=_Repo(),
        issue=_Issue(),
        workspace=_Workspace(),
    )
    assert "reporter-provided reproduction details" in out
    assert "maintainer input" not in out


def test_system_append_renders_configured_bot_login() -> None:
    out = persona.system_append(
        repo=_Repo(),
        issue=_Issue(),
        workspace=_Workspace(),
        bot_login="Svitter",
    )
    # The hardcoded persona name MUST be replaced by the configured login so
    # the agent self-mentions the account that actually receives webhooks.
    assert "You are **@Svitter**" in out
    assert "**robomp**" not in out


def test_system_append_routes_push_refusal_to_maintainer_comment_only() -> None:
    out = persona.system_append(
        repo=_Repo(),
        issue=_Issue(),
        workspace=_Workspace(),
        bot_login="Svitter",
    )
    assert "Unresolvable push refusal" in out
    assert "`gh_post_comment` maintainer" in out
    assert "or use `mark_unable_to_reproduce`" not in out


def test_system_append_pr_review_renders_configured_bot_login() -> None:
    out = persona.system_append_pr_review(
        repo=_Repo(),
        issue=_Issue(),
        workspace=_Workspace(),
        bot_login="Svitter",
    )
    assert "@Svitter" in out
    assert "**robomp**" not in out


def _release_context() -> ReleaseTaskContext:
    return ReleaseTaskContext(
        tag="v17.2.8",
        version="17.2.8",
        round=2,
        max_rounds=5,
        head_sha="a" * 40,
        default_branch="main",
        failures_text="## CI / check (failure)\n`bun check` failed",
        run_urls=("https://example.invalid/runs/10",),
    )


def test_release_prompts_preserve_retag_contract() -> None:
    release = _release_context()
    system = persona.system_append_release(
        repo=_Repo(),
        release=release,
        workspace=_Workspace(branch="main"),
        release_commit_prefix="chore: bump version to ",
    )
    kickoff = persona.kickoff_release(
        repo=_Repo(),
        release=release,
        workspace=_Workspace(branch="main"),
    )
    followup = persona.followup_release(
        repo=_Repo(),
        release=release,
        workspace=_Workspace(branch="main"),
    )

    assert "`chore: bump version to 17.2.8`" in system
    assert "NEVER bump versions or changelogs" in system
    assert "After `release_retag` succeeds, END YOUR TURN" in system
    assert "`bun check` failed" in kickoff
    assert "2/5" in kickoff
    assert "still failing" in followup
    assert "crash-resumed round" in followup


def test_release_todo_phases_end_in_retag() -> None:
    phases = persona.seed_phases("handle_release_ci")
    assert [phase["name"] for phase in phases] == ["Diagnose", "Fix", "Retag"]
    assert phases[-1]["tasks"][-1] == "Call release_retag and end the turn"
