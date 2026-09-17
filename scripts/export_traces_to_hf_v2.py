#!/usr/bin/env python3
"""
export_traces_to_hf_v2.py — v2 ompk session → SFT dataset exporter.

Fixes over v1:
  1. Restores elided tool outputs from message.details + <k>.bash-original.log
     artifacts (v1 emitted "[X result consumed]" placeholders for 81% of results).
  2. Scrubs secrets/PII (emails, phones, addresses, user paths, tokens, known
     canary credentials) and HARD-FAILS if canaries survive.
  3. Drops degenerate sessions (ack-loops), prefix-duplicate sessions,
     assistant-first sessions, and weak-teacher-majority sessions.
  4. Chunks sessions into user-turn-anchored episodes (~24k token cap) with a
     synthetic state-summary prefix for continuation chunks.
  5. Gates episodes on quality signals; emits per-turn teacher + isError so
     downstream masking/weighting is possible.
  6. Includes subagent transcripts (<session_dir>/*.jsonl) as clean
     single-assignment episodes.

Output JSONL record:
  {episode_id, session_id, source, teacher, messages: [...], meta: {...}}
"""

import json
import re
import sys
import hashlib
from pathlib import Path
from collections import Counter, defaultdict

RAW_DIR = Path(r"C:\Users\prest\.ompk\agent\sessions\--C--dev-desktop-projects-Interconnection-Dash-2026--")
OUT_PATH = Path("interconnection_dash_traces_v2.jsonl")

