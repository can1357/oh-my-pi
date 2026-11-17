#!/usr/bin/env python3
"""Conservative per-job path scopes for CI, CodeQL and P8; standard library only."""

import argparse
import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / ".github/ci-job-paths.json"
SHA = re.compile(r"[0-9a-f]{40}\Z")
CI_JOBS = {"format", "format_rust", "protobuf", "lintx_ratchet", "runtime_spec",
           "extensions_conformance", "licenses", "rust", "lint_macos", "lint_linux",
           "p9_p10_linux", "p7_linux", "remote_linux", "affected"}
JOB_KEYS = {"ci": CI_JOBS, "codeql": {"codeql_actions", "codeql_python", "codeql_javascript", "codeql_rust"},
            "p8": {"p8_macos", "p8_linux"}}


class ScopeError(Exception):
    """A scope configuration or change set cannot safely omit checks."""


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ScopeError("duplicate configuration/event key")
        result[key] = value
    return result


def expand(patterns, groups, seen=()):
    if not isinstance(patterns, list) or not patterns:
        raise ScopeError("scope patterns must be a nonempty list")
    result = []
    for pattern in patterns:
        if not isinstance(pattern, str) or not pattern or "\n" in pattern:
            raise ScopeError("invalid scope pattern")
        if pattern.startswith("@"):
            name = pattern[1:]
            if name not in groups or name in seen or len(seen) >= 8:
                raise ScopeError("unknown or recursive scope group")
            result.extend(expand(groups[name], groups, (*seen, name)))
        else:
            if pattern.startswith("/") or ".." in pattern.split("/"):
                raise ScopeError("invalid relative scope pattern")
            result.append(pattern)
    return result


def matches(path, patterns):
    return (any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns if not pattern.startswith("!"))
            and not any(fnmatch.fnmatchcase(path, pattern[1:]) for pattern in patterns if pattern.startswith("!")))


def load_config(path=CONFIG):
    config = json.loads(Path(path).read_text(), object_pairs_hook=object_pairs)
    if not isinstance(config, dict) or set(config) != {"version", "groups", "workflows"} or type(config["version"]) is not int or config["version"] != 1:
        raise ScopeError("unsupported scope schema")
    if not isinstance(config["groups"], dict) or not isinstance(config["workflows"], dict) or set(config["workflows"]) != set(JOB_KEYS):
        raise ScopeError("invalid workflow scopes")
    for name, workflow in config["workflows"].items():
        if (not isinstance(workflow, dict) or set(workflow) != {"global", "ignored", "jobs"}
                or not isinstance(workflow["jobs"], dict) or set(workflow["jobs"]) != JOB_KEYS[name]):
            raise ScopeError("missing or unknown job scope")
        for patterns in [workflow["global"], workflow["ignored"], *workflow["jobs"].values()]:
            expand(patterns, config["groups"])
    return config


def classify(workflow, paths, config=None):
    config = load_config() if config is None else config
    rule = config["workflows"][workflow]
    groups = config["groups"]
    selected = {name: False for name in rule["jobs"]}
    controls = paths is None
    full = paths is None
    for path in paths or []:
        if (not isinstance(path, str) or not path or path.startswith("/") or len(path) > 4096
                or any(part in (".", "..", "") for part in path.split("/"))):
            full = True
            controls = True
            break
        if matches(path, expand(["@mac_controls"], groups)):
            controls = True
        if matches(path, expand(rule["global"], groups)):
            full = True
        hit = False
        for name, patterns in rule["jobs"].items():
            if matches(path, expand(patterns, groups)):
                selected[name] = True
                hit = True
        if not hit and not matches(path, expand(rule["ignored"], groups)):
            full = True
    if full:
        selected = dict.fromkeys(selected, True)
    if workflow == "ci":
        if any(selected.values()):
            selected["format"] = True
        selected["ci"] = any(selected.values())
        selected["macos_controls"] = controls
    elif workflow == "codeql":
        selected["codeql_languages"] = json.dumps([
            language for name, language in (("codeql_actions", "actions"), ("codeql_python", "python"),
                                           ("codeql_javascript", "javascript-typescript"))
            if selected[name]], separators=(",", ":"))
    return selected


def run_command(args, root):
    done = subprocess.run(args, cwd=root, capture_output=True, check=True, timeout=30)
    if len(done.stdout) > 16 * 1024 * 1024:
        raise ScopeError("change response exceeds budget")
    return done.stdout


