---
name: semantic-compression
description: Re-encode verbose prose into a dense telegraphic register — punctuation as connectives, label frames, verbless assertions — without losing normativity or precision. Use when compressing system prompts, tool/function descriptions, skill bodies, or agent instructions; reducing token count or context bloat; making documentation token-efficient for LLM input; or rewriting text in compressed notation.
---

# Semantic Compression

Compression is **re-encoding, not word deletion**. Filtering function words out of an English sentence leaves a damaged English sentence (`System design: efficient process incoming data, multiple sources`). Instead re-frame each claim in a register whose grammar is punctuation and layout — then the function words have no work left and drop out on their own.

Target texts are load-bearing: tool descriptions, system prompts, skills. A model executes them cold, with no author present to disambiguate. Compression that forces a guess is a bug, not a saving.

## Procedure

0. **Density gate — check before touching anything.** Two signals, in order: (a) are articles and copulas already near-absent? (b) compress one representative section and measure the token delta. Already in this register (house-style prompt, tool doc, spec) or delta under ~10%? **STOP. Report that it is already dense and keep the original.** Bullet length alone is a weak signal — API literals and enumerations inflate it. Measured on a real house-style tool prompt: 853 → 778 tokens (8.8%), while that pass silently dropped a `NEVER assume …` rule, a throw condition, and a `full-res` detail. On already-dense text the remaining words *are* the payload, and the expected saving is smaller than the expected loss.
1. **Split** the source into atomic claims: one definition, obligation, default, or fact each.
2. **Inventory the payload first, before deleting anything.** List every load-bearing token: identifiers, error/exception names, throw conditions, defaults with their units, bounds, and every MUST/NEVER/PREFER line. Anything you then drop is a loss you declare deliberately rather than discover later.
3. **Cut what the model already knows.** "JSON is a text format", "tests catch regressions" → delete. Keep only what is specific to this tool, repo, or domain.
4. **Cut restatements.** Merge every duplicate of one rule into a single canonical line, placed where it is needed. Two statements of one rule with *different scope* are not duplicates.
5. **Frame each claim** — definition · obligation · default · condition→consequence · enumeration · verdict. The frame picks the construction.
6. **Hoist repeated qualifiers** into one scope line: three mentions of "relative to the repo root" → `All paths repo-relative.` once, up top.
7. **Re-encode**, then run Verification.

## Frames

| frame | English | compressed |
|---|---|---|
| definition | "The `name` field is the stable launch identifier." | `name: stable launch id.` |
| obligation | "You must call open before you can run code." | `MUST open before run.` |
| default | "If no value is given, the timeout defaults to 30 seconds." | `Default 30s.` |
| condition→consequence | "Because navigation re-renders the page, refs become stale, so you should snapshot again." | `Navigation invalidates refs → re-snapshot.` |
| property chain | "z' is an integer because z divides x²+y², and it is positive because x²+y²>0." | `z' integer since z divides x²+y²; positive since x²+y²>0.` |
| enumeration | "The action may be open, close, or run." | `action: open, close, run.` |
| exclusion | "any triple that is neither (1,1,1) nor (1,1,2)" | `triple ≠ (1,1,1),(1,1,2)` |
| verdict | "Claim A is true, and claim B is false as stated." | `A true; B false as stated.` |
| precondition | "This requires that the branch has already been checked out." | `Requires prior checkout.` |

Constructions behind them:

- **Verbless assertion** — `X true` / `X false` / `X required` / `X unsupported`. Copula deleted; the predicate carries.
- **Label frame** — `X: value` for "the X is / means / consists of". One colon per line, never nested.
- **Subject elision across a run** — name the subject once, chain bare predicates: `Integer since …; positive since …; unique.`
- **Asyndeton** — parallel items, no conjunction: `articles, copulas, expletives`.
- **Scope declaration** — one line retypes everything after it: `All paths repo-relative.` · `Times in ms.` · `All congruences mod 4.`
- **Lazy specification** — state only enough to decide: `3·13·34-1 big` (over the bound; exact value irrelevant). Name the bound somewhere the reader can see it.
- **Metonymy** — an object stands for the proposition about it: `y=z implies (1,1,1)`. Only where exactly one reading exists.

## Operators

Punctuation carries the connective:

- `:` — announce, name, define ("is", "means", "the following")
- `→` — yields, produces, becomes ("which results in")
- `⇒` — therefore, concludes
- `—` — gloss, or "therefore"
- `/` — equivalently, i.e.
- `;` — next step, same topic ("Then,", "After that,")
- `,` — inference chain ("and so")
- `≠` — neither/nor, distributed over a list
- `✓` — verified, obligation discharged
- `>` — precedence ("arg > env > default")
- `|` — alternatives within an enum ("open | close | run")

Ambiguity is the only disqualifier, never unfamiliarity. Where a glyph takes a second reading *in its slot* — `—` as a parenthetical dash, `/` as a path separator or "per", `,` as a list comma — write the word instead.

**Symbols do not save tokens; structure does.** Measured (cl100k_base; Claude's tokenizer differs, but BPE arity for rare glyphs is similar): `→` `⇒` `≤` `·` `✓` cost 1 token each, `≡` costs 2, ` -> ` costs 2, and ` gives` costs 1. So a one-for-one word→glyph swap saves nothing and costs clarity. Substitute a glyph only where it eats a *multi-word phrase*. Superscripts do pay: `x²+y²` = 4 tokens, `x^2+y^2` = 6.

Never invent private glyphs — a bespoke one needs a legend that costs more than it saves.

## Deletion

**Always delete:** articles; copulas (is/are/was/be/been); expletive there/it; complementizer `that`; relative pronouns; intensifiers (very, quite, really, extremely); filler ("in order to"→to, "due to the fact that"→because, "it is important to note that"→∅, "in terms of"→∅); politeness ("please", "feel free to"); hedged framing ("you may want to consider").

**Delete unless load-bearing:** auxiliaries (have/do/will); pronouns with an obvious referent; prepositions of/for/to/in/on/at/by; conjunctions where the list is obvious; adverbs already implied by the verb ("shout loudly").

**Never delete — this is the payload:**

- Normative modals: MUST, NEVER, SHOULD, MAY. The RFC 2119 word *is* the instruction.
- Negation and exception: not, no, never, without, none, except, unless.
- Numbers, units, bounds, quantifiers: "at least 5", "≤100", "max 1 MiB", "1-indexed".
- Conditionals and causality: if, unless, because, since, so.
- True hedges: "approximately", "usually", "appears" — deleting one asserts certainty the source did not have.
- Exact strings: identifiers, API names, flags, paths, regexes, format literals, error text.
- Examples that demonstrate a shape. Compressing an example destroys the thing it demonstrates.
- Prepositions where the relation flips meaning: "read from X" ≠ "read to X".
- Throw/failure conditions, and warnings about silent failure ("never assume it landed because no error appeared"). They read like padding and are behavioral.
- Scar tissue: a line that exists because someone already made that mistake. It looks redundant *because* it now prevents the error. `git blame` before cutting anything that looks obvious.

## Private register — never ship

The scratchpad style that generates this register carries features that work only while writer and reader are the same person, minutes apart. Strip all of them:

- **External deixis** — `A`, `B`, `C`, `G`, "the equation", "the claim above". Shipped text is self-contained: name the thing.
- **Scratchpad residue** — `Hmm`, `Actually`, `Wait`, `just`, `fine`, `Good`; goals revised mid-line; abandoned clauses.
- **Layered corrections** — a wrong value left standing beside its fix. A cold reader cannot tell which pass won. Delete the loser.
- **Dead branches** — an abandoned approach left beside the chosen one. A model may execute the abandoned one.
- **Ambiguous `...` and `?`** — in notes they mean omitted / abandoned / infinite, and conjecture / check-this. In shipped text they mean nothing. Drop both.
- **Nested colons** — `Step: from X: cases: a,b=1: 3-c:` is unparseable cold. One colon per line.
- **Unmarked instruction vs data** — a bare line like `Word limit 1200 - write concisely` sitting in content is indistinguishable from content. Keep instructions in a marked channel: heading, tag, or MUST line.
- **Revisiting instead of rewriting** — fine while thinking, fatal in a prompt. One canonical statement per rule.

## Tool and skill descriptions

The body compresses hard. The trigger does not.

- A tool's or skill's `description` field is **retrieval surface**, not documentation: it is matched against the user's own phrasing. Keep natural, keyword-redundant alternatives ("compress prompt", "reduce token count", "token-efficient") even though a reader needs only one. Compress the body; NEVER compress the trigger.
- Params — drop type, enum, or default from the prose ONLY when the *wire* schema the model actually sees exposes it, and (if you ran the `tool-prompt-optimization` probe) the probe recovered it from schema alone. Otherwise keep it. **Defaults are the trap:** wire schemas frequently omit `default` entirely, and even when present it carries no direction or semantics — `gitignore: true` does not say "respects gitignore" — which is why `tool-prompt-optimization` classes defaults-and-their-direction as content no model recovers. Absent that evidence, preserve the default, its unit, and any precedence rule (arg > env > default). Prose always keeps what no schema can express: interaction, precedence, failure mode.
- Imperative for actions (`open before run`); label frames for facts (`Default 30s.`).
- Scope split — this skill owns the *re-encoding mechanics* only. What belongs in a tool prompt at all (anatomy, surface-not-machinery, what stays out) → `tool-prompt-optimization`, which also measures schema/prose overlap before you cut. House style (tag vocabulary, RFC 2119 keywords, positioning) → `system-prompts`. Compress after those two have decided *what* ships.

## Worked example

Source (55 words, 63 tok):

> The `timeout` parameter controls how long the tool will wait for the process to become ready. If you do not provide a value, it defaults to 30 seconds. Note that if you have specified both a log pattern and a port, then both of these conditions must be satisfied before the process is considered ready.

Compressed (14 words, 20 tok):

> `Readiness timeout: default 30s. Log pattern + port both supplied ⇒ BOTH must pass.`

Rejected as over-compressed — `timeout 30 log+port both`: loses the unit, loses that 30 is a *default* rather than a fixed value, loses the obligation, and leaves `both` dangling.

## Verification

1. **Declare every loss, then judge the draft against that list.** Name each dropped claim, qualifier, default, example, or exact string, and why the text is still correct without it. A declared loss is a decision a reader can audit; an undeclared one is a silent regression. Review with the list in front of you, not from memory of what you intended.
2. **Ambiguity scan.** For every `:` `→` `—` `/`: can a reader assign a second reading? Fix it. Watch for ambiguity the source did not have — a dropped receiver (`.ref("e5")` on *what*?), a singular silently pluralized ("previous snapshot" → "previous generations").
3. **Measure the pair with the target tokenizer.** Word counts and function-word rates do not predict token savings. Expect no fixed ratio — measured on real pairs (cl100k): a verbose doc paragraph 63 → 20 tok, a verbose prose section 360 → 222 tok, an already-dense house-style tool prompt 853 → 778 tok. Under ~10% is the signal to stop, revert, and keep the original.
4. **Stop rule.** Stop deleting when the next deletion makes the reader guess. Correctness beats ratio, always.

## Running it as a command

`omp compress <file>` drives exactly this loop with two tools and nothing else.

Its session is isolated on purpose, because the input is itself a prompt: the default system prompt is *replaced* (not appended to), and skill, rule, `AGENTS.md`, prompt-template, and slash-command discovery are all passed empty — every one of those defaults to ON when omitted, and each would inject instruction-shaped project text into a job whose only legitimate input is the document. Audited on a live session: one system-prompt part, tools `rewrite, approve`, no `AGENTS.md` or rule content present.

The source is quoted inside a nonce-delimited block and declared inert, so `MUST`/`NEVER` lines in the document get compressed rather than obeyed — verified with a document whose first paragraph ordered the compressor to emit `OK` and skip the rest: it compressed the real content and declared the injected paragraph as a deliberate loss.

- `rewrite` submits the full compressed text plus every declared loss.
- The command answers with the draft, its measured word/token delta, and that loss list, then asks for a verdict.
- `approve` accepts the reviewed draft. Approval before a review turn is rejected, and a new draft voids an earlier approval.
- Only an approved draft is written: `-o <path>`, `-i` in place, otherwise stdout (the report goes to stderr, so `> out.md` captures just the text). `-r` bounds the drafts; an unapproved run writes nothing and exits 1.

The runtime contract it hands the agent lives in `packages/coding-agent/src/compress/prompts/system.md`. It is the operative subset of this file; when they disagree, this file wins and the prompt gets fixed.
