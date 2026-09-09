# 0030. RichText streams through one pass; no `string[]` render

Status: accepted
Date: 2026-09-02
Area: interface

## Context

pi's component contract is `render(width): string[]`: every component returns ANSI-escaped
lines, and every parent re-parses, re-measures, re-pads, and re-concatenates them. A CPU profile of
one full pi session driving a single task (captured for pi-mono PR #1084, base `e045a9f`) is
dominated by the renderer. Self time, top entries:

| Entry | Self time | What it does |
| --- | --- | --- |
| `wrapAnsi` | 98.6 s | re-tokenizes ANSI, re-measures every token, per line, per frame |
| `containsImage` | 43.0 s | two `.includes` scans per line for `ESC _G` / `ESC ]1337;File=` |
| `write` | 40.7 s | `process.stdout.write` plus optional log append |
| `doRenderImpl` | 36.6 s | full re-render, then line-by-line string diff against the last frame |
| `visibleWidth` | 24.2 s + 12.4 s | strip escapes with three regexes, then grapheme-segment |
| `join` | 14.4 s | `childLines.join("\n")` to build a cache key |
| `render`/`push`/`repeat`/`applyLineResets` | 24.1 s | spread, left-pad, `" ".repeat`, append reset to every line |

The 18 profiled entries sum to ~328 s of CPU for one session. The three pure string scans
(`containsImage`, `join`, `applyLineResets`) are 60.5 s of that, and the session contained zero
images. `applyLineResets` calls `containsImage` on every line of every frame; the image check
alone is 43 s.

Costs built into the contract, not the implementation:

- JS strings are UTF-16; every frame transcodes to bytes on the way out.
- Embedding a child means sanitizing its `string`, decoding past its escapes, then padding,
  truncating, and measuring every line again at each level of nesting.
- The pipeline is a heap-grooming machine: allocate, split, pad, concatenate, slice, discard,
  per component, per transform, per frame.
- Images ride the same channel as base64 text inside a line, so every line must be scanned for
  them.

The same contract pushes width and safety onto each extension author. A community web-search
renderer from the pi catalog slices titles with `s.title.slice(0, 47) + "..."` and URLs with
`u.slice(0, 57)`: codepoint slicing that breaks the line under 40 columns; a fixed cut with no
awareness of available width; and unsanitized external input (`s.title`, `u`) pushed straight
into the frame, so a fetched page can inject escape sequences into the user's terminal. The post
links the prior art for that last class: CVE-2023-32712, CVE-2025-55752, gurk-rs issue #384, and
Packetlabs' "Weaponizing ANSI escape sequences".

Root cause, as stated in the post: an already-rendered string was being used as layout tree,
style tree, content, transport, and terminal program at once. Replacing the contract took one
session's render time from 267 s to 90 ms.

## Decision

1. The rendering primitive is a push sink, not a returned buffer. The lowest-level consumers push
   RichText runs `(Style, text)` into an abstract output handed to them (`&mut impl Out` in the
   post; `RichSink` in omp). No layer returns `string[]` or `Vec<String>`.
2. ANSI/VT is decomposed exactly once, at the boundary where external text enters (process output,
   pastes, files). Every component below the frame renderer assumes zero escapes and stores none.
3. Padding, truncation, wrapping, prefixing, and row limits are stream transforms composed around a
   sink. Truncation drops the stream after the ellipsis; it NEVER renders the whole thing and
   slices afterwards. Padding is emitted as spaces into the stream; it NEVER builds a padded
   copy.
4. Higher layers NEVER parse ANSI to recover structure they emitted themselves. Structure lives in
   the component tree and the styled runs, not in escape bytes.
5. ANSI is re-emitted exactly once, at final materialization into the terminal write buffer.
6. Width is measured once per run at the boundary in terminal cells (grapheme clusters, East Asian
   width), never per level of nesting and never by codepoint count.
7. Caches own memory: one pooled text buffer plus `(Style, Range)` spans; re-presenting is
   re-slicing, not re-parsing. A fresh per-frame line buffer is a bug, not a style.

## Consequences

- Sanitization, measurement, and wrapping have one owner. An extension cannot forget them because
  it has no string to forget them in; external text physically cannot reach a component without
  crossing the decomposer.
- Nesting is free: a parent composes adapters around the child's sink instead of post-processing
  the child's output.
- Images are not text and never share a text channel, so no line scan exists.
- Prohibited: `format!`/`String` render paths that get re-parsed, any component that inspects
  escape bytes, any truncation implemented as `slice` on a rendered row.
- Cost accepted: the primitive is harder to write than `lines.push(...)`. Adapters must be
  correct about grapheme boundaries, wide cells, and soft-wrap provenance. That difficulty is paid
  once in the engine (0002).

## Status in omp

**Partial.** Primary implementation: `crates/tui/src/rich.rs`. The one-pass `RichSink` pipeline and slot write plans are implemented. Gap: the diff component still has a string-building truncation path.

## References

- The Harness Playbook, "The interface": "What omp taught us: strings compound", "What omp²
  changes: a one-pass primitive"; profile data and pi source excerpts in the post header
- pi-mono PR #1084 (earendil-works/pi)
- CVE-2023-32712, CVE-2025-55752, gurk-rs issue #384, Packetlabs "Weaponizing ANSI escape
  sequences"
- `crates/tui/src/rich.rs`, `AGENTS.md` "TUI Rendering Doctrine"
- 0002 (one owner for sanitization), 0031 (the component model above this primitive), 0032
  (presentation policy)
