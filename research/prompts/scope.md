---
description: "Start or refine a review project: turn a fuzzy question into PCC/PICO with explicit inclusion/exclusion criteria."
---

Scope a review for: **$ARGUMENTS**

1. If the argument names an existing project slug (check `~/.research-harness/projects/`), switch to it: write the slug to `~/.research-harness/active-project`, print its `scope.md`, and stop. If the argument is empty, show the active project's scope (or list projects if none is active).
2. Otherwise treat the argument as a research question. Derive a slug (lowercase, hyphenated, 3-6 keywords), create `~/.research-harness/projects/<slug>/` with `searches/` and `records/` subdirs, and write the slug to `~/.research-harness/active-project`.
3. Restate the question precisely, then structure it:
   - **PCC** (Population, Concept, Context) — default. Use **PICO** instead when the question compares an intervention against a comparator on an outcome.
   - An explicit inclusion/exclusion table: one row per criterion, columns Include | Exclude, covering population, concept/intervention, context/setting, study types, years, language. Ask the user about anything genuinely ambiguous (years? study types? human-only?); default sensibly in headless mode and mark defaults as assumptions.
4. Write the result to `<project>/scope.md`: question, framework table, inclusion/exclusion table, assumptions, date.
5. Report the project slug and scope summary, then propose the next step: `/databases` to pick where to search.
