#!/usr/bin/env python3
"""Jev first-pass title/abstract screening into the review store.

For each un-screened record with an abstract: ONE fan-out call with a Noul
per criterion. Records in the clear bands (min criterion probability >=
T_INCLUDE, or <= T_EXCLUDE) get normal review.py verdicts carrying a
[jev-<model> p=...] provenance prefix; everything between stays untouched for
the LLM screener. No API key -> notice on stderr and exit 0 (optional feature).

Verdicts are written ONLY through the review.py CLI, so the state machine and
history stay the single source of truth for PRISMA counts.
"""
import argparse
import json
import os
import subprocess
import sys

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS)
import jev_client  # noqa: E402

REVIEW = os.path.join(SCRIPTS, "review.py")
DEFAULT_INCLUDE = 0.90
DEFAULT_EXCLUDE = 0.10
DEFAULT_MAX_RECORDS = 200


def jev_call(state, questions, api_key, model):
    """Indirection so tests can monkeypatch the network boundary."""
    return jev_client.fan_out(state, questions, api_key, model=model)


def run_review(args):
    return subprocess.run([sys.executable, REVIEW] + args, capture_output=True, text=True)


def build_state(rec):
    """Plain-text record state: one labelled line per field the model judges."""
    return "\n".join([
        f"doi: {rec.get('doi') or ''}",
        f"title: {rec.get('title') or ''}",
        f"abstract: {rec.get('abstract') or ''}",
    ])


def build_questions(criteria):
    return {k: {"type": "noul",
                "instructions": f"Does this record meet the '{k}' criterion: {text}?"}
            for k, text in criteria.items()}


def decide(probs, t_include, t_exclude):
    """(verdict|None, min_key, min_p); None means middle band, leave untouched."""
    min_key = min(probs, key=probs.get)
    min_p = probs[min_key]
    if min_p >= t_include:
        return "include", min_key, min_p
    if min_p <= t_exclude:
        return "exclude", min_key, min_p
    return None, min_key, min_p


def parse_thresholds(s):
    out = {}
    for part in s.split(","):
        k, _, v = part.partition("=")
        out[k.strip()] = float(v)
    if "include" not in out or "exclude" not in out:
        raise SystemExit("--thresholds needs include=.. and exclude=..")
    return out["include"], out["exclude"]


def main(argv=None):
    ap = argparse.ArgumentParser(description="Jev first-pass T/A screening")
    ap.add_argument("--project", required=True, help="project slug or directory")
    ap.add_argument("--criteria", required=True, help="criteria.json path")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--thresholds", default=f"include={DEFAULT_INCLUDE},exclude={DEFAULT_EXCLUDE}")
    ap.add_argument("--model", default="jev-latest")
    args = ap.parse_args(argv)

    api_key = jev_client.resolve_key()
    if not api_key:
        print("jev_screen: Jev first-pass OFF (no TYPESAFE_API_KEY)", file=sys.stderr)
        return 0
    with open(args.criteria, encoding="utf-8") as fh:
        criteria = json.load(fh)
    if not criteria:
        print(f"jev_screen: no criteria in {args.criteria}", file=sys.stderr)
        return 1
    t_include, t_exclude = parse_thresholds(args.thresholds)
    cap = int(os.environ.get("JEV_MAX_RECORDS", DEFAULT_MAX_RECORDS))
    limit = min(args.limit, cap) if args.limit else cap

    r = run_review(["--project", args.project, "next", "--stage", "ta", "--n", str(limit)])
    if r.returncode != 0:
        print(r.stderr.strip(), file=sys.stderr)
        return r.returncode
    records = [json.loads(line) for line in r.stdout.splitlines() if line.strip()]

    questions = build_questions(criteria)
    judged = skipped = failed = 0
    for rec in records:
        if not (rec.get("abstract") or "").strip():
            skipped += 1
            print(f"jev_screen: skip no-abstract {rec['id']}", file=sys.stderr)
            continue
        resp = jev_call(build_state(rec), questions, api_key, args.model)
        model_id = resp.get("model", "unknown")
        probs = {k: float(resp["answers"][k]["noul"]) for k in criteria}
        verdict, min_key, min_p = decide(probs, t_include, t_exclude)
        if verdict is None:
            continue
        prob_line = ", ".join(f"{k}={probs[k]:.2f}" for k in sorted(probs))
        rationale = (f"[{model_id} p={min_p:.2f}] {verdict} on criterion '{min_key}'"
                     f" ({prob_line})")
        # Confidence is in the DECISION, not in "criteria met": a p=0.02 record
        # is a confident exclude. review.py maps the float to HIGH/MEDIUM/LOW.
        confidence = min_p if verdict == "include" else 1.0 - min_p
        cmd = ["--project", args.project, "verdict", "--id", rec["id"], "--stage", "ta",
               "--verdict", verdict, "--rationale", rationale,
               "--confidence", f"{confidence:.4f}"]
        if verdict == "exclude":
            cmd += ["--reason", min_key]
        if args.dry_run:
            print(f"jev_screen (dry-run): {rec['id']} -> {verdict} ({rationale})")
        else:
            vr = run_review(cmd)
            if vr.returncode != 0:
                failed += 1
                print(f"jev_screen: verdict failed for {rec['id']}: {vr.stderr.strip()}",
                      file=sys.stderr)
                continue
        judged += 1
    print(f"jev_screen: judged={judged} skipped_no_abstract={skipped} failed={failed}"
          f" of {len(records)} (bands include>={t_include} exclude<={t_exclude} on min_p)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
