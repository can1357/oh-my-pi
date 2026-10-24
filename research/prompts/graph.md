---
description: "File included papers into the paper knowledge graph and view it inside the terminal (text neighborhood view; inline image on Kitty-graphics terminals)."
---

Paper graph: **$ARGUMENTS**

Resolve `paper_graph.py` in the paper-graph skill (`$RESEARCH_HARNESS_HOME/research/skills/paper-graph/scripts/paper_graph.py`, else glob `**/paper-graph/scripts/paper_graph.py`). The db is `$PAPER_GRAPH_DB` (prefix `PAPER_GRAPH_DB=<project>/papers.db` for a per-project graph).

- Argument names a paper id or search term: show its neighborhood IN the terminal — run `python3 paper_graph.py view --id <id> --depth 2` and print the output verbatim in a code block. Unknown id: `search` first.
- Argument is empty or "overview": run `python3 paper_graph.py view` for the whole-graph text view, plus `stats`.
- Argument says "add"/"file" or new includes exist that are not yet in the graph: for each included paper `add` with full metadata (`--title --authors --year --venue --doi --url --abstract`, `--path` for local PDFs), `link` co-included pairs `--type same-topic --note "<project slug>"`, then `auto-edges <id>` per paper (OpenAlex; skip offline; failures noted, not fatal). Then show the `view`.
- Argument says "image": add `--image` to `view` — inline PNG on Kitty-graphics terminals, silent fallback to text elsewhere.
- Argument says "html" or "export": `python3 paper_graph.py export --format html --out <project>/graph.html` as the secondary browser affordance.

Always finish with `stats` and propose the next workflow step.
