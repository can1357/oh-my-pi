#!/usr/bin/env python3
"""Maintain the generated contributor registry in CONTRIBUTORS.md.

Sources: non-anonymous commit authors (contributors API) and merged
pull-request authors. The owner, bot accounts, GitHub's web-flow identity
and per-repo EXTRA_EXCLUDE logins are excluded. Pagination and API errors
fail closed: a partial list is never written. Only the region between the
generated markers changes; donor and other hand-written sections stay
byte-identical. Exits non-zero (or refuses to write) on any API failure.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

API_ROOT = "https://api.github.com"
PER_PAGE = 100
BEGIN_MARKER = (
    "<!-- BEGIN GENERATED CONTRIBUTORS (contributors.yml; do not hand-edit) -->"
)
END_MARKER = "<!-- END GENERATED CONTRIBUTORS -->"
DEFAULT_EXCLUDE = {
    "web-flow",  # GitHub's own web-flow commit identity
}
BOT_SUFFIX = "[bot]"
FILE_TITLE = "# Contributors"
EMPTY_REGISTRY_LINE = "_No outside contributor accounts recorded yet._"
ANON_NOTE = (
    "_Linked GitHub accounts only. Anonymous (unlinked) commit authors are\n"
    "enumerable through the API (anon=true) but are identified there only by\n"
    "name/email, which this registry does not publish; credit them by hand in\n"
    "the sections above where known._"
)


class ApiError(RuntimeError):
    """Raised on any HTTP, JSON or pagination anomaly: never write partial data."""


def _fetch(get_json, url):
    status, body, nxt = get_json(url)
    if status != 200 or not isinstance(body, list):
        raise ApiError("%s: HTTP %s, expected a JSON array" % (url, status))
    return body, nxt


def fetch_all(get_json, path):
    """Collect every page. GitHub sends a Link rel="next" header whenever
    another page exists, so a full page with no next link is a complete
    listing (total is an exact multiple of the page size). A SHORT page
    carrying a next link is inconsistent and fails closed."""
    separator = "&" if "?" in path else "?"
    url = "%s/%s%sper_page=%d" % (API_ROOT, path, separator, PER_PAGE)
    items = []
    while True:
        page, nxt = _fetch(get_json, url)
        items.extend(page)
        if len(page) < PER_PAGE:
            if nxt:
                raise ApiError("%s: short page with a next link" % path)
            return items
        if not nxt:
            return items
        url = nxt


def _login(entry):
    if isinstance(entry, dict):
        return entry.get("login")
    return entry


def _is_bot(entry):
    """Bot detection from the API's own type field where present, else the
    documented [bot] login suffix. Real humans are never guessed at."""
    if isinstance(entry, dict) and entry.get("type") == "Bot":
        return True
    login = _login(entry)
    return bool(login) and login.casefold().endswith(BOT_SUFFIX)


def _entry_login(entry):
    login = _login(entry)
    return login if isinstance(login, str) else None


def collect_authors(contributors, pr_authors, owner, extra_exclude=()):
    """Deterministic union: case-insensitive dedup, case-insensitive sort,
    first-seen casing wins (contributors API casing is canonical)."""
    excluded = {name.casefold() for name in ({owner} | DEFAULT_EXCLUDE | set(extra_exclude))}
    seen = {}
    for source in (contributors, pr_authors):
        for entry in source:
            login = _entry_login(entry)
            if not login or _is_bot(entry):
                continue
            key = login.casefold()
            if key in seen or key in excluded:
                continue
            seen[key] = login
    return [seen[key] for key in sorted(seen)]


def render_registry(entries):
    lines = ["- [@%s](https://github.com/%s)" % (name, name) for name in entries]
    body = "\n".join(lines) if lines else EMPTY_REGISTRY_LINE
    return "%s\n\n%s\n\n%s\n\n%s" % (BEGIN_MARKER, body, ANON_NOTE, END_MARKER)


def update_contributors_md(existing, registry):
    """Return (new_text, changed). With no markers in an existing file the
    file is hand-managed and left untouched. Never rewrites donor/manual
    text outside the markers. Reads and writes with newline='' so CRLF
    donor bytes survive round-trips untouched."""
    if existing is None:
        return "%s\n\n%s\n\n" % (FILE_TITLE, registry), True
    if BEGIN_MARKER not in existing and END_MARKER not in existing:
        return existing, False
    if existing.count(BEGIN_MARKER) != 1 or existing.count(END_MARKER) != 1:
        raise ValueError("expected exactly one pair of generated markers")
    begin_at = existing.index(BEGIN_MARKER)
    end_at = existing.index(END_MARKER)
    if begin_at > end_at:
        raise ValueError("END marker precedes BEGIN marker")
    new_text = existing[:begin_at] + registry + existing[end_at + len(END_MARKER):]
    return new_text, new_text != existing


def _write_atomic(path, text):
    """Replace path's content only after the full new content is on disk in
    the same directory; a failed write never truncates the original."""
    import tempfile
    directory = os.path.dirname(os.path.abspath(path))
    handle = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", newline="", dir=directory, delete=False
    )
    try:
        with handle:
            handle.write(text)
        os.replace(handle.name, path)
    except BaseException:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise


def _next_link(header_value):
    """Extract the rel="next" URL from a GitHub Link header, else None."""
    if not header_value:
        return None
    for part in header_value.split(","):
        segment = part.strip()
        if segment.endswith('rel="next"'):
            url = segment[:-len('rel="next"')].strip().rstrip(";").strip()
            if url.startswith("<") and url.endswith(">"):
                return url[1:-1]
    return None


def http_get_json(url, token):
    request = urllib.request.Request(url)
    request.add_header("Authorization", "Bearer %s" % token)
    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("X-GitHub-Api-Version", "2022-11-28")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return (
                response.status,
                json.loads(response.read()),
                _next_link(response.headers.get("Link")),
            )
    except urllib.error.HTTPError as error:
        return error.code, {}, None


def _env_settings():
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    owner, _, repo = repository.partition("/")
    if not owner or not repo:
        raise SystemExit("GITHUB_REPOSITORY must be owner/repo")
    extra = [
        name.strip().casefold()
        for name in os.environ.get("EXTRA_EXCLUDE", "").split(",")
        if name.strip()
    ]
    path = os.environ.get("CONTRIBUTORS_PATH", "CONTRIBUTORS.md")
    return owner, repo, extra, path


def _load_existing(path):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


def _pr_author_logins(pulls):
    """Author dicts (login + type preserved for bot detection) of MERGED
    pull requests only; rejected/closed-unmerged authors are not
    contributors. Ghosted users are skipped."""
    authors = []
    for pull in pulls:
        if not isinstance(pull, dict) or not pull.get("merged_at"):
            continue
        user = pull.get("user")
        if isinstance(user, dict) and user.get("login"):
            authors.append(user)
    return authors


def _registry_from_api(get_json, owner, repo, extra_exclude):
    contributors = fetch_all(get_json, "repos/%s/%s/contributors?anon=false" % (owner, repo))
    pulls = fetch_all(get_json, "repos/%s/%s/pulls?state=closed" % (owner, repo))
    entries = collect_authors(contributors, _pr_author_logins(pulls), owner, extra_exclude)
    return render_registry(entries), entries


def _token_get_json(url):
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        raise SystemExit("GITHUB_TOKEN is required")
    return http_get_json(url, token)


def _emit(new_text, changed, destination):
    if destination is not None:
        _write_atomic(destination, new_text)
    print("CHANGED=%s" % str(changed).lower())
    return 0


def main(argv=None, get_json=None, existing_text=None, repo=None, owner=None,
         extra_exclude=(), contributors_path="CONTRIBUTORS.md", write_to=None):
    argv = sys.argv[1:] if argv is None else argv
    if get_json is None:
        owner, repo, extra_exclude, contributors_path = _env_settings()
        get_json = _token_get_json
    if existing_text is None:
        existing_text = _load_existing(contributors_path)

    registry, entries = _registry_from_api(get_json, owner, repo, extra_exclude)
    new_text, changed = update_contributors_md(existing_text, registry)
    if "--check" in argv:
        print("registry up to date" if not changed else "registry drift detected")
        return (1 if changed else 0), new_text, changed
    return _emit(new_text, changed, write_to or contributors_path), new_text, changed


if __name__ == "__main__":
    code = main()[0]
    sys.exit(code)
