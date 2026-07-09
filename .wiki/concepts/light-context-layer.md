# Light context layer

Status: implemented

## Problem

The main coding agent often needs precise repository facts before deciding which files to read. Loading broad file payloads, raw LSP tool text, or repeated search output bloats context and makes symbol/diagnostic evidence harder to trust.

## Implemented shape

`context_oracle` is a discoverable coding-agent tool backed by `ContextOracle` in `packages/coding-agent/src/context-layer/context-oracle.ts`.

It returns bounded structured answers:

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
  tokenEstimate?: number
}
```

Supported actions:

- `ask`
- `symbol`
- `file`
- `diagnostics`
- `editImpact`

## Typed LSP seam

The layer uses `queryTypedLspContext()` from `packages/coding-agent/src/lsp/index.ts` instead of invoking `LspTool.execute()` and parsing rendered tool text.

Typed LSP results cover:

- definitions and references as `Location[]`
- hover as extracted hover text
- document/workspace symbols as typed symbol objects
- diagnostics as `{ file, diagnostic }[]`

Typed diagnostics mirrors the existing freshness path: capture diagnostic versions, refresh the file, capture open document versions, then pass `minVersions` and `expectedDocumentVersions` into `getDiagnosticsForFile()`.

## Config

Settings live under `contextLayer.*`:

- `contextLayer.enabled`
- `contextLayer.model`
- `contextLayer.maxInputTokens`
- `contextLayer.maxOutputTokens`
- `contextLayer.cache`

`contextLayer.model` enables optional cheap-model compression after deterministic evidence retrieval. The compression model receives bounded evidence JSON and may replace only the `answer` field when it returns valid JSON; deterministic evidence, confidence, and suggested reads remain authoritative.

The cache now lives on `ToolSession.contextOracleCache`, so separate `context_oracle` tool calls in the same agent session share file summaries and prior query results. Cache hits are disabled when `contextLayer.cache` is `false`; file-summary entries invalidate on mtime/size changes.

## Tests and evidence

Focused test suite:

```sh
bun test packages/coding-agent/src/context-layer/context-oracle.test.ts
```

Full gate:

```sh
bun check
```

ULW evidence for this implementation lives under `.omo/ulw-loop/evidence/G001-*`.

## Known next slice

Expand cache coverage beyond file summaries and generic query responses: add explicit symbol and diagnostics snapshot caches with LSP document-version freshness, then surface cache stats in tool details for observability.