# ---------------------------------------------------------------- scrubbing
CANARIES = ["P-K-Haxx1!", "p-k-hAXX1!"]
SCRUB_RULES = [
    (re.compile(r'sk-[A-Za-z0-9_-]{16,}'), "<SECRET>"),
    (re.compile(r'ghp_[A-Za-z0-9]{20,}'), "<SECRET>"),
    (re.compile(r'AKIA[0-9A-Z]{16}'), "<SECRET>"),
    (re.compile(r'Bearer\s+[A-Za-z0-9._-]{20,}'), "Bearer <SECRET>"),
    (re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'), "<EMAIL>"),
    (re.compile(r'(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}'), "<PHONE>"),
    (re.compile(r'[A-Za-z]:[\\/]+Users[\\/]+prest', re.I), "<USER_HOME>"),
    (re.compile(r'[a-z0-9]+_nackos_[a-z_]+', re.I), "<SP_USER>"),
    (re.compile(r'\b\d{2,6}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+'
                r'(?:Rd|Road|St|Street|Ave|Avenue|Dr|Drive|Ln|Lane|Ct|Court|'
                r'Blvd|Boulevard|Way|Pl|Place|Ter|Terrace|Cir|Circle)\b'), "<ADDRESS>"),
]
for c in CANARIES:
    SCRUB_RULES.insert(0, (re.compile(re.escape(c), re.I), "<PASSWORD>"))

scrub_hits = Counter()

def scrub(text: str) -> str:
    if not text:
        return text
    for pat, repl in SCRUB_RULES:
        text, n = pat.subn(repl, text)
        if n:
            scrub_hits[repl] += n
    return text

# ------------------------------------------------------- output restoration
MAX_TOOL_CHARS = 4000

def _trunc(t: str) -> str:
    if len(t) > MAX_TOOL_CHARS:
        return t[:MAX_TOOL_CHARS] + f"\n…[truncated {len(t)-MAX_TOOL_CHARS} chars]"
    return t

def restore_tool_output(msg: dict, bash_log: str | None) -> str:
    """Recover full tool output from details/artifacts; fall back to content."""
    name = msg.get("toolName", "")
    det = msg.get("details") or {}
    out = None

    if name == "read":
        dc = det.get("displayContent") or {}
        out = dc.get("text")
    elif name == "eval":
        cells = det.get("cells") or []
        if cells:
            out = "\n".join(str(c.get("output", "")) for c in cells if c.get("output"))
    elif name == "edit":
        diff = det.get("diff")
        if diff:
            out = diff
        elif det.get("oldText") is not None:
            out = f"--- old\n{det.get('oldText')}\n+++ new\n{det.get('newText')}"
    elif name in ("grep", "glob"):
        files = det.get("files") or []
        if files:
            head = f"{det.get('fileCount', len(files))} files"
            if det.get("matchCount") is not None:
                head += f", {det['matchCount']} matches"
            out = head + ":\n" + "\n".join(str(f) for f in files[:500])
    elif name == "search_tool_bm25":
        tools = det.get("tools") or det.get("activated_tools") or []
        if tools:
            out = "activated: " + ", ".join(str(t) for t in tools[:50])
    elif name == "todo":
        phases = det.get("phases") or []
        if phases:
            out = json.dumps(phases)[:MAX_TOOL_CHARS]
    elif name == "bash" and bash_log:
        out = bash_log

    if not out:
        c = msg.get("content")
        if isinstance(c, str):
            out = c
        elif isinstance(c, list):
            out = "\n".join(b.get("text", "") for b in c if isinstance(b, dict))
    return _trunc((out or "").strip())

# ------------------------------------------------------------- parse session
def parse_session(path: Path, artifact_dir: Path | None):
    """Return (messages, meta). messages carry teacher/is_error/restored flags."""
    msgs = []
    bash_call_n = 0
    header = {}
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = d.get("type")
            if t == "session":
                header = d
                continue
            if t != "message":
                continue
            m = d["message"]
            role = m.get("role")

            if role == "user":
                text = _extract_text(m.get("content"))
                if text.strip():
                    msgs.append({"role": "user", "content": scrub(text.strip())})

            elif role == "assistant":
                texts, thinks, calls = [], [], []
                for b in (m.get("content") or []):
                    if not isinstance(b, dict):
                        continue
                    bt = b.get("type")
                    if bt == "text":
                        texts.append(b.get("text", ""))
                    elif bt == "thinking":
                        th = b.get("thinking", "")
                        if th:
                            thinks.append(th)
                    elif bt == "toolCall":
                        if b.get("name") == "bash":
                            bash_call_n += 1
                            b["_bash_ord"] = bash_call_n
                        calls.append(b)
                rec = {
                    "role": "assistant",
                    "content": scrub("\n".join(texts).strip()),
                    "teacher": m.get("model") or m.get("provider") or "unknown",
                }
                if thinks:
                    rec["reasoning_content"] = scrub("\n\n".join(thinks).strip())
                if calls:
                    rec["tool_calls"] = [
                        {"id": c.get("id", ""), "type": "function",
                         "function": {"name": c.get("name", ""),
                                      "arguments": scrub(json.dumps(
                                          c.get("arguments", {}),
                                          ensure_ascii=False))},
                         "_bash_ord": c.get("_bash_ord")}
                        for c in calls]
                if rec["content"] or rec.get("reasoning_content") or rec.get("tool_calls"):
                    msgs.append(rec)

            elif role == "toolResult":
                name = m.get("toolName", "")
                log_text = None
                if name == "bash" and artifact_dir:
                    # find ordinal of the matching bash call: count bash results so far
                    res_n = sum(1 for x in msgs
                                if x.get("role") == "tool" and x.get("name") == "bash") + 1
                    lp = artifact_dir / f"{res_n}.bash-original.log"
                    if lp.exists():
                        try:
                            log_text = lp.read_text(encoding="utf-8", errors="replace")
                        except Exception:
                            pass
                out = restore_tool_output(m, log_text)
                rec = {"role": "tool", "tool_call_id": m.get("toolCallId", ""),
                       "name": name, "content": scrub(out)}
                if m.get("isError"):
                    rec["is_error"] = True
                if out and not out.startswith("["):
                    rec["restored"] = True
                msgs.append(rec)
    return msgs, header

def _extract_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict))
    return str(content or "")

# ---------------------------------------------------------- session filters
ACK_WORDS = {"acknowledged.", "operational.", "passed.", "done.", "ok.", "noted."}

def is_degenerate(msgs) -> bool:
    users = [m["content"] for m in msgs if m["role"] == "user"]
    if len(users) > 50:
        dup_ratio = 1 - len(set(u[:120] for u in users)) / len(users)
        if dup_ratio > 0.5:
            return True
    assistants = [m["content"].strip().lower() for m in msgs
                  if m["role"] == "assistant" and m["content"]]
    if len(assistants) > 30:
        ack = sum(1 for a in assistants if a in ACK_WORDS)
        if ack / len(assistants) > 0.2:
            return True
    return False

