Lightweight repo context service.

Use this before reading many files, before broad edits, or when you need precise symbol, file, diagnostic, or edit-impact context.

Actions:
- `ask`: answer a precise repo/code question from deterministic evidence.
- `symbol`: locate or summarize a symbol. Provide `file`, `line`, and `symbol` when possible so LSP can answer precisely.
- `file`: summarize a file with document symbols and diagnostics.
- `diagnostics`: return compact diagnostics for `scope` (`*`, file path, or glob).
- `editImpact`: identify references/files likely affected by changing a symbol or file.

Rules:
- Prefer LSP evidence over text search when available.
- Treat this as a context triage layer, not final verification.
- Still read exact source before editing and run normal tests/checks after editing.
- Low confidence means evidence was missing or ambiguous; inspect files directly.
- Output is bounded JSON with `answer`, `confidence`, `evidence`, `suggestedNextReads`, and `tokenEstimate`.
