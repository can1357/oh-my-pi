---
name: semantic-compression
description: Aggressively remove grammatical scaffolding LLMs reconstruct while preserving meaning-carrying content. Output may be fragments. Use when compressing text for prompts, reducing token count, preparing context for LLM input, or making documentation more token-efficient. Applies LLM-aware compression rules that delete predictable grammar while preserving semantics.
---

# Semantic Compression

LLMs reconstruct grammar from content words. Remove predictable glue; keep semantic payload. Prefer fragments over sentences.

## Aggressive Stance

- Output can be noun/verb stacks, list fragments, or label:value phrases.
- Default to deletion; keep function words only when loss changes meaning.
- Prefer base verb forms; drop tense/aspect unless timeline is critical.

## Deletion Tiers

**Tier 1 — Always delete (even if fragments):**
- Articles: a, an, the
- Copulas: is, are, was, were, am, be, been, being
- Expletive subjects: "There is/are...", "It is..."
- Complementizer: that (as clause marker)
- Pure intensifiers: very, quite, rather, really, extremely, somewhat
- Filler phrases: "in order to" → to, "due to the fact that" → because, "in terms of" → delete
- Infinitive "to" before verbs (unless it prevents noun/verb confusion)
- Conjunctions when list/contrast obvious: and, or, but

**Tier 2 — Delete unless meaning changes:**
- Auxiliary verbs: have/has/had, do/does/did, will/would (keep if tense/aspect matters)
- Modal verbs: can/could/may/might/should (keep when obligation/permission/possibility is critical; always keep must/must not)
- Pronouns: it/this/that/these/those/he/she/they (drop when referent obvious; replace with noun if ambiguous)
- Relative pronouns: which, that, who, whom
- Prepositions: of, for, to, in, on, at, by (keep for material, direction, agency, or disambiguation)

**Tier 3 — Delete only if relation still clear:**
- Remaining prepositions: with/without, between/among, within, after/before, over/under, through (drop only if relation obvious)
- Redundant adverbs: "shout loudly" → "shout"

## Always Preserve

- Nouns, main verbs, meaning-bearing adjectives/adverbs
- Numbers, quantifiers: "at least 5", "approximately", "more than"
- Uncertainty markers: "appears", "seems", "reportedly", "what sounded like"
- Negation: not, no, never, without, none
- Temporal markers: dates, frequencies, durations
- Causality and conditionals: because, therefore, despite, although, if, unless
- Requirements/permissions: must, required, prohibited, allowed
- Proper nouns, titles, technical terms
- Prepositions encoding relationships: from/to (direction), with/without (inclusion), between/among/within (relation), after/before (temporal), by (agent if passive)

## Structural Compression

- Passive → active when agent known: "was eaten by dog" → "dog ate"
- Nominalization → verb: "made a decision" → "decided"
- Drop implied subject when context allows: "System should log errors" → "Log errors"
- Redundant pairs → single: "each and every" → "every"
- Clause → modifier: "anomaly that was reported" → "reported anomaly"

## Examples

| Original | Compressed |
|----------|------------|
| The system was designed to efficiently process incoming data from multiple sources | System design: efficient process incoming data, multiple sources |
| There were at least 20 people who appeared to be waiting | At least 20 people apparent waiting |
| It is important to note that the medication should not be taken without food | Medication: should not take without food |
| The researcher made a decision to investigate the anomaly that was reported | Researcher decided: investigate reported anomaly |
