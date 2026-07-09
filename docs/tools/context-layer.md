# Light context layer

The light context layer is a compact context-answer service for the coding agent. It sits between the main model and the repo so the model can ask narrow questions before loading many files.

It is exposed as the `context_oracle` tool.

## What it uses

- LSP evidence: definitions, references, document/workspace symbols, hover, diagnostics.
- File evidence: bounded file summaries and declaration scans.
- Search evidence: deterministic text fallback when LSP has no result.
- Cache evidence: file summaries and prior context queries keyed by file mtime/size or scope.

## What it is not

- Not an LSP. LSP is the deterministic language-server protocol source underneath it.
- Not the main LLM. It returns small structured evidence for the main agent to inspect and act on.
- Not final verification. Read exact source before editing and run normal checks after edits.

## Tool actions

```json
{ "action": "ask", "query": "Where is ContextOracleTool defined?" }
{ "action": "symbol", "symbol": "ContextOracle", "file": "packages/coding-agent/src/context-layer/context-oracle.ts", "line": 46 }
{ "action": "file", "file": "packages/coding-agent/src/lsp/index.ts" }
{ "action": "diagnostics", "scope": "packages/coding-agent/src/**/*.ts" }
{ "action": "editImpact", "symbol": "LspTool", "file": "packages/coding-agent/src/lsp/index.ts", "line": 1292 }
```

Output shape:

```ts
{
  answer: string,
  confidence: "high" | "medium" | "low",
  evidence: Array<{
    type: "lsp" | "file" | "diagnostic" | "summary" | "search" | "cache",
    file?: string,
    range?: { startLine: number, endLine: number },
    symbol?: string,
    detail: string
  }>,
  suggestedNextReads?: string[],
  tokenEstimate?: number,
  deterministicMode: boolean,
  modelConfigured?: string
}
```

## Config

```yaml
contextLayer:
  enabled: true
  model: pi/smol       # optional; empty keeps deterministic mode
  maxInputTokens: 12000
  maxOutputTokens: 1200
  cache: true
```

`contextLayer.model` is reserved for cheap-model evidence compression. Deterministic LSP/file/search retrieval remains the authority and still works without a model.

## Limitations

- LSP results depend on configured language servers and project indexing state.
- The text-search fallback is bounded and may miss generated or ignored files.
- File summaries are intentionally shallow; use `read` for exact edit context.
- Low confidence means no cited deterministic evidence was found.
