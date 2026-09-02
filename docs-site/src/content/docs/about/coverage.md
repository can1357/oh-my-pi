---
title: Coverage Badges
description: What the A, B, and C badges on every page mean, and how the rankings are kept honest.
---

A small coloured badge appears next to every page title. It reflects how comprehensively the page covers the user-facing surface of the topic it documents — **not** feature stability, completeness, or recommendation level.

| Badge | Meaning |
| --- | --- |
| **A** — High | Comprehensive for the feature's user-facing surface. All flags, keys, commands, and modes are verified against the source. |
| **B** — Medium | Solid guide coverage of primary workflows. Secondary detail (edge cases, advanced tuning) is omitted. |
| **C** — Low | Sketch. The page is a starting point; meaningful documented surface is missing. |

A page can be marked B for two reasons: the guide itself is short on purpose (for example a quickstart), or the topic still has undocumented surface. There is no automatic way to tell which is which from the badge — the page content makes it clear.

## How rankings are kept honest

Rankings are set in two places that must agree:

1. The page's `coverage` frontmatter field (`A`, `B`, or `C`)
2. The roster in `docs-site/COVERAGE.md`

Both are reviewed when a page is added or rewritten. The roster is the canonical list; treat the badge as a hint, not a promise.

## Raising a page's rank

A B or C page becomes A only when every documented surface area — flags, keys, commands, error modes, and edge cases — is verified against the current source. To propose a change, update the page and `COVERAGE.md` together in the same change.
