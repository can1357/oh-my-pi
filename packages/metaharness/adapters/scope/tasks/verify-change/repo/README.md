# shortlinks

Short links with readable slugs.

- `src/slug.ts`: `slugify`, the slug for a link title.
- `src/links.ts`: `LinkTable`, slug → link, with collision suffixes.
- `src/upstream.ts`: stand-in for the redirect service.
- `src/resolver.ts`: resolves a slug through the redirect service with retries.

## Tests

    bun test

The resolver and upstream suites run on real timers (latency, exponential backoff), so the full
run takes about 15 seconds.