def diff_names(raw):
    if not raw:
        return []
    fields = raw.split(b"\0")
    if fields.pop() != b"":
        raise ScopeError("incomplete NUL-delimited diff")
    result = []
    while fields:
        status = fields.pop(0).decode("ascii")
        if not re.fullmatch(r"(?:[AMDT]|[RC][0-9]{1,3})", status):
            raise ScopeError("unsupported diff status")
        count = 2 if status[0] in "RC" else 1
        if len(fields) < count:
            raise ScopeError("incomplete rename/deletion diff")
        result.extend(os.fsdecode(fields.pop(0)) for _ in range(count))
    return result


def changed_paths(event_name, event, repository, sha, root=ROOT, run=run_command):
    """None means full checks; no exception can be interpreted as no changes."""
    try:
        if not isinstance(event, dict):
            return None
        if event_name in ("merge_group", "workflow_dispatch", "schedule"):
            return None
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository or ""):
            return None
        if event_name == "pull_request":
            number = event.get("number")
            if type(number) is not int or number <= 0:
                return None
            endpoint = f"repos/{repository}/pulls/{number}"
            metadata = json.loads(run(["gh", "api", endpoint], root), object_pairs_hook=object_pairs)
            expected_pr = event.get("pull_request", {})
            def identity(pr):
                if not isinstance(pr, dict) or not isinstance(pr.get("head"), dict) or not isinstance(pr.get("base"), dict):
                    raise ScopeError("invalid PR identity response")
                return (pr.get("head", {}).get("sha"), pr.get("base", {}).get("sha"), pr.get("changed_files"))
            head, base, expected = identity(metadata)
            expected_head, expected_base, _ = identity(expected_pr)
            if (not isinstance(head, str) or not SHA.fullmatch(head) or not isinstance(base, str)
                    or not SHA.fullmatch(base) or type(expected) is not int or expected < 0
                    or head != expected_head or base != expected_base):
                return None
            raw = run(["gh", "api", "--paginate", "--slurp",
                       f"repos/{repository}/pulls/{number}/files?per_page=100"], root)
            pages = json.loads(raw, object_pairs_hook=object_pairs)
            if not isinstance(pages, list) or any(not isinstance(page, list) for page in pages):
                return None
            files = [item for page in pages for item in page]
            if len(files) >= 3000 or expected != len(files):
                return None
            after = json.loads(run(["gh", "api", endpoint], root), object_pairs_hook=object_pairs)
            if identity(after) != identity(metadata):
                return None
            result = []
            for item in files:
                if not isinstance(item, dict) or not isinstance(item.get("filename"), str):
                    return None
                result.append(item["filename"])
                if item.get("previous_filename"):
                    if not isinstance(item["previous_filename"], str):
                        return None
                    result.append(item["previous_filename"])
            return result
        if event_name != "push":
            return None
        before, after = event.get("before"), event.get("after")
        if (event.get("forced") is not False or not isinstance(before, str) or not SHA.fullmatch(before)
                or before == "0" * 40 or not isinstance(after, str) or not SHA.fullmatch(after)
                or after == "0" * 40 or after != sha):
            return None
        if run(["git", "rev-parse", "HEAD"], root).decode().strip() != after:
            return None
        try:
            run(["git", "cat-file", "-e", before + "^{commit}"], root)
        except subprocess.CalledProcessError:
            run(["git", "fetch", "--no-tags", "--depth=1", "origin", before], root)
            run(["git", "cat-file", "-e", before + "^{commit}"], root)
        return diff_names(run(["git", "diff", "--name-status", "--find-renames", "-z", before, after, "--"], root))
    except (OSError, ValueError, TypeError, KeyError, ScopeError, subprocess.SubprocessError):
        return None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workflow", choices=tuple(JOB_KEYS), required=True)
    parser.add_argument("--github-output", required=True)
    args = parser.parse_args(argv)
    config = load_config()
    try:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(), object_pairs_hook=object_pairs)
        paths = changed_paths(os.environ.get("GITHUB_EVENT_NAME"), event,
                              os.environ.get("GITHUB_REPOSITORY"), os.environ.get("GITHUB_SHA"))
    except (OSError, ValueError, KeyError, ScopeError):
        paths = None
    selected = classify(args.workflow, paths, config)
    with open(args.github_output, "a", encoding="utf-8") as stream:
        for name, value in selected.items():
            encoded = ("true" if value else "false") if isinstance(value, bool) else value
            stream.write(f"{name}={encoded}\n")
    print(json.dumps({"workflow": args.workflow, "full_fallback": paths is None, "checks": selected}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ScopeError, ValueError, TypeError, KeyError, OSError):
        # Missing outputs deliberately leave downstream != false conditions open.
        print("CI scope selection failed; downstream checks must run conservatively", file=sys.stderr)
        sys.exit(1)
