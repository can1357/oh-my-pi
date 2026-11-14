---
name: omp-gap-research
description: >-
  Study, inventory, classify, and research a capability gap against omp2 and an
  optional upstream pin. Writes docs/research/<slug>.md in this repo's research
  note shape. Development aid only; not an omp2 runtime skill.
---

# omp-gap-research

Use this skill before writing an ADR or code for a gap. Authority is the live
tree and cited paths, not memory. Follow `AGENTS.md` and existing notes under
`docs/research/`.

## Inputs

- **Gap name / slug**: kebab-case file stem for `docs/research/<slug>.md`.
- **omp2 pin**: branch + commit (default `origin/omp2` tip you inspected).
- **Upstream pin** (optional): repo + commit when comparing OMPv1 or another source.
- **Scope**: tools, schemes, convars, crates, or behaviours in play.

## Method (in order)

### 1. Study

In two or three sentences: what the upstream (or missing) capability does and
why a user needs it. Cite upstream path:line when an upstream pin exists.

### 2. Inventory

Search this repo for what already exists: crates, extensions, convars, hooks,
importer stubs, Directors, roster families, URL schemes, devices. Cite
`path:line` for every claim. Prefer bounded `rg` then read the declaration.

### 3. Classify

Exactly one of:

| Class | Meaning |
| --- | --- |
| **a** | Already covered by an equivalent (name it; no code change). |
| **b** | Not needed (say why, and what the user does instead). |
| **c** | Port upstream behaviour in omp2's shape (native names, no `pi` identity). |
| **d** | Propose something better suited to omp2's architecture. |

### 4. Research (classes c and d only)

Compare at least two options, including "build on existing omp2 code" versus
"port". Choose one with reasons. Name locked ADRs that constrain the choice
(0024 roster, 0036 Python-only extensions, 0006 sandbox, 0049 vendors-as-extensions,
0050 schemes, …).

## Research note template

Write `docs/research/<slug>.md`:

```markdown
# <Title>

Scope: …
omp2 pin: `omp2@<sha>` …
Upstream pin: … (or "none")

## 1. Study
…

## 2. Inventory
- … (`path:line`)

## 3. Class
**a|b|c|d.** …

## 4. Research (c/d only)
| Option | Pros | Cons |
| --- | --- | --- |
| A … | | |
| B … | | |
**Chosen:** …

## 5. Next
- ADR: yes/no (next free number if yes)
- Slices: defer detail to `omp-slice-plan`
```

Mark **UNVERIFIED** when a claim rests on absence of a hit or unread code, not
a run. Do not change production behaviour in this skill.

## Constraints

- Additive-only for existing tools, skills, convars, hooks, URL schemes, CLI.
- No `pi-*` / `PI_*` / `.pi` identity in proposed names.
- Vendor integrations are extensions (ADR 0049), never core.
- This skill does not implement; hand off to `omp-adr` then `omp-slice-plan`.
