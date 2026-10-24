---
description: "Export the review's records as RIS or BibTeX for Covidence, Zotero, or EndNote."
---

Export references: **$ARGUMENTS**

1. Resolve the active project. Format from the argument (`ris` default, or `bib`); scope from the argument: "included" (default — screened includes), "all" (all deduped candidates), or "graph" (the whole paper graph).
2. Run `refs_io.py` from the literature-search skill (resolve via `$RESEARCH_HARNESS_HOME`, else glob):
   - records: `python3 <skill>/scripts/refs_io.py export --format <ris|bib> --records <file.jsonl> --out <project>/export-<scope>-<date>.<ris|bib>`
   - graph: add `--from-graph` (honors `$PAPER_GRAPH_DB` or `--db <project>/papers.db`).
3. Report the file path and record count, and note it imports directly into Covidence/Zotero/EndNote.
