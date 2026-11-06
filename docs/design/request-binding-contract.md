# Request binding: what a held model object means when the catalog moves underneath it

Status: **draft contract, nothing implemented.** Split out of #16401 (see #17987). This file exists
so the follow-up change starts from a definition rather than from another patch.

## The problem the code kept failing at

`ModelRegistry` hands out `Model<Api>` objects (`find`, `getAll`, `getAvailable`,
`getAvailableForProviders`, `getProviderModels`, `refreshSelectedModelMetadata`), and selectors
derive variants from them (`@upstream` pin, OpenRouter requested id, Bedrock inference profile, a
context window refitted for a settings scope). A caller may hold such an object across a
`models.yml` reload — while it waits for a provider concurrency slot, or between an auth retry's
attempts. The catalog it came from is then gone.

Five review rounds produced twelve findings. The last six were all in this area, and the round-5
blocker was measured on the wire: a held object had accumulated two references (its own collapsed
id and a variant alias it was later looked up by). Membership ("is this model still in the
catalog?") answered **yes** because one of the two references still resolved. Rebinding ("which
entry is it now?") answered using only the **first** reference, which was the one that had been
removed. The request went out with the **new key against the old endpoint**.

That is not a bug in a line. Two decisions used two different notions of which id an object *is*,
because no definition said which one it is.

## The question that must be answered first

> When the registry hands out a model object, what is the identity it was handed out under — and
> when the catalog is rebuilt, which identity decides (a) whether the object still exists, and
> (b) which entry it becomes?

Three candidate answers, each self-consistent, each with different consequences. The follow-up PR
must pick one, write it down, and make every decision read it.

1. **One reference, fixed at hand-out.** An object's identity is the id it was *first* looked up
   by. A later lookup under a different alias produces a *different* object (no sharing). Both
   membership and rebinding use that one reference, so they cannot disagree. Cost: the registry
   must stop returning the same object for two ids, which means copying rows on alias lookups and
   losing identity-keyed caching for callers that currently rely on it.
2. **A set of references, used identically by both decisions.** An object is reachable under every
   id it was handed out under. Membership passes when *any* resolves; rebinding must then also
   consider the set — and needs a stated rule for *which* member wins when several resolve to
   different entries (first-handed-out? most recently looked up? refuse and force re-resolution?).
   The round-5 defect is exactly this rule left unwritten.
3. **No identity: rebind by (provider, id) of the object itself.** Drop the hand-out bookkeeping
   entirely; a request binds by looking the model's own `provider`/`id` up in the current catalog.
   Simplest, and the variant/alias cases (an `@upstream` pin, a collapsed id) are then explicitly
   out of scope — a pinned variant is sent as the caller built it, not rebound.

## What the contract must settle, whichever answer is chosen

- **Membership and rebinding are one function or read one rule.** They must never be able to
  disagree; that disagreement is the defect.
- **Derived variants.** Whether a derivation is rebound by rebinding its source and re-deriving,
  or is out of scope. If rebound, the derivation must survive (a pin stays a pin) and the scope a
  refit followed must be named.
- **Limits.** Which of a held object's `contextWindow`/`maxTokens` survive a rebind. #16401's
  round-3 note records a known limitation here: *removing* a configured limit does not reach a held
  model through the rebind (computing configured limits inside the hand-out path recurses through
  `resolveModelOverrideWithAliases` back into `find` and overflows the stack). Any contract must
  say what removal does.
- **Credential pairing.** What it means for a credential and a model to come from "one
  configuration version", and what a resolver that straddles a rebuild reports.
- **Non-registry models.** An SDK caller's own model object is sent as given. That must be stated,
  not inferred from a `WeakMap` miss.
- **Bounded retries.** A configuration that keeps moving, or one that no longer defines the model,
  must terminate in a named error rather than loop.

## Why this is not in #16401

#16401 now carries only the two reload behaviours, which have been green with red controls since
`23161091`. Request binding rode along from #17987, is under-specified at the level above the code,
and produced a new blocking finding in each of the last three rounds. It gets its own change,
starting with this contract.
