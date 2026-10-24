#!/usr/bin/env python3
"""PRISMA-ScR flow diagram derived from the review store (review.db).

Every count is computed from record states, so the arithmetic reconciles by
construction — there is no way to hand-type a number here. Formats:

  text     box-drawn flow for the terminal (default)
  mermaid  fenced flowchart for manuscripts/GitHub
  svg      standalone PRISMA-ScR 2018 four-stage layout
  html     the same SVG wrapped in a minimal page
"""
import argparse
import json
import os
import sys
from xml.sax.saxutils import escape

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import review


def derive(con):
    c = review.counts(con)
    s = c["by_state"]
    identified = c["total"]
    duplicates = s["duplicate"]
    screened = identified - duplicates
    ta_excluded = s["screened_excluded"]
    ta_pending = s["identified"]
    sought = screened - ta_excluded - ta_pending
    post_ta = (s["screened_included"] + s["fulltext_sought"] + s["fulltext_retrieved"]
               + s["fulltext_not_retrieved"] + s["fulltext_excluded"] + s["included"])
    assert sought == post_ta, f"state sums diverged: {sought} != {post_ta}"
    return {
        "identified": identified,
        "by_source": c["by_source"],
        "duplicates": duplicates,
        "screened": screened,
        "ta_excluded": ta_excluded,
        "ta_reasons": c["ta_exclusion_reasons"],
        "ta_pending": ta_pending,
        "ta_maybe": c["ta_maybe"],
        "sought": sought,
        "not_retrieved": s["fulltext_not_retrieved"],
        "nr_reasons": c["not_retrieved_reasons"],
        "retrieval_pending": s["screened_included"] + s["fulltext_sought"],
        "assessed": s["fulltext_retrieved"] + s["fulltext_excluded"] + s["included"],
        "ft_excluded": s["fulltext_excluded"],
        "ft_reasons": c["ft_exclusion_reasons"],
        "ft_pending": s["fulltext_retrieved"],
        "included": s["included"],
    }


def reason_lines(reasons, indent="  "):
    return [f"{indent}{r}: {n}" for r, n in reasons.items()]


def stages(d):
    """(stage, main-box lines, side lines) rows shared by every renderer."""
    ident = [f"Records identified (n={d['identified']})"]
    ident += [f"  {db}: {n}" for db, n in d["by_source"].items()]
    rows = [
        ("Identification", ident,
         [f"Duplicate records removed (n={d['duplicates']})"]),
        ("Screening", [f"Records screened (n={d['screened']})"],
         [f"Records excluded (n={d['ta_excluded']})"] + reason_lines(d["ta_reasons"])),
        ("Screening", [f"Reports sought for retrieval (n={d['sought']})"],
         [f"Reports not retrieved (n={d['not_retrieved']})"] + reason_lines(d["nr_reasons"])),
        ("Eligibility", [f"Reports assessed for eligibility (n={d['assessed']})"],
         [f"Reports excluded (n={d['ft_excluded']})"] + reason_lines(d["ft_reasons"])),
        ("Included", [f"Studies included in review (n={d['included']})"], []),
    ]
    return rows


def pending_notes(d):
    notes = []
    if d["ta_pending"]:
        maybe = f" ({d['ta_maybe']} maybe)" if d["ta_maybe"] else ""
        notes.append(f"awaiting title/abstract screening: {d['ta_pending']}{maybe}")
    if d["retrieval_pending"]:
        notes.append(f"awaiting full-text retrieval: {d['retrieval_pending']}")
    if d["ft_pending"]:
        notes.append(f"awaiting full-text screening: {d['ft_pending']}")
    return notes


# ---------------- text ----------------


