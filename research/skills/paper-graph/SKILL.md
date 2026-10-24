---
name: paper-graph
description: "Use when managing the paper knowledge graph: add/link papers, query neighbors, auto-discover citation edges via OpenAlex, view the graph in the terminal, export interactive HTML."
---

# paper-graph

A local-first second brain for papers: SQLite store of paper nodes and typed edges, managed by two python3-stdlib scripts under `scripts/` (relative to this SKILL.md). All commands emit one JSON object per line on stdout; errors go to stderr with exit 1.

**DB path:** `$PAPER_GRAPH_DB` if set, else `~/.research-harness/papers.db`. The schema (and parent directory) is created on first use.

**Edge types:** `cites`, `related`, `same-topic` (enforced by a CHECK constraint).

## paper_graph.py subcommands

### add — upsert a paper

```sh
python3 scripts/paper_graph.py add --id medagents --title "MedAgents: Large Language Models as Collaborators for Zero-shot Medical Reasoning" --authors "Xiangru Tang, Anni Zou" --year 2023 --doi "10.48550/arXiv.2311.10537"
```

```json
{"id": "medagents", "title": "MedAgents: Large Language Models as Collaborators for Zero-shot Medical Reasoning", "authors": "Xiangru Tang, Anni Zou", "year": 2023, "venue": null, "doi": "10.48550/arXiv.2311.10537", "url": null, "abstract": null, "openalex_id": null, "path": null, "added_at": "2026-09-05T02:39:09Z"}
```

Re-adding the same `--id` updates it; fields omitted on the second add keep their existing values. Optional flags: `--authors --year --venue --doi --url --abstract --path`. `--path` stores the absolute file path of a local-corpus PDF (records from `literature-search/scripts/local_library.py scan`), so local papers are first-class graph nodes.

### link — add a typed edge

```sh
python3 scripts/paper_graph.py link mdagents medagents --type related --weight 0.9 --note "same domain"
```

```json
{"linked": true, "src": "mdagents", "dst": "medagents", "type": "related", "weight": 0.9, "note": "same domain"}
```

Unknown src/dst ids are auto-created as stub nodes (empty title) so you can link first, fill metadata later.

### get / search

```sh
python3 scripts/paper_graph.py get medagents
python3 scripts/paper_graph.py search "Medical"
```

`get` prints the one paper (exit 1 if missing); `search` prints every paper whose title, abstract, or authors LIKE-match the query, one JSON line each.

### neighbors — BFS traversal

```sh
python3 scripts/paper_graph.py neighbors mdagents --depth 2
```

```json
{"id": "medagents", "title": "MedAgents: ...", "...": "...", "_depth": 1, "_via": {"src": "mdagents", "dst": "medagents", "type": "related"}}
```

Edges are traversed in both directions. `--type cites|related|same-topic` restricts traversal to one edge type; `--depth N` (default 1) bounds the BFS.

### unlink / remove

```sh
python3 scripts/paper_graph.py unlink mdagents medagents --type related
python3 scripts/paper_graph.py remove mdagents
```

```json
{"unlinked": 1, "src": "mdagents", "dst": "medagents"}
{"removed": "mdagents", "edges_removed": 0}
```

`unlink` without `--type` deletes all edge types between the pair. `remove` deletes the paper and cascades its edges.

### stats

```sh
python3 scripts/paper_graph.py stats
```

```json
{"papers": 2, "edges": {"cites": 0, "related": 1, "same-topic": 0}, "total_edges": 1}
```

### view — render the graph IN the terminal

```sh
python3 scripts/paper_graph.py view                      # whole-graph overview
python3 scripts/paper_graph.py view --id bert --depth 2  # one paper's neighborhood
python3 scripts/paper_graph.py view --image              # inline PNG on Kitty-graphics terminals
```

```
paper graph: 5 papers, 4 edges (1 cites, 3 same-topic)

medcoact  MedCoAct: Confidence-aware multi-agent collaboration fo... (2024)  [deg 3]
|-- [cites ->] autogen  AutoGen: Enabling next-gen LLM applications via multi-a... (2023)  [deg 1]
`-- [same-topic] sem-agents  Semantic agents for integrated diagnosis and treatment ... (2024)  [deg 2]

isolated: lonely
```

The PRIMARY graph experience — human-readable text (not JSON lines), safe in any terminal: ASCII tree, no color codes, titles truncated. Without `--id`: one tree per connected component (highest-degree roots first) plus an `isolated:` list. With `--id`: that paper's BFS neighborhood (default depth 2). `cites` edges show direction (`cites ->` / `cited by`); other types are symmetric. `--image` transmits a PNG via the Kitty graphics protocol (stdlib rasterizer in `graph_png.py`, node index legend printed below) when the terminal advertises support AND stdout is a TTY; otherwise it silently falls back to the text view — always safe to pass.

### auto-edges — citation discovery via OpenAlex

```sh
python3 scripts/paper_graph.py auto-edges bert
```

```json
{"paper": "bert", "openalex_id": "https://openalex.org/W2963341956", "references": 52, "local_matches": 1, "edges_added": 1}
```

Resolves the paper on keyless api.openalex.org — by DOI (`/works/doi:...`) when the paper has one, else by title search — then fetches the work's `referenced_works` and adds a `cites` edge to every referenced work that is ALREADY in the local graph (matched by stored OpenAlex id, or by DOI via a batch lookup). Discovered OpenAlex ids are stored on the papers (`openalex_id` column) so later runs skip the lookup. Only links known papers — it never imports new nodes. Note: some OpenAlex records (notably bare arXiv preprints) have an empty reference list; `references: 0` means OpenAlex has no data, not that the tool failed.

### export

```sh
python3 scripts/paper_graph.py export --format json --out graph.json
python3 scripts/paper_graph.py export --format html --out graph.html
```

```json
{"exported": "graph.html", "format": "html"}
```

`json` dumps `{"papers": [...], "edges": [...]}` (to stdout when `--out` is omitted). `html` delegates to `graph_viz.py`.

## graph_viz.py

```sh
python3 scripts/graph_viz.py --out graph.html [--db /path/to/papers.db]
```

Writes ONE self-contained dark-theme HTML file: embedded data, vanilla-JS canvas force-directed layout, node radius proportional to degree, edge colors by type (cites=blue, related=green, same-topic=orange), drag/zoom/pan, search box, click a node for a metadata side panel with DOI link. Zero external URLs — works offline from `file://`.

## Failure modes

- OpenAlex HTTP failure: `auto-edges` exits 1 with a stderr message. Retry once; the local graph is never corrupted by a failed run.
- `auto-edges` on a paper with neither DOI nor resolvable title: exit 1 `could not resolve ... on OpenAlex`.
- `get`/`neighbors`/`remove` on an unknown id: exit 1 `no such paper`.
