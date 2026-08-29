# Streaming markdown render CPU — options & recommendation

> Issue #9048 (~50% CPU during streaming; `RegExp.test` 26%, `#Ui` render 28% self) · PR #9303 (rebased head `e20d6fa185`, pushed to origin) · Baseline `upstream/main` 68874ddd90 (v18.0.0, incl. today's perf work f5c6ae15f6 / 91602d0bf2 / 065332fd06 / d974226c25 / 12591dbde3).

Evidence: /tmp/stream-perf/analysis.md (full pack) · /tmp/stream-perf/bench/ (harness + raw results) · PR conflict report: /tmp/stream-perf/conflict-report.md · PoC results: /tmp/stream-perf/poc-results.md · PoC worktrees: /tmp/omp-worktrees/poc-{A,B,C}.

## TL;DR

1. **Ship PR #9303 as-is.** It is rebased on v18.0.0, MERGEABLE, and still a live delta: upstream's perf work never touched the two full-document guard scans in `#lexTokens`. Measured: HAS_REF_DEF full-scan is 240–308µs/frame @128KB (~0.8% of the 33ms frame budget, ~20–25% of the markdown streaming frame). Small, strictly positive, near-zero risk.
2. **The real hole is elsewhere**: when the growing tail has no `\n\n` boundary (one long paragraph — the common LLM prose case), the prefix never freezes and the **whole document is lexDocument'd every frame — 44–62ms/frame @128KB**, i.e. 1.5–2× the entire frame budget, sustained for the length of the paragraph. PR #9303 cannot help there by construction.
3. Recommended permanent follow-up:
## Post-review additions (fresh-model pass, 2026-08-22)

New orthogonal targets found by re-scanning the per-tick inventory (all other full-doc
costs are already covered by the PoCs above; these two were untouched):

| cost | location | measured | PoC |
|---|---|---|---|
| `containsMermaidFence` full-text split + fence state machine, run BEFORE the fast-path return in `updateContent` (assistant-message.ts:840) — O(n) per tick → O(n²) per stream | packages/coding-agent | 33.6ms total @128KB stream (5462 ticks, p50 2.5µs) | **F** |
| `normalizeOsc8Terminators` full-doc regex in `setText` every tick, even with zero OSC escapes present | packages/tui markdown.ts:1631 | 25µs @128KB (136ms total per stream) | **G** |

Visibility audit (user hint: "lexing of everything that needs to be rendered on render… subagent, thinking block hidden") — all already optimal:
- Hidden thinking blocks skip `new Markdown(...)` entirely (assistant-message.ts:886).
- Off-screen/finalized transcript blocks skip `child.render()` (transcript-container.ts:593 committedReusable path).
- Subagent transcripts render only when the hub is open.
- The reveal controller already coalesces provider deltas to 30Hz ticks; the equality guard in `setText` skips re-lex on no-delta ticks.
- One real gap from the hint: `formatThinkingForDisplay` (O(n) per tick on the growing thinking block, O(n²) per stream — 768ms @128KB) → **PoC E**.

## Current upstream main (68874ddd90) per-frame anatomy (streaming, transient)

```
setText(delta)           → normalizeOsc8Terminators full-doc regex     34–70µs
render(width):
  L1 miss (text grew)    → replaceTabs full doc                         1–9µs
  #lexTokens():
    HAS_REF_DEF.test(full text)        ← PR #9303 kills this          61/240µs @32/128KB
    text.includes("\r") full           ← PR tail-scans this             1–4.5µs
    startsWith(prefix) full                                             4–23µs
    lexDocument(tail)   ← tail-only thanks to frozen prefix…
                        …BUT tail == whole doc when no \n\n yet       0.3–0.9ms blocky,
                                                                      44–62ms tight
  #freezeStablePrefix    → stableBlockBoundary walks ALL tokens       0.1–0.3ms
  #renderStreamingContentLines → frozen rows from line cache (good)
  open fences → HighlightStream incremental highlight (good, new in f5c6ae15f6)
```

Frame cadence: 30Hz reveal clock; adaptive floor `2× lastFrameCost` (tui.ts ~3054) caps render duty at ~50%. So everything below 33ms/frame is absorbed; **above 33ms the duty controller is the only thing keeping CPU at ~half a core** — that's exactly the tight-paragraph regime.

## Options

### Option 0 — PR #9303 (status: rebased & pushed)

