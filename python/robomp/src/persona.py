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


# Total character budget for the conversation thread embedded in a prompt.
# The thread is one section of a much larger prompt (system prompt, diff
# context, instructions), so it must stay far below any plausible model
# context window: ~150_000 chars (~40K tokens) is already a large share of a
# 128K-token window, and that is the maximum we allow. An over-active PR can
# carry hundreds of comments, and without a budget the single user prompt can
# exceed the context window so even a small new review cannot run.
_THREAD_BUDGET_CHARS = 150_000
# Headroom reserved for the omission marker + its separators when trimming;
# the marker is a few dozen characters, so 200 guarantees the trimmed output
# stays within `_THREAD_BUDGET_CHARS`.
_THREAD_BUDGET_MARKER_RESERVE = 200
# Modest additive cap for stored sibling payloads, which sit outside the bounded
# live-thread section in the prompt.
_COALESCED_BUDGET_CHARS = 20_000
# Headroom for the coalesced omission marker and separators.
_COALESCED_BUDGET_MARKER_RESERVE = 200


def _thread_block(m: Any) -> str:
    """Render one `ThreadMessage` as a markdown block (no joining).

    Duck-typed: any object with `.kind / .author / .body / .created_at` and
    optional `.path / .line / .state` works.
    """
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
    return f"{header}\n\n{body.rstrip()}"


def _render_thread(messages: tuple) -> str:
    """Render a `tuple[ThreadMessage, ...]` as a markdown block for prompt embed.

    Kept here (not in worker.py) so persona owns the prompt-shape. Output is
    bounded by `_THREAD_BUDGET_CHARS`: an over-budget thread drops the
    OLDEST messages first (messages arrive sorted oldest→newest),
    force-keeps unresolved reviews — also newest-first, so the OLDEST
    force-keeps are dropped once the budget is exhausted — and emits an
    explicit marker so the agent knows context was elided.
    """
    if not messages:
        return "(no prior conversation)"
    blocks = [_thread_block(m) for m in messages]
    if sum(len(b) for b in blocks) + 2 * (len(blocks) - 1) <= _THREAD_BUDGET_CHARS:
        return "\n\n".join(blocks).rstrip()
    # Over budget: keep the newest messages (last in the list) while the
    # content budget allows; the newest one is always kept.
    content_budget = _THREAD_BUDGET_CHARS - _THREAD_BUDGET_MARKER_RESERVE
    truncated_newest_head = 0
    if len(blocks[-1]) > content_budget:
        # A single newest message can exceed the whole budget (a giant review
        # dump). Truncate its HEAD — the tail is the newest text — so the
        # rendered thread can never blow past `_THREAD_BUDGET_CHARS`, even for
        # one enormous message. The marker below counts it as elided content.
        truncated_newest_head = len(blocks[-1]) - content_budget
        blocks[-1] = (
            f"…{truncated_newest_head} earlier characters omitted for length…\n\n" + blocks[-1][-content_budget:]
        )
    keep = [False] * len(blocks)
    keep[-1] = True
    used = len(blocks[-1])
    for i in range(len(blocks) - 2, -1, -1):
        if used + len(blocks[i]) + 2 <= content_budget:
            keep[i] = True
            used += len(blocks[i]) + 2
    # Unresolved reviews are open work — keep them even if they fall outside
    # the recency window. Force-keeps are selected newest-first, but must fit
    # too. If necessary, evict the oldest selected non-review messages; if only
    # protected reviews remain, drop this force-keep (the oldest one first).
    dropped_force_keeps = 0
    protected_reviews = {
        i
        for i, m in enumerate(messages)
        if getattr(m, "kind", "") == "review" and (getattr(m, "state", None) or "") != "APPROVED"
    }
    for i in range(len(blocks) - 2, -1, -1):
        if keep[i] or i not in protected_reviews:
            continue
        if used + len(blocks[i]) + 2 > content_budget:
            evictable = [j for j in range(len(blocks) - 1) if keep[j] and j not in protected_reviews]
            need = used + len(blocks[i]) + 2 - content_budget
            reclaimable = sum(len(blocks[j]) + 2 for j in evictable)
            if reclaimable < need:
                # This unresolved review is the newest of the remaining
                # force-keeps. Once it cannot fit, every older force-keep loses
                # too, even if a smaller one could be packed into a gap.
                dropped_force_keeps += sum(1 for j in range(i, -1, -1) if j in protected_reviews and not keep[j])
                break
            for j in evictable:
                keep[j] = False
                used -= len(blocks[j]) + 2
                if used + len(blocks[i]) + 2 <= content_budget:
                    break
        keep[i] = True
        used += len(blocks[i]) + 2
    omitted = sum(1 for k in keep if not k)
    parts: list[str] = []
    if omitted:
        marker = f"…{omitted} earlier messages omitted for length"
        if dropped_force_keeps:
            marker += f" ({dropped_force_keeps} of them unresolved reviews)"
        parts.append(marker + "…")
    parts.extend(blocks[i] for i in range(len(blocks)) if keep[i])
    return "\n\n".join(parts).rstrip()


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
    coalesced: tuple[Mapping[str, Any], ...] = (),
) -> str:
    scope: dict[str, Any] = {
        "repo": repo,
        "issue": issue,
        "workspace": workspace,
        "comment": comment,
        "thread": _render_thread(thread),
        "state": {"pr_status": pr_status},
        "inbound": _inbound_scope(issue, pr_number),
        "origin": _origin_scope(issue),
    }
    if coalesced:
        # A coalesced reviewer-bot sibling's finding may exist only in its
        # stored webhook payload when live-thread hydration dropped it; render
        # it here (deduped against `thread`) so it is never silently lost.
        section = _render_coalesced_section(coalesced, thread=thread)
        if section:
            scope["coalesced_section"] = section
    return render(_load("followup_comment.md"), scope)


