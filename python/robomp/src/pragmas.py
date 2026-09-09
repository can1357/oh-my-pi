"""Slash-command pragmas for maintainer directives.

A *pragma* is a piece of structured metadata a maintainer attaches to a
directive comment to steer the agent run. The wire syntax is slash-commands
on their own line (chatops convention; identical surface to Slack / Discord
/ Probot):

```
@robomp-bot /model gpt /thinking low
fix the off-by-one in foo()
```

Or stacked:

```
@robomp-bot
/model gpt
/thinking low
fix the off-by-one
```

Either `/key value` or `/key=value` form is accepted. A line is consumed
**only** when every whitespace-separated token on it is a valid slash
command — that way an inline `/path/to/file` reference in prose never
accidentally tokenizes. Consumed lines are stripped from the body before the
agent ever sees them. Non-directive comments (random users) carry no
pragmas; this whole surface only applies once the comment is already trusted
as a directive (reviewer-bot or maintainer-mention).

Supported keys (today):

- `/model <alias>` — pick the first id in `ROBOMP_MODEL` whose model id
  contains `<alias>` (case-insensitive). Falls back to the normal random
  pool selection if no member matches.
- `/thinking <level>` — override `ROBOMP_THINKING` for this run. Accepts
  `off|none|no`, `lo|low`, `med|medium`, `hi|high`, `xhi|xhigh`, `max`
  (case-insensitive); anything else is ignored.

Parser semantics:

- Pure-command lines are stripped from the body.
- Mixed lines (commands + prose) are NOT consumed: the line stays verbatim
  and no pragmas are extracted from it. Put commands on their own line.
- Duplicate keys keep insertion order; callers decide last-vs-first wins.
"""

from __future__ import annotations

import re
from typing import Literal

ThinkingLevel = Literal["off", "low", "medium", "high", "xhigh", "max"]

# Key = ascii lowercase / digit / dash / underscore, must start with a letter.
# The value (when using `/key=value` form) runs to end-of-token.
_KEY_RE = re.compile(r"^[a-z][a-z0-9_-]*$", re.IGNORECASE)


def _parse_command_line(line: str) -> tuple[tuple[str, str], ...] | None:
    """Parse one line as a sequence of slash commands.

    Returns the parsed `(key, value)` pairs, or `None` if the line is not a
    pure command line (mixed content, malformed, or empty after trim).
    """
    stripped = line.strip()
    if not stripped or not stripped.startswith("/"):
        return None
    tokens = stripped.split()
    pairs: list[tuple[str, str]] = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if not tok.startswith("/") or len(tok) < 2:
            return None
        # `/key=value` form lives inside one token.
        if "=" in tok:
            key, _, value = tok[1:].partition("=")
            if not _KEY_RE.match(key) or not value:
                return None
            pairs.append((key.lower(), value))
            i += 1
            continue
        # `/key value` form needs the next token as value, which must not
        # itself be a command (otherwise `/key` had no value).
        key = tok[1:]
        if not _KEY_RE.match(key):
            return None
        if i + 1 >= len(tokens) or tokens[i + 1].startswith("/"):
            return None
        pairs.append((key.lower(), tokens[i + 1]))
        i += 2
    return tuple(pairs) if pairs else None


def parse_pragmas(body: str) -> tuple[str, tuple[tuple[str, str], ...]]:
    """Split `body` into (cleaned_body, pragmas).

    Scans line-by-line. Pure command lines are removed; everything else is
    preserved verbatim, including blank lines between content. Leading and
    trailing whitespace on the final body is trimmed.
    """
    if not body:
        return body, ()
    found: list[tuple[str, str]] = []
    kept: list[str] = []
    # `splitlines(keepends=True)` preserves the original line endings so we
    # don't accidentally normalize CRLF.
    for line in body.splitlines(keepends=True):
        # Strip the trailing newline only for parsing; we'll drop the whole
        # line on a match either way.
        bare = line.rstrip("\r\n")
        commands = _parse_command_line(bare)
        if commands is None:
            kept.append(line)
            continue
        found.extend(commands)
    cleaned = "".join(kept).strip("\r\n")
    return cleaned, tuple(found)


def pragma_value(pragmas: tuple[tuple[str, str], ...], key: str) -> str | None:
    """Return the last value for `key` (last-wins), or None if absent."""
    target = key.lower()
    result: str | None = None
    for k, v in pragmas:
        if k == target:
            result = v
    return result


def resolve_model_alias(alias: str, pool: tuple[str, ...]) -> str | None:
    """Case-insensitive match of `alias` against each member of `pool`.

    Precedence: full-id exact > short-name-after-slash exact > substring.
    Returns the first match in pool order, or None if nothing matches.
    """
    needle = alias.strip().lower()
    if not needle:
        return None
    exact: str | None = None
    partial: str | None = None
    for model in pool:
        lower = model.lower()
        if lower == needle:
            return model
        if exact is None and lower.rsplit("/", 1)[-1] == needle:
            exact = model
        if partial is None and needle in lower:
            partial = model
    return exact or partial


# Spelling aliases for the `/thinking` pragma. Lowercased; whitespace-stripped
# input is looked up directly.
_THINKING_ALIASES: dict[str, ThinkingLevel] = {
    "off": "off",
    "none": "off",
    "no": "off",
    "lo": "low",
    "low": "low",
    "med": "medium",
    "medium": "medium",
    "hi": "high",
    "high": "high",
    "xhi": "xhigh",
    "xhigh": "xhigh",
    "max": "max",
}


def resolve_thinking_level(value: str) -> ThinkingLevel | None:
    """Normalize a thinking pragma to a canonical level, or None if unknown."""
    return _THINKING_ALIASES.get(value.strip().lower())


__all__ = [
    "ThinkingLevel",
    "parse_pragmas",
    "pragma_value",
    "resolve_model_alias",
    "resolve_thinking_level",
]
