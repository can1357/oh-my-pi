# Local web reader benchmark

Run from the repo root with the current native addon built. Recording also requires `lynx` and `trafilatura` on `PATH` (the original measurements used Lynx 2.9.3 and trafilatura 2.0.0) and the normal headless-browser setup for omp's browser fallback.

```sh
bun scripts/web-bench/bench.ts record
bun scripts/web-bench/bench.ts record --only bbc,npr
bun scripts/web-bench/bench.ts score
bun scripts/web-bench/bench.ts holdout 10 < urls.txt
```

`record` and `score` accept optional corpus slugs for a focused run. With no slugs, they run the entire `corpus.toml`. The benchmark disables site-specific handlers and does not configure remote readers so it measures the local renderer. `score` is offline: it never opens a network connection or runs the browser. `holdout` accepts newline-delimited HTTP(S) URLs on stdin (for example, URLs from session history), samples ten distinct non-corpus URLs by default, and records just those. It reports the proportion of the two reference tools' shared word occurrences retained and the fraction of candidate word occurrences outside that consensus. This noise estimate also counts valid words only one reference found. If a legacy addon was supplied, it prints the same metrics for the old Markdown path.

## Local files and gold review

Everything generated goes under `~/.omp/web-corpus/`, never into this checkout. Keep the directory private: recordings contain response headers and can include cookies or pages from private holdout URLs.

- `recording.json` and `exchange-*.raw`: ordered requests, final URLs/status/headers, and unmodified response bytes from `HttpSession` and the headless browser. Browser-off and browser-on traces have separate cookie jars. Wall and app-shell pages get a browser capture even if the reader would not escalate. Re-record if score reports that a new reader request has no captured response.
- `page.html`: decoded input for `renderHtml`. `lynx.txt` and `trafilatura.md` are generated from the original bytes with `lynx -stdin -dump -nolist -width 250` (with charset flags) and `trafilatura --output-format markdown`. Browser DOM gets the same references under `browser-*`.
- `gold.draft.toml`: `record` writes only this draft. Review it against both references, then save your reviewed copy as `gold.toml`; `score` prefers it and uses the draft if no reviewed copy exists. For a substantial page, keep 10–20 verbatim `must` snippets spread across the content and include a code line, table cell, or comment where relevant. A tiny response may only have one snippet; do not gold-list a block message as content. Remove legitimate excerpts from `must_not` and add missing boilerplate such as cookie notices, navigation, and related links. Set minimum heading, code fence, and link counts in `structure`. `[browser]` has its own fixtures and counts; review that section independently.
- `ours-*.md` and `ours-*.txt`: local renderer outputs in each of the two modes (`auto`, `full`) and format, with an `ours-browser-` prefix for browser recoveries. `ours-full.txt` includes hidden content for comparison with stock Lynx; `ours-full-visible.txt` is the default full-text render. `ours-reader-off.json` and `ours-reader-on.json` contain the outputs used for the verdict gate.
- `~/.omp/web-corpus/score.json`: the most recent `score` run, with per-page results, gate totals, and any scoring errors.

To compare holdout recall and noise with the old renderer, set `OMP_WEB_BASELINE_ADDON` to a pre-cutover native `.node` addon built for your host. `record` and `score` do not need it.

## Gates

The table shows output lengths for unified `auto` and `full` modes (Markdown/text), full-writer word precision/recall, unchanged full-text lines against real Lynx, and browser-off/on verdicts. `—` means the gate does not apply to that row. Snippets and visible lengths ignore layout whitespace; Markdown link destinations and markup are excluded from visible word comparisons.

| Gate | Requirement |
| --- | --- |
| G1 | Auto Markdown contains every required snippet and satisfies the reviewed minimum counts on non-wall pages. An app shell may have an empty `must` list. Use the browser snapshot when browser replay recovers the page. |
| G2 | No forbidden snippet in auto Markdown. Like G1, matches ignore Markdown markup and whitespace layout on both sides. |
| G3 | Auto output has no data URI or metadata dump. Except for app shells and walls, it has at most 105% of real Lynx's visible text. Embedded strategies are not compared. |
| G4 | With browsing off, pages classified as `wall` must report `wall`; those classified as `app-shell` must report `js-shell` or pass gold via embedded data. With browsing on, recovery must pass browser gold or preserve the verdict without returning chrome. An `embedded-summary` may accompany a retained `js-shell` verdict. The Reader's generated YAML header is ignored when checking content. |
| G5 | Full Markdown and full text reach at least 99% word-multiset precision and recall after stripping display notation. For line identity, render full text with `hidden: "all"` to match stock Lynx. At least 96.4% of reference lines must be byte-identical in order, weighted across the corpus. |
| G7 | Rendering the same input twice in each format and mode (`auto`, `full`) produces identical output. |

If the Reader returns an alternate Markdown URL, negotiated Markdown, or `llms.txt` without browsing, recording drafts gold from that response. G1, G2, and the structure checks use its content in `ours-reader-off.json`; G3 and G5 are not applicable because Lynx saw the original HTML.

Any failed applicable gate or missing recording exits nonzero. Keep the corpus and scores local; this benchmark is not a CI test.