def directive(
    *,
    repo: RepoInfo,
    issue: IssueInfo,
    comment: CommentInfo,
    workspace: Workspace,
    directive: Any,
    pr_status: str,
    pr_number: int | None = None,
    coalesced: tuple[Mapping[str, Any], ...] = (),
) -> str:
    """Follow-up flavor for a comment that is a maintainer directive."""
    d_thread = getattr(directive, "thread", ()) or ()
    scope: dict[str, Any] = {
        "repo": repo,
        "issue": issue,
        "workspace": workspace,
        "comment": comment,
        "directive": {"body": directive.body, "author": directive.author},
        "thread": _render_thread(d_thread),
        "state": {"pr_status": pr_status},
        "inbound": _inbound_scope(issue, pr_number),
        "origin": _origin_scope(issue),
    }
    if coalesced:
        # Siblings were coalesced into this run; the directive's hydrated
        # thread is the live thread to dedup against, so a finding already in
        # the thread is not rendered twice.
        section = _render_coalesced_section(coalesced, thread=d_thread)
        if section:
            scope["coalesced_section"] = section
    return render(_load("directive.md"), scope)


def _coalesced_block(p: Mapping[str, Any]) -> str:
    """Render one stored sibling payload as a markdown block (no joining)."""
    author = str(p.get("author") or "") or "unknown"
    path = str(p.get("path") or "")
    start = p.get("start_line") or p.get("line")
    end = p.get("line") or p.get("original_line")
    if isinstance(start, int) and isinstance(end, int) and start != end:
        line_range = f":L{start}-L{end}"
    elif isinstance(end, int):
        line_range = f":L{end}"
    else:
        line_range = ""
    anchor = f"`{path}`{line_range}" if path else "(no path in stored payload)"
    body = str(p.get("body") or "")
    return f"### @{author} — review comment on {anchor}\n\n{body.rstrip()}"


def _thread_keys(thread: tuple) -> tuple[set[tuple[str, str]], set[str]]:
    """Identity sets for the live thread: (author, body) pairs plus bare bodies.

    The bodies a coalesced sibling carries are the same strings GitHub returns
    in the hydrated thread, so either key proves a sibling is already rendered.
    Author alone is unreliable (login casing / stored-payload gaps), hence the
    body-only fallback set.
    """
    pairs: set[tuple[str, str]] = set()
    bodies: set[str] = set()
    for m in thread or ():
        body = str(getattr(m, "body", "") or "").rstrip()
        if not body:
            continue
        author = str(getattr(m, "author", "") or "").strip().lower()
        pairs.add((author, body))
        bodies.add(body)
    return pairs, bodies


def _render_coalesced_section(payloads: tuple[Mapping[str, Any], ...], *, thread: tuple = ()) -> str:
    """Render coalesced reviewer-bot payloads as a markdown section for prompt embed.

    Each payload is the stored webhook `comment` of a sibling review event the
    dispatcher skipped as superseded; its live-thread message may be missing
    when hydration partially failed, so the stored payload is the only copy.
    When hydration DID succeed the same comment arrives inside `thread`, so
    siblings whose text is already in the live thread are skipped here — the
    section is a fallback, never a second copy.

    Returns "" when nothing is left to render, so callers can omit the section.
    The section is separately bounded by `_COALESCED_BUDGET_CHARS`: over-budget
    siblings drop the OLDEST payloads first and an explicit marker counts them.
    """
    if not payloads:
        return ""
    pairs, bodies = _thread_keys(thread)
    blocks: list[str] = []
    for p in payloads:
        body = str(p.get("body") or "").rstrip()
        author = str(p.get("author") or "").strip().lower()
        if body and ((author, body) in pairs or body in bodies):
            continue
        blocks.append(_coalesced_block(p))
    if not blocks:
        return ""
    heading = "## Also coalesced into this run — address these findings too"
    content_budget = _COALESCED_BUDGET_CHARS - _COALESCED_BUDGET_MARKER_RESERVE - len(heading) - 2
    kept: list[str] = []
    used = 0
    # Newest-first selection (payloads/blocks are oldest→newest) so the OLDEST
    # siblings are the ones dropped when the budget runs out.
    for block in reversed(blocks):
        if used + len(block) + 1 > content_budget:
            break
        kept.append(block)
        used += len(block) + 1
    dropped = len(blocks) - len(kept)
    parts = [heading, ""]
    if dropped:
        parts.extend((f"…{dropped} coalesced findings omitted for length…", ""))
    parts.extend(reversed(kept))
    return "\n".join(parts).rstrip()


def followup_review(
    *,
    repo: RepoInfo,
    workspace: Workspace,
    pr_number: int,
    comment_author: str,
    comment_body: str,
    comment_path: str,
    comment_line_range: str,
    thread: tuple = (),
    coalesced: tuple[Mapping[str, Any], ...] = (),
) -> str:
    scope: dict[str, Any] = {
        "repo": repo,
        "workspace": workspace,
        "pr": {"number": pr_number},
        "comment": {
            "author": comment_author,
            "body": comment_body,
            "path": comment_path,
            "line_range": comment_line_range,
        },
        "thread": _render_thread(thread),
    }
    if coalesced:
        # The template has no section conditionals: the whole section (heading
        # included) is one placeholder, empty in the common no-sibling case.
        # `thread` is passed so siblings already rendered in the live thread are
        # not duplicated here; a fully deduped batch renders nothing at all.
        section = _render_coalesced_section(coalesced, thread=thread)
        if section:
            scope["coalesced_section"] = section
    return render(_load("followup_review.md"), scope)


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
