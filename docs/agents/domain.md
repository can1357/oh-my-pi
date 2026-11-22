# Domain Docs

How engineering agents consume domain documentation in this repo.

## Before exploring
- Read root `GLOSSARY.md` if it exists, or `GLOSSARY-MAP.md` and the relevant context glossary if present.
- Read ADRs in `docs/adr/` that affect the area. For a future multi-context layout, also check `src/<context>/docs/adr/`.
- If these files are absent, proceed silently; do not suggest creating them until domain terms or decisions are actually being resolved.

## Layout
This repo uses a single-context layout: root glossary plus `docs/adr/`.

## Vocabulary and decisions
Use glossary terms in issue titles, proposals, hypotheses and tests. If a needed term is missing, note it for domain modeling. If a change conflicts with an ADR, call out the ADR and the reason for reopening it.
