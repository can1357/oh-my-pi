"""Prompt template loader + renderer.

Templates use a tiny mustache-style `{{path.to.value}}` placeholder. We do not
import a real template engine: the substitution rules are deliberately
restrictive so a malformed prompt is impossible to render with surprising
side-effects.
"""

from __future__ import annotations

import re
import tomllib
from collections.abc import Mapping
from functools import cache
from importlib import resources
from typing import TYPE_CHECKING, Any

from robomp.git_ops import DirtyState
from robomp.github_client import CommentInfo, IssueInfo, PullRequestInfo, RepoInfo
from robomp.sandbox import Workspace

if TYPE_CHECKING:
    from robomp.worker import ReleaseTaskContext

_PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}")


def _lookup(path: str, scope: Mapping[str, Any]) -> str:
    parts = path.split(".")
    value: Any = scope
    for part in parts:
        if isinstance(value, Mapping):
            value = value.get(part)
        else:
            value = getattr(value, part, None)
        if value is None:
            return ""
    if isinstance(value, (list, tuple)):
        return ", ".join(str(item) for item in value)
    return str(value)


def render(template: str, scope: Mapping[str, Any]) -> str:
    return _PLACEHOLDER.sub(lambda m: _lookup(m.group(1), scope), template)


@cache
def _load(name: str) -> str:
    return resources.files("robomp.prompts").joinpath(name).read_text(encoding="utf-8")


@cache
def _load_toml(name: str) -> Mapping[str, Any]:
    data = tomllib.loads(_load(name))
    if not isinstance(data, Mapping):
        raise ValueError(f"prompt data file {name!r} must contain a TOML table")
    return data