def session_prefix_key(msgs, k=6) -> str:
    parts = []
    for m in msgs:
        if m["role"] in ("user", "assistant") and m.get("content"):
            parts.append(m["content"][:200])
        if len(parts) >= k:
            break
    return hashlib.sha1("||".join(parts).encode()).hexdigest()

# ------------------------------------------------------------- episode build
CHARS_PER_TOKEN = 4
EPISODE_TOKEN_CAP = 24_000
OVERHEAD_TOOLS = {"todo", "irc", "job", "ix_bridge", "search_tool_bm25"}

def chunk_episodes(msgs):
    """Split at user-turn boundaries; cap ~24k tokens."""
    bounds = [i for i, m in enumerate(msgs) if m["role"] == "user"] + [len(msgs)]
    episodes, cur, cur_chars = [], [], 0
    cap = EPISODE_TOKEN_CAP * CHARS_PER_TOKEN
    for a, b in zip(bounds, bounds[1:]):
        seg = msgs[a:b]
        seg_chars = sum(len(m.get("content", "")) + len(m.get("reasoning_content", ""))
                        + sum(len(tc["function"]["arguments"]) for tc in m.get("tool_calls", []))
                        for m in seg)
        if cur and cur_chars + seg_chars > cap:
            episodes.append(cur)
            cur, cur_chars = [], 0
        cur.extend(seg)
        cur_chars += seg_chars
    if cur:
        episodes.append(cur)
    return episodes

def gate_episode(ep, is_first: bool) -> tuple[bool, str]:
    users = [m for m in ep if m["role"] == "user"]
    if is_first:
        if not users or len(users[0]["content"]) < 25:
            return False, "thin_prompt"
    assistants = [m for m in ep if m["role"] == "assistant"]
    if not assistants or not assistants[-1].get("content"):
        return False, "no_final_answer"
    # consecutive errors
    consec = mx = 0
    for m in ep:
        if m["role"] == "tool" and m.get("is_error"):
            consec += 1; mx = max(mx, consec)
        elif m["role"] == "assistant":
            consec = 0
    if mx >= 3:
        return False, "error_spiral"
    # duplicate calls
    sigs = Counter()
    for m in ep:
        for tc in m.get("tool_calls", []):
            sigs[(tc["function"]["name"], tc["function"]["arguments"][:200])] += 1
    if sigs and max(sigs.values()) >= 3:
        return False, "dup_calls"
    # thinking fence leak
    for m in ep:
        if "```thinking" in (m.get("content") or ""):
            return False, "thinking_fence"
    # overhead ratio
    tool_turns = sum(1 for m in ep if m["role"] == "tool")
    overhead = sum(1 for m in ep if m["role"] == "tool" and m.get("name") in OVERHEAD_TOOLS)
    if tool_turns and overhead / tool_turns > 0.4:
        return False, "overhead_heavy"
    # error ratio
    errs = sum(1 for m in ep if m["role"] == "tool" and m.get("is_error"))
    if tool_turns and errs / tool_turns > 0.25:
        return False, "error_heavy"
    return True, "ok"

