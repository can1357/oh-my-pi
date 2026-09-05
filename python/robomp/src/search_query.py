"""Leaf module for GitHub-issue-search query parsing.

Holds `ParsedSearchQuery` + `parse_search_query`. This is deliberately a
stdlib-only leaf that imports nothing from `robomp`, so both `github_client`
(remote Forgejo search) and `issue_index` (local FTS search) can import it
without creating an import cycle between those two modules.
"""

from __future__ import annotations

from dataclasses import dataclass


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


__all__ = [
    "ParsedSearchQuery",
    "parse_search_query",
]
