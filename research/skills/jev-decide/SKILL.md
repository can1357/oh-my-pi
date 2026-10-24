---
name: jev-decide
description: "Use when a decision has to be made many times over: screening records, routing items to a branch, verifying a claim against a source. Calls TypeSafe Jev (System One) for calibrated probabilities on typed questions. Never use it to write, explain, summarize, or reason - it emits distributions, not text."
---

# jev-decide

Jev is a decision-only model: you hand it a `state` (the thing being judged) plus typed
`questions`, and it returns a probability distribution per question. No prose, no chain of
thought, no tool calls. It is fast (~100ms server-side) and cheap, which is the whole point -
it is the pass you run over 2,000 records before an LLM reads any of them.

Client: `../literature-search/scripts/jev_client.py`. First consumer:
`../literature-search/scripts/jev_screen.py` (title/abstract first pass).

## When it fits

- The same judgment, repeated at volume, with a fixed set of criteria.
- The answer is a label or a number, and a probability on that answer is useful.
- Being wrong occasionally is acceptable BECAUSE the uncertain cases escalate to something
  smarter. If nothing escalates, do not use Jev.

## When it does not

- Anything that has to produce text (rationales, summaries, search strings, reviews).
- Judgments that need multi-step reasoning or evidence the `state` does not contain.
- One-off decisions. A single call is not worth the plumbing; ask the agent.

## The fan-out idiom

ONE call carries every independent question about the same state. Measured on this API,
fan-out is 8.65x faster and 4.29x cheaper than the same questions asked sequentially,
because the state is tokenized once.

```python
questions = {k: {"type": "noul", "instructions": f"Does this record meet the '{k}' criterion: {text}?"}
             for k, text in criteria.items()}
resp = jev_client.fan_out(state, questions, api_key, model="jev-latest")
p = {k: resp["answers"][k]["noul"] for k in criteria}
```

Only fan out questions that are independent of each other. A question whose answer depends
on another question's answer needs a second call.

## Bands live in code, never in the model

Jev returns a probability. The decision - and the thresholds that produce it - belong to
your code, checked into the repo, testable offline, and changeable without touching a
prompt. `jev_screen.decide()` is the whole policy: include at `min_p >= 0.90`, exclude at
`min_p <= 0.10`, and everything between those two numbers is left untouched for the slower
judge. Never ask the model "should I include this?" - ask it the criterion question and let
the band answer that.

Aggregate several criteria with `min` (all must hold), not with an average: an average lets
a strong Population score paper over a failed Context, which is exactly the record a human
would catch.

Name the question keys after whatever downstream consumes them. In the screener they are
the PCC dimensions (`Population`, `Concept`, `Context`, `Other`) because `jev_screen.py`
passes the lowest-scoring key straight through as `review.py verdict --reason`, and that
string is printed verbatim as a PRISMA exclusion-reason row next to the screener agent's
own reasons. A key the agent would never write fragments that breakdown into near-duplicate
rows.

## Calibrated across many calls is not correct per call

A calibrated model means: of the records it scores at 0.95, about 95% really do meet the
criterion. It does NOT mean a given 0.95 is right. Live testing produced a confidently wrong
answer (high probability, wrong side) on the first small sample. Design for it:

- Wide bands. The default 0.90/0.10 deliberately sends most records to the LLM screener.
- Every auto-decision records its probabilities in the rationale
  (`[jev-1.13.0 p=0.04] exclude on criterion 'Context' (Concept=0.71, Context=0.04, Population=0.88)`),
  so any verdict can be audited or overturned later.
- Verdicts go through the same store and history as human ones. Nothing is special-cased,
  so PRISMA counts stay honest and a reviewer can flip any of them.

## Question types

`noul` is the boolean one and the only type the screener uses: it returns a single float in
`answers[key]["noul"]`, the probability the statement is true. **There is no separate
confidence field** - the probability IS the answer, and its distance from 0.5 is the only
uncertainty signal you get. Do not invent a confidence score beside it.

`choice` picks one option from a supplied set; `score` returns a bounded number. Both are
speculative extras on a fan-out: cheap when you were already calling, never worth a call of
their own.

## Key resolution and the no-key path

`jev_client.resolve_key()` checks, in order:

1. the `TYPESAFE_API_KEY` environment variable,
2. a `TYPESAFE_API_KEY=...` line in `~/.research-harness/config.env`,
3. nothing - returns `None`.

No key is a supported state, not an error. `jev_screen.py` prints
`Jev first-pass OFF (no TYPESAFE_API_KEY)` to stderr and exits 0; `research doctor` reports
it as an optional capability and still exits 0. The key is never printed, logged, or written
into a rationale.

## Budget

`JEV_MAX_RECORDS` (default 200) caps records per run, and `--limit N` is clamped to it. A
fan-out measures 420-799 input tokens per record at $0.042/M input, so a 1,000-record pass
costs roughly $0.025 - the cap exists to bound a runaway loop, not the bill.

Pin the version you actually got: the response carries a versioned `model` field
(`jev-1.13.0`), and that string - not the `jev-latest` alias you requested - is what lands
in the rationale.
