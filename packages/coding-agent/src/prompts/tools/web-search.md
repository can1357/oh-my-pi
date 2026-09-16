Web search: current information beyond knowledge cutoff.

<instruction>
- SHOULD prefer primary sources (papers, official docs); corroborate key claims with multiple sources.
- MUST link cited sources in final response.
- NEVER use for programmatically accessible content or known URLs (GitHub repos/issues, known arXiv papers, Wikipedia pages, official docs) — `read` URL directly.
- `query`: every provider supports Google-style `site:`/`-site:`, `after:`/`before:` (`YYYY-MM-DD`), `inurl:`, `intitle:`, `filetype:`, `"exact phrase"`, `-term`, `OR`. Map constraints to native filters when available; otherwise filter results leniently. If a constraint matches nothing, relax and report it; do not return zero results.
- `provider`: omit to use the configured fallback chain. Set it to reach a corpus the chain will not: `public` fans out across every keyless engine and deduplicates, and any named engine (`exa`, `kagi`, `xai`, …) forces that engine. An explicitly selected provider fails the call instead of falling back — retry without `provider`.
</instruction>