# -------------------------------------------------------------------- main
def main():
    session_files = sorted(p for p in RAW_DIR.glob("*.jsonl"))
    sub_files = sorted(RAW_DIR.glob("*/*.jsonl"))
    print(f"{len(session_files)} sessions, {len(sub_files)} subagent transcripts")

    # pass 1: per-teacher error rates (for weak-teacher detection)
    teacher_calls = Counter(); teacher_errs = Counter()
    parsed = {}
    for p in session_files + sub_files:
        adir = p.parent if p.parent != RAW_DIR else (RAW_DIR / p.stem)
        adir = adir if adir.is_dir() else None
        msgs, header = parse_session(p, adir)
        parsed[p] = (msgs, header)
        for m in msgs:
            if m["role"] == "assistant":
                t = m.get("teacher", "unknown")
                teacher_calls[t] += len(m.get("tool_calls", []))
            elif m["role"] == "tool" and m.get("is_error"):
                # attribute error to last assistant teacher
                for prev in reversed(msgs[:msgs.index(m)]):
                    if prev["role"] == "assistant":
                        teacher_errs[prev.get("teacher", "unknown")] += 1
                        break
    weak = {t for t in teacher_calls
            if teacher_calls[t] >= 50 and teacher_errs[t] / teacher_calls[t] > 0.15}
    print("weak teachers (>15% err, ≥50 calls):", weak or "none")

    # pass 2: session filters → prefix dedup → episodes → gates
    prefix_groups = defaultdict(list)
    kept_sessions = []
    drop_stats = Counter()
    for p in session_files:
        msgs, header = parsed[p]
        if not msgs or msgs[0]["role"] != "user":
            drop_stats["assistant_first_or_empty"] += 1; continue
        if is_degenerate(msgs):
            drop_stats["degenerate"] += 1; continue
        teachers = Counter(m.get("teacher") for m in msgs if m["role"] == "assistant")
        if teachers and teachers.most_common(1)[0][0] in weak:
            drop_stats["weak_teacher"] += 1; continue
        prefix_groups[session_prefix_key(msgs)].append((p, len(msgs)))
        kept_sessions.append(p)

    keep = set()
    for key, group in prefix_groups.items():
        keep.add(max(group, key=lambda x: x[1])[0])  # longest chain member
    drop_stats["prefix_dup"] = len(kept_sessions) - len(keep)

    records = []
    ep_stats = Counter()
    for p in sorted(keep):
        msgs, header = parsed[p]
        for ei, ep in enumerate(chunk_episodes(msgs)):
            ok, why = gate_episode(ep, is_first=(ei == 0))
            ep_stats[why] += 1
            if not ok:
                continue
            if ei > 0:
                ep = [{"role": "user",
                       "content": "[state] Continuing prior work session; "
                                  "earlier context summarized. Resume the task."}] + ep
            teachers = Counter(m.get("teacher") for m in ep if m["role"] == "assistant")
            records.append({
                "episode_id": f"{p.stem}#{ei}",
                "session_id": p.stem,
                "source": "session",
                "teacher": teachers.most_common(1)[0][0] if teachers else "unknown",
                "messages": ep,
                "meta": {"turns": len(ep),
                         "chars": sum(len(m.get("content", "")) for m in ep),
                         "has_reasoning": any(m.get("reasoning_content") for m in ep),
                         "restored_outputs": sum(1 for m in ep if m.get("restored"))},
            })

    # subagent transcripts → own episodes
    for p in sub_files:
        msgs, header = parsed[p]
        if not msgs or msgs[0]["role"] != "user":
            continue
        for ei, ep in enumerate(chunk_episodes(msgs)):
            ok, why = gate_episode(ep, is_first=(ei == 0))
            ep_stats[f"sub_{why}"] += 1
            if not ok:
                continue
            teachers = Counter(m.get("teacher") for m in ep if m["role"] == "assistant")
            records.append({
                "episode_id": f"{p.stem}#{ei}",
                "session_id": p.stem,
                "source": "subagent",
                "teacher": teachers.most_common(1)[0][0] if teachers else "unknown",
                "messages": ep,
                "meta": {"turns": len(ep),
                         "chars": sum(len(m.get("content", "")) for m in ep),
                         "has_reasoning": any(m.get("reasoning_content") for m in ep),
                         "restored_outputs": sum(1 for m in ep if m.get("restored"))},
            })

    # canary hard-fail
    blob = json.dumps(records, ensure_ascii=False)
    for c in CANARIES:
        if c.lower() in blob.lower():
            print(f"FATAL: canary {c!r} survived scrubbing — refusing to write")
            sys.exit(2)

    with OUT_PATH.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    restored = sum(r["meta"]["restored_outputs"] for r in records)
    total_tool = sum(1 for r in records for m in r["messages"] if m["role"] == "tool")
    print(f"\n=== v2 export ===")
    print(f"sessions kept: {len(keep)}/{len(session_files)}  drops: {dict(drop_stats)}")
    print(f"episodes kept: {len(records)}  gate outcomes: {dict(ep_stats)}")
    print(f"tool outputs restored: {restored}/{total_tool} "
          f"({100*restored/max(1,total_tool):.1f}%)")
    print(f"scrub hits: {dict(scrub_hits)}")
    print(f"wrote {OUT_PATH} ({OUT_PATH.stat().st_size/1e6:.1f} MB)")

if __name__ == "__main__":
    main()
