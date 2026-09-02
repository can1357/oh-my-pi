# Docs page style guide (not published — underscore prefix excludes it from the collection)

Every page is a `.md` file under `docs-site/src/content/docs/` with Starlight frontmatter:

```md
---
title: Page Title
description: One-sentence summary shown in search results and link previews.
---

Opening paragraph: what the feature does and why a user cares, in two or three
sentences. No "Overview" heading — the first heading is `##` level.
```

## Structure

- Start at `##` (the title renders as `h1`). Do not repeat the title as a heading.
- Lead with the common case; push edge cases and internals to the bottom.
- Show, then tell: a working config/CLI example before the table that enumerates every option.
- Tables for enumerations (settings, flags, keybindings): `| Key | Type | Default | Description |`.
- Fenced code blocks always carry a language: ` ```yaml `, ` ```bash `, ` ```json `, ` ```text `.

## Starlight asides

```md
:::note
Supplementary information.
:::

:::tip
A shortcut or recommended practice.
:::

:::caution
A sharp edge: data loss, surprising behavior, security implications.
:::
```

## Links

- Internal docs links include the site base (`/oh-my-pi/`): `[Sessions](/oh-my-pi/features/sessions/)`. The site is hosted at the project path on GitHub Pages; root-relative paths would 404 in production.
- Reference source code by repo path in backticks (`` `packages/coding-agent/src/...` ``), not by URL.
- External links only for upstream projects (protocol specs, provider docs).

## Voice and grounding (hard rules)

- Terse, factual, user-facing. Describe what the user types/sees/configures, not internal architecture.
  Implementation detail belongs in `docs/` (the dev docs), not here.
- **Ground every claim in the source material listed in your task.** Never invent a flag,
  setting key, default, or env var. If the sources do not document something, leave it out.
- Do not copy internal-doc headers wholesale; rewrite for a user audience.
- No emojis. No marketing language ("blazingly fast", "seamless").
- Documented defaults and values must match the sources exactly.