def _require_mapping(value: Any, context: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{context} must be a table")
    return value


def _require_nonempty_str(value: Any, context: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{context} must be a non-empty string")
    return value


def seed_phases(task_kind: str) -> list[dict[str, Any]]:
    raw_phases = _load_toml("todo_phases.toml").get(task_kind, [])
    if not isinstance(raw_phases, list):
        raise ValueError(f"todo_phases.toml[{task_kind!r}] must be a list of phases")

    phases: list[dict[str, Any]] = []
    for phase_index, raw_phase in enumerate(raw_phases):
        phase = _require_mapping(raw_phase, f"todo_phases.toml[{task_kind!r}][{phase_index}]")
        name = _require_nonempty_str(
            phase.get("name"),
            f"todo_phases.toml[{task_kind!r}][{phase_index}].name",
        )
        raw_tasks = phase.get("tasks")
        if not isinstance(raw_tasks, list) or not raw_tasks:
            raise ValueError(f"todo_phases.toml[{task_kind!r}][{phase_index}].tasks must be a non-empty list")
        tasks = [
            _require_nonempty_str(
                task,
                f"todo_phases.toml[{task_kind!r}][{phase_index}].tasks[{task_index}]",
            )
            for task_index, task in enumerate(raw_tasks)
        ]
        phases.append({"name": name, "tasks": tasks})
    return phases


def _host_tool_entry(tool_name: str) -> Mapping[str, Any]:
    return _require_mapping(
        _load_toml("host_tools.toml").get(tool_name),
        f"host_tools.toml[{tool_name!r}]",
    )


def host_tool_description(tool_name: str) -> str:
    return _require_nonempty_str(
        _host_tool_entry(tool_name).get("description"),
        f"host_tools.toml[{tool_name!r}].description",
    )


def host_tool_parameter_description(tool_name: str, parameter_name: str) -> str:
    parameters = _require_mapping(
        _host_tool_entry(tool_name).get("parameters"),
        f"host_tools.toml[{tool_name!r}].parameters",
    )
    return _require_nonempty_str(
        parameters.get(parameter_name),
        f"host_tools.toml[{tool_name!r}].parameters[{parameter_name!r}]",
    )


def classify_next_step(primary: str) -> str:
    steps = _require_mapping(
        _host_tool_entry("classify_issue").get("next_steps"),
        "host_tools.toml['classify_issue'].next_steps",
    )
    return _require_nonempty_str(
        steps.get(primary),
        f"host_tools.toml['classify_issue'].next_steps[{primary!r}]",
    )


def system_append(*, repo: RepoInfo, issue: IssueInfo, workspace: Workspace, bot_login: str) -> str:
    return render(
        _load("system_append.md"),
        {"repo": repo, "issue": issue, "workspace": workspace, "bot_login": bot_login},
    )


def system_append_pr_review(*, repo: RepoInfo, issue: IssueInfo, workspace: Workspace, bot_login: str) -> str:
    return render(
        _load("system_append_pr_review.md"),
        {"repo": repo, "issue": issue, "workspace": workspace, "bot_login": bot_login},
    )


def system_append_release(
    *,
    repo: RepoInfo,
    release: ReleaseTaskContext,
    workspace: Workspace,
    release_commit_prefix: str,
) -> str:
    """Render the invariant release-repair instructions for every round."""
    return render(
        _load("system_append_release.md"),
        {
            "repo": repo,
            "release": release,
            "workspace": workspace,
            "release_commit_prefix": release_commit_prefix,
        },
    )


def kickoff_release(*, repo: RepoInfo, release: ReleaseTaskContext, workspace: Workspace) -> str:
    """Render the first failed-CI round for a release."""
    return render(
        _load("kickoff_release.md"),
        {"repo": repo, "release": release, "workspace": workspace},
    )


def followup_release(*, repo: RepoInfo, release: ReleaseTaskContext, workspace: Workspace) -> str:
    """Render a later or crash-resumed failed-CI release round."""
    return render(
        _load("followup_release.md"),
        {"repo": repo, "release": release, "workspace": workspace},
    )


def kickoff(*, repo: RepoInfo, issue: IssueInfo, workspace: Workspace) -> str:
    return render(_load("kickoff_issue.md"), {"repo": repo, "issue": issue, "workspace": workspace})


def kickoff_pr_review(*, repo: RepoInfo, pr: PullRequestInfo, workspace: Workspace) -> str:
    return render(_load("kickoff_pr_review.md"), {"repo": repo, "pr": pr, "workspace": workspace})


def resume_triage(*, repo: RepoInfo, issue: IssueInfo, workspace: Workspace) -> str:
    """Resume prompt for a `triage_issue` task whose omp session already exists."""
    return render(_load("resume_triage.md"), {"repo": repo, "issue": issue, "workspace": workspace})


def completion_reminder(*, repo: RepoInfo, issue: IssueInfo, workspace: Workspace) -> str:
    """Reminder injected when a triage turn ends before a terminal tool fired."""
    return render(_load("completion_reminder.md"), {"repo": repo, "issue": issue, "workspace": workspace})


def review_completion_reminder(*, repo: RepoInfo, issue: IssueInfo, workspace: Workspace) -> str:
    """Reminder injected when a PR review turn ends before submission."""
    return render(_load("review_completion_reminder.md"), {"repo": repo, "issue": issue, "workspace": workspace})


def dirty_state_reminder(
    *,
    repo: RepoInfo,
    issue: IssueInfo,
    workspace: Workspace,
    dirty: DirtyState,
) -> str:
    """Reminder injected when the worktree has uncommitted or unpushed work.

    Fired by `worker._drive_turn` after the model emits a terminal turn but
    leaves changes behind that roboomp would otherwise discard. The summary
    embedded in the template comes from `git_ops.inspect_dirty_state` so the
    agent sees the exact paths / commits it forgot about.
    """
    return render(
        _load("dirty_state_reminder.md"),
        {
            "repo": repo,
            "issue": issue,
            "workspace": workspace,
            "dirty": {
                "uncommitted": dirty.uncommitted,
                "unpushed": dirty.unpushed,
                "summary": dirty.summary,
            },
        },
    )


def _render_thread(messages: tuple) -> str:
    """Render a `tuple[ThreadMessage, ...]` as a markdown block for prompt embed.

    Duck-typed: any object with `.kind / .author / .body / .created_at` and
    optional `.path / .line / .state` works. Kept here (not in worker.py) so
    persona owns the prompt-shape.
    """
    if not messages:
        return "(no prior conversation)"
    parts: list[str] = []
    for m in messages:
        kind = getattr(m, "kind", "comment")
        author = getattr(m, "author", "") or "unknown"
        body = getattr(m, "body", "") or ""
        ts = getattr(m, "created_at", "") or ""
        if kind in ("issue_body", "pr_body"):
            header = f"### @{author} — {'PR body' if kind == 'pr_body' else 'issue body'}"
        elif kind == "review_comment":
            path = getattr(m, "path", None)
            line = getattr(m, "line", None)
            anchor = f"`{path}`" + (f":L{line}" if isinstance(line, int) else "")
            header = f"### @{author} — review comment on {anchor}"
        elif kind == "review":
            state = getattr(m, "state", None) or "COMMENTED"
            header = f"### @{author} — review ({state})"
        else:
            header = f"### @{author} — comment"
        if ts:
            header += f" *({ts})*"
        parts.append(header)
        parts.append("")
        parts.append(body.rstrip())
        parts.append("")
    return "\n".join(parts).rstrip()


def kickoff_directive(
    *,
    repo: RepoInfo,
    issue: IssueInfo,
    workspace: Workspace,
    directive: Any,
) -> str:
    """Kickoff for an untriaged issue that arrived via a maintainer mention.

    `directive` is duck-typed to anything with `body`, `author`, and `thread`
    attributes (see `worker.DirectiveInfo`). Imported lazily to avoid a
    persona → worker circular dependency.
    """
    return render(
        _load("kickoff_directive.md"),
        {
            "repo": repo,
            "issue": issue,
            "workspace": workspace,
            "directive": {"body": directive.body, "author": directive.author},
            "thread": _render_thread(getattr(directive, "thread", ()) or ()),
        },
    )


def _inbound_scope(issue: IssueInfo, pr_number: int | None) -> dict[str, Any]:
    """Describe the thread the inbound webhook arrived on.

    For PR conversations and review comments `pr_number` is the PR; for
    regular issue comments it's None and we fall back to the issue. The
    `kind` field lets prompts say "PR" or "issue" without branching in the
    template engine.
    """
    if pr_number is not None:
        return {"kind": "PR", "number": pr_number}
    return {"kind": "issue", "number": issue.number}


def _origin_scope(issue: IssueInfo) -> dict[str, Any]:
    if issue.is_pull_request:
        return {"description": "originating issue unknown; handling this PR directly"}
    return {"description": f"originating issue #{issue.number}"}


def followup_comment(
    *,
    repo: RepoInfo,
    issue: IssueInfo,
    comment: CommentInfo,
    workspace: Workspace,
    pr_status: str,
    pr_number: int | None = None,
    thread: tuple = (),
) -> str:
    return render(
        _load("followup_comment.md"),
        {
            "repo": repo,
            "issue": issue,
            "workspace": workspace,
            "comment": comment,
            "thread": _render_thread(thread),
            "state": {"pr_status": pr_status},
            "inbound": _inbound_scope(issue, pr_number),
            "origin": _origin_scope(issue),
        },
    )


def directive(
    *,
    repo: RepoInfo,
    issue: IssueInfo,
    comment: CommentInfo,
    workspace: Workspace,
    directive: Any,
    pr_status: str,
    pr_number: int | None = None,
) -> str:
    """Follow-up flavor for a comment that is a maintainer directive."""
    return render(
        _load("directive.md"),
        {
            "repo": repo,
            "issue": issue,
            "workspace": workspace,
            "comment": comment,
            "directive": {"body": directive.body, "author": directive.author},
            "thread": _render_thread(getattr(directive, "thread", ()) or ()),
            "state": {"pr_status": pr_status},
            "inbound": _inbound_scope(issue, pr_number),
            "origin": _origin_scope(issue),
        },
    )


def followup_review(
    *,
    repo: RepoInfo,
    workspace: Workspace,
    pr_number: int,
    comment_author: str,
    comment_body: str,
    comment_path: str,
    comment_line_range: str,
) -> str:
    return render(
        _load("followup_review.md"),
        {
            "repo": repo,
            "workspace": workspace,
            "pr": {"number": pr_number},
            "comment": {
                "author": comment_author,
                "body": comment_body,
                "path": comment_path,
                "line_range": comment_line_range,
            },
        },
    )


def unable_to_reproduce_comment(*, diagnosis: str, info_needed: str) -> str:
    return render(
        _load("unable_to_reproduce_comment.md"),
        {"diagnosis": diagnosis, "info_needed": info_needed},
    )


def finalized_issue_comment() -> str:
    return _load("finalized_issue_comment.md").strip()


def finalized_pr_comment() -> str:
    return _load("finalized_pr_comment.md").strip()


def bare_mention_reply() -> str:
    return "What would you like me to do?"


def question_autoclose_suffix(hours: float) -> str:
    """Render the 👎-to-keep-open suffix appended to the bot's question answers.

    `hours` is rendered without trailing zeros for whole values (e.g. `4`
    rather than `4.0`); fractional windows render with one decimal.
    """
    if float(hours).is_integer():
        rendered = str(int(hours))
    else:
        rendered = f"{hours:g}"
    return render(_load("question_autoclose_suffix.md").rstrip(), {"hours": rendered})


__all__ = [
    "classify_next_step",
    "directive",
    "finalized_issue_comment",
    "finalized_pr_comment",
    "followup_comment",
    "followup_release",
    "followup_review",
    "host_tool_description",
    "host_tool_parameter_description",
    "kickoff",
    "kickoff_directive",
    "kickoff_release",
    "kickoff_pr_review",
    "render",
    "completion_reminder",
    "review_completion_reminder",
    "system_append_release",
    "system_append_pr_review",
    "dirty_state_reminder",
    "resume_triage",
    "seed_phases",
    "system_append",
    "unable_to_reproduce_comment",
    "bare_mention_reply",
    "question_autoclose_suffix",
]
