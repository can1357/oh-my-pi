#!/usr/bin/env python3
"""Report how often each model edited files with the edit tool versus rewriting
them from an eval cell (read-replace-write surgery).

Usage:
    python scripts/edit-adherence.py [sessions_dir]

Default sessions_dir is ~/.omp/agent/sessions. Output is one row per model:
edit calls, surgery calls, edit failures, and the share of source changes that
bypassed the edit tool.
"""

import collections
import glob
import json
import os
import re
import sys

SRC = re.compile(r"\.(go|ts|tsx|js|jsx|py|rs|css|html|svelte|vue|md|json|ya?ml)\b")
PY_SURGERY = re.compile(r"\bwrite_text\s*\(|\bopen\s*\([^)]*['\"][wa]")
JS_SURGERY = re.compile(r"\bBun\.write\s*\(|\bwriteFileSync\s*\(|\bfs\.promises\.writeFile\s*\(")
SED_SURGERY = re.compile(r"\bsed\b\s+-[a-z]*i|\bperl\b\s+-[a-z]*i|\bpython\b\s+-c|\bnode\b\s+-e")


def rows(path):
    with open(path, encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            try:
                yield json.loads(line)
            except ValueError:
                yield None


def scan(path, stats):
    records = list(rows(path))
    model = None
    for record in records:
        if not record or record.get("type") != "message":
            continue
        message = record["message"]
        role = message.get("role")
        if role == "assistant":
            model = message.get("model") or model
            continue
        if role != "toolResult":
            continue
        tool = message.get("toolName")
        payload = json.dumps(message.get("details") or "")
        entry = stats[model]
        if tool == "edit":
            entry["edit"] += 1
            if message.get("isError"):
                entry["edit_failed"] += 1
        elif tool == "eval" and SRC.search(payload):
            if PY_SURGERY.search(payload) or JS_SURGERY.search(payload):
                entry["surgery"] += 1
        elif tool == "bash" and SRC.search(payload) and SED_SURGERY.search(payload):
            entry["surgery"] += 1


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.omp/agent/sessions")
    stats = collections.defaultdict(lambda: {"edit": 0, "surgery": 0, "edit_failed": 0})
    files = glob.glob(os.path.join(base, "*", "*.jsonl"))
    for path in files:
        scan(path, stats)
    print(f"{len(files)} session files under {base}\n")
    print(f"{'model':28}{'edit':>8}{'surgery':>9}{'fail%':>7}{'bypass%':>9}")
    for model, entry in sorted(stats.items(), key=lambda kv: -(kv[1]["edit"] + kv[1]["surgery"])):
        total = entry["edit"] + entry["surgery"]
        if not model or total < 20:
            continue
        fail = 100 * entry["edit_failed"] / entry["edit"] if entry["edit"] else 0
        print(f"{model:28}{entry['edit']:8}{entry['surgery']:9}{fail:6.1f}%{100 * entry['surgery'] / total:8.0f}%")


if __name__ == "__main__":
    main()