Diff: `packages/tui/src/components/markdown.ts` +11/−9 (+changelog). Scans `HAS_REF_DEF` + CR on the tail only, computed once, reused for `lexDocument`.

- Evidence: saves 0.10–0.14ms/frame @32KB, 0.23–0.27ms/frame @128KB on blocky docs; no-op on tight docs (prefix never freezes → full scan still happens… actually on tight docs `canStream` is re-probed every frame on the full text → **on tight docs the PR saves nothing and the full-doc scan AND full re-lex both remain**).
- Risk: minimal; equivalence argued (frozen prefix was verified ref-def-free at freeze time; cut is a hard block boundary).
- Rebase notes: single conflict was `blob-exposure-tunnels.test.ts`, already subsumed upstream (commit dropped). markdown.ts applied verbatim — upstream's HighlightStream work is orthogonal.

### Option A — scan-state memoization (superset of #9303) · branch `poc/a`

Make every guard O(delta) via per-component cursors (append-only while streaming state lives; all reset paths already cleared at #setText non-append guard):
- `#scanCheckedLen/anchor` → ref-def + CR verdicts incremental
- `#frozenScanEnd` → stableBlockBoundary resumes from frozen count instead of re-walking all prefix tokens
- kills `startsWith(prefix)` too

Expected on top of PR: −(4–23µs startsWith) −(0.1–0.3ms boundary walk) −(tail-scan µs). ~0.2–0.4ms/frame @128KB.

### Option B — mid-block frame coalescing · branch `poc/b`

When streaming state is valid AND delta contains no `\n` AND pending unlexed bytes < 2× contentWidth AND render is transient → skip `lexDocument` this frame entirely (previous rows already rendered; new bytes only extend the last wrapped row once lexed). Lex on: finalize, `\n` in delta, or overflow.

- Expected: tight docs go from 44–62ms/frame to amortized O(row) — order-of-magnitude; blocky docs also gain on token drips (24-char deltas rarely contain `\n`).
- Risk: defers inline-token flips (e.g. unclosed `*emphasis`) by ≤1 row — same visual class as existing 8-frame reveal catch-up. Must verify settled-rows contract: tail rows must not reach native scrollback mid-block.

### Option C — delta-gated guard (boring minimal) · branch `poc/c`

Cache `canStream` verdict; on pure-append growth scan only the delta for `[`/`\n`/`\r` via three `includes` (~µs); reuse verdict on clean delta, re-probe tail otherwise. <40 lines. ~same savings as #9303 with less restructuring; strictly weaker than A but simplest possible diff.

### Rejected (with reasons)

| idea | why rejected |
|---|---|
| Rust/native `hasRefDef`/incremental lexer | CI: PRs never build natives — native fn must land on main + ship 5-platform prebuilt release before TS can use it; multi-week path for ~5µs over PoC A/C. Revisit only if a natives change is already queued. |
| pulldown-cmark/tree-sitter/incremark rewrite | weeks, replicates marked GFM+math+mermaid semantics; not a <200-line fix; windowed lexing already bounds pathology. |
| Remove URL detection from thinking blocks | Already optimal: URL scan is inline-tail-only and gated (`urlTokenPossible`); thinking blocks are collapsed before markdown (`proseOnlyThinking`). Nothing to remove. |
| Render-duty scheduler 2× → 3× knob | 1 line, but only throttles — doesn't remove work; keep as knob if profiling later shows frame-bound at >128KB. |
| Hand-rolled ref-def scan (replace regex) | JSC regex is ~75× slower than charCode scan, but post-PR the tail scan is already µs. Keep as fallback for MB-scale tails. |

## Decision after PoC benchmarks + reviews (FINAL)

**Ship (5 PRs raised, all green or documented):**
| PR | change | status |
|---|---|---|
| #9423 | D: boundary-walk resume (11 lines) | ✅ 12/12 green |
| #9426 | E: incremental thinking formatter (net −12 lines) | ✅ green, 6 comments addressed |
| #9432 | H: tail-row cache (21 lines net) | ✅ 12/12 green, 6 comments addressed |
| #9417 | G: tail-only OSC8 normalize (38 lines) | ✅ green minus 1 infra flake (documented) |
| #9418 | C: delta-gated guard memo (31 lines) | ✅ green minus 1 infra flake (documented) |

**Dropped (with evidence):**
- F (mermaid scan): upstream 1949c798a7 DELETED the machinery (100 deletions) — rebase would reintroduce a regression.
- B+ (frame coalescing): correct (26/26, 3580-frame smoke) but 287 prod lines (2.4× budget), 22–24% engagement on marker-dense, H already wins −34.3% vs B+'s −6.6% on tight:128KB. H subsumes it.
- A: superseded by C+D (95 vs 42 lines, same coverage).
- B: breaks byte-identity (6 tests) + visible lag — replaced by B+ concept, then dropped.

**Unrelated fixes:** none (W1.1 audited all 7 branches — 0 unrelated hunks).
**Upstream CI failures:** all 4 already fixed upstream (b624a6d867/c222a58cc0/61ef86a29a) — no fork fixes needed.

**Net effect on #9048 profile:** guard scans 265µs→0.1µs (C), boundary walk 241µs→0.9µs (D), OSC8 25µs→sub-µs (G), thinking format O(n²)→O(n) (E), tail render −27% tight-doc (H). Combined: the per-frame O(n) scans are eliminated or bounded; the tight-doc re-lex regime (44–62ms) is addressed by H's row cache (−27%).

## Branch inventory

| branch | worktree | content | status |
|---|---|---|---|
| `fix/markdown-refdef-streaming` | main checkout | PR #9303 rebased on upstream/main (e20d6fa185) | **pushed to origin**, MERGEABLE |
| `stream-perf/base` | — | e20d6fa185 as local PoC baseline | local |
| branch | worktree | content | status |
|---|---|---|---|
| `fix/markdown-refdef-streaming` | main checkout | PR #9303 rebased on upstream/main (e20d6fa185) | **pushed to origin**, MERGEABLE |
| `stream-perf/base` | — | e20d6fa185 as local PoC baseline | local |
| `poc/a` | /tmp/omp-worktrees/poc-A | A: scan-state memo + boundary resume | ✅ 86/86 tests, guard 375µs→0.27µs, realistic −14% |
| `poc/b` | /tmp/omp-worktrees/poc-B | B: frame coalescing (breaks byte-identity) | done, 59 lines, tight 71.95→0.09ms |
| `poc/bplus` | /tmp/omp-worktrees/poc-B | B+: B without user-visible impact | running |
| `poc/c` | /tmp/omp-worktrees/poc-C | C: delta-gated guard memo | done, <40 lines, 0.1µs |
| `poc/d` | /tmp/omp-worktrees/poc-D | D: tail-only boundary-walk resume (NOT inert-delta — pivot) | done, 11 prod lines, 99.6% walk, 245 tests |
| `poc/e` | /tmp/omp-worktrees/poc-E | E: incremental thinking formatter | running |
| `poc/f` | /tmp/omp-worktrees/poc-F | F: incremental mermaid scan | done, 172 lines, 92% total, 5914 checks |
| `ext/g` | /tmp/omp-worktrees/poc-G | G: tail-only OSC normalize | done, 38 prod lines, 1.9× stream |
| `poc/h` | /tmp/omp-worktrees/poc-H | H: incremental tail render cache | running |

## Completed PoC highlights (measured)

| PoC | prod lines | win | tests |
|---|---|---|---|
| A | 95 | guard 375µs→0.27µs/frame @128KB; realistic stream −14% | 86/86 |
| B | 59 | tight 71.95→0.09ms/frame (breaks byte-identity — 6 tests) | 20/26 |
| C | <40 | guard →0.1µs/frame delta-gated | green |
| D | 11 | boundary walk 241µs→0.9µs/frame (99.6%), frame −26% | 245/245 |
| F | 172 | mermaid scan 44→3.4ms total @128KB (−92%) | 5914/0 |
| G | 38 | OSC normalize stream 602.8→312ms (1.9×) | 26/26 + 148/148 + 34/34 |

**D overlaps A's boundary-resume half** (A = guard memo + boundary; D = boundary
only, 11 lines vs A's 95). For the final merge: pick D for the boundary cost,
C for the guard memo (smallest), PR #9303 as the non-transient fallback. A
becomes optional/superset.

**D pivoted away from its spec** (inert-delta token reuse) to the boundary
resume. The inert-delta lex-skip concept survives as B+'s design (skip-lex +
exact last-row re-wrap on inert deltas — the byte-identity-preserving version).