def render_text(slug, d):
    rows = stages(d)
    width = max(len(line) for _, main, _ in rows for line in main) + 2
    out = [f"PRISMA-ScR flow — {slug} (derived from review.db)", ""]
    last_stage = None
    for i, (stage, main, side) in enumerate(rows):
        if stage != last_stage:
            out.append(f"{stage.upper()}")
            last_stage = stage
        out.append("┌" + "─" * width + "┐")
        for line in main:
            out.append("│ " + line.ljust(width - 2) + " │")
        if i < len(rows) - 1:
            out.append("└" + "─" * (width // 2) + "┬" + "─" * (width - width // 2 - 1) + "┘")
            pad = " " * (width // 2 + 1)
            if side:
                out.append(pad + "├─▶ " + side[0])
                for extra in side[1:]:
                    out.append(pad + "│     " + extra.strip())
            out.append(pad + "▼")
        else:
            out.append("└" + "─" * width + "┘")
    notes = pending_notes(d)
    if notes:
        out.append("")
        out.extend(f"NOTE: {n}" for n in notes)
    out.append("")
    def step(total, minus, minus_label, pending, result, result_label):
        s = f"{total} - {minus} {minus_label}"
        if pending:
            s += f" - {pending} pending"
        return s + f" = {result} {result_label}"

    out.append("arithmetic: " + "; ".join([
        step(d["identified"], d["duplicates"], "duplicates", 0, d["screened"], "screened"),
        step(d["screened"], d["ta_excluded"], "excluded", d["ta_pending"],
             d["sought"], "sought"),
        step(d["sought"], d["not_retrieved"], "not retrieved", d["retrieval_pending"],
             d["assessed"], "assessed"),
        step(d["assessed"], d["ft_excluded"], "excluded", d["ft_pending"],
             d["included"], "included"),
    ]))
    return "\n".join(out)


# ---------------- mermaid ----------------


def render_mermaid(slug, d):
    def label(lines):
        return "<br/>".join(l.strip() for l in lines)

    rows = stages(d)
    ids = ["identified", "screened", "sought", "assessed", "included"]
    side_ids = ["dupes", "ta_excluded", "not_retrieved", "ft_excluded", None]
    out = ["```mermaid", "flowchart TD"]
    for (stage, main, side), nid, sid in zip(rows, ids, side_ids):
        out.append(f'    {nid}["{label(main)}"]')
        if side and sid:
            out.append(f'    {sid}["{label(side)}"]')
    for a, b in zip(ids, ids[1:]):
        out.append(f"    {a} --> {b}")
    for nid, sid in zip(ids, side_ids):
        if sid:
            out.append(f"    {nid} -.-> {sid}")
    out.append("```")
    return "\n".join(out)


# ---------------- svg ----------------

FONT = 14
LINE_H = 20
PAD = 10
MAIN_X, MAIN_W = 190, 340
SIDE_X, SIDE_W = 570, 320
LABEL_W = 150
GAP = 46


def _svg_box(out, x, y, w, lines, bold_first=True):
    h = len(lines) * LINE_H + 2 * PAD
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="#fff" '
               f'stroke="#333" stroke-width="1.5" rx="4"/>')
    ty = y + PAD + FONT
    for i, line in enumerate(lines):
        weight = ' font-weight="bold"' if bold_first and i == 0 else ""
        out.append(f'<text x="{x + PAD}" y="{ty}" font-size="{FONT}"{weight}>'
                   f"{escape(line)}</text>")
        ty += LINE_H
    return h


def render_svg(slug, d):
    rows = stages(d)
    body = []
    y = 60
    stage_spans = []  # (stage, y0, y1)
    prev_bottom = None
    for stage, main, side in rows:
        h = len(main) * LINE_H + 2 * PAD
        side_h = (len(side) * LINE_H + 2 * PAD) if side else 0
        if prev_bottom is not None:
            mid_x = MAIN_X + MAIN_W // 2
            body.append(f'<line x1="{mid_x}" y1="{prev_bottom}" x2="{mid_x}" y2="{y}" '
                        f'stroke="#333" stroke-width="1.5" marker-end="url(#arrow)"/>')
        _svg_box(body, MAIN_X, y, MAIN_W, main)
        if side:
            sy = y
            _svg_box(body, SIDE_X, sy, SIDE_W, side)
            body.append(f'<line x1="{MAIN_X + MAIN_W}" y1="{y + h // 2}" x2="{SIDE_X}" '
                        f'y2="{sy + side_h // 2}" stroke="#333" stroke-width="1.5" '
                        f'marker-end="url(#arrow)"/>')
        if stage_spans and stage_spans[-1][0] == stage:
            stage_spans[-1][2] = y + max(h, side_h)
        else:
            stage_spans.append([stage, y, y + max(h, side_h)])
        prev_bottom = y + h
        y += max(h, side_h) + GAP
    for stage, y0, y1 in stage_spans:
        body.append(f'<rect x="20" y="{y0}" width="{LABEL_W}" height="{y1 - y0}" '
                    f'fill="#e8eef7" stroke="#333" rx="4"/>')
        body.append(f'<text x="{20 + LABEL_W // 2}" y="{(y0 + y1) // 2 + 5}" '
                    f'font-size="{FONT}" font-weight="bold" text-anchor="middle">'
                    f"{escape(stage)}</text>")
    notes = pending_notes(d)
    for n in notes:
        body.append(f'<text x="{MAIN_X}" y="{y}" font-size="12" fill="#555">'
                    f"NOTE: {escape(n)}</text>")
        y += 18
    height = y + 20
    header = (f'<text x="20" y="34" font-size="18" font-weight="bold">'
              f"PRISMA-ScR flow — {escape(slug)}</text>")
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="920" height="{height}" '
        f'viewBox="0 0 920 {height}" font-family="Helvetica, Arial, sans-serif">\n'
        '<defs><marker id="arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" '
        'orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="#333"/></marker></defs>\n'
        '<rect width="100%" height="100%" fill="#fdfdfd"/>\n'
        + header + "\n" + "\n".join(body) + "\n</svg>\n"
    )


def render_html(slug, d):
    return ("<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\">"
            f"<title>PRISMA-ScR — {escape(slug)}</title></head>\n"
            "<body style=\"margin:20px;background:#fff\">\n"
            + render_svg(slug, d) + "</body></html>\n")


def main():
    ap = argparse.ArgumentParser(description="PRISMA-ScR diagram derived from review.db.")
    ap.add_argument("--project", help="project slug or directory")
    ap.add_argument("--format", default="text", choices=["text", "mermaid", "svg", "html"])
    ap.add_argument("--out", help="write to a file instead of stdout")
    args = ap.parse_args()

    pdir = review.project_dir(args.project)
    db = os.path.join(pdir, "review.db")
    if not os.path.exists(db):
        print(f"prisma_scr: no review.db in {pdir} — import records with review.py first "
              "(the legacy prisma.py ledger handles manual counts)", file=sys.stderr)
        sys.exit(1)
    con = review.connect(pdir)
    try:
        d = derive(con)
    finally:
        con.close()
    slug = os.path.basename(os.path.normpath(pdir))
    render = {"text": render_text, "mermaid": render_mermaid,
              "svg": render_svg, "html": render_html}[args.format]
    output = render(slug, d)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(output if output.endswith("\n") else output + "\n")
        print(json.dumps({"written": args.out, "format": args.format}))
    else:
        print(output)


if __name__ == "__main__":
    main()
