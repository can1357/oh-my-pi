---
name: typesafe-ai
license: MIT
description: >
  Build AI-powered software with TypeSafe: small units of AI intelligence you
  can use like programming primitives. Its System One models, including Jev,
  turn natural language and application state into typed judgments and
  probabilities that code can combine. Use when a feature needs programmable
  common sense, when brainstorming what AI could make possible in an app, or
  when an LLM prompt-and-parse step could become a structured decision.
  Applications include routing, ranking, extraction, verification, and
  interactive experiences; these are starting points, not the limits.
  Read live docs and cookbooks to find useful patterns and discover new combinations.
---

# Build with TypeSafe

TypeSafe makes units of AI intelligence usable like programming primitives: small
judgments you can compose into larger capabilities. Its **System One models** return
fast, focused judgments that software can consume directly. **Jev** is TypeSafe's
flagship and first System One model. It understands natural language and returns
typed answers and probabilities rather
than generating text or reasoning explanations. Code owns the workflow; the model
supplies programmable common sense where ordinary code needs semantic understanding.

## Read the live docs

**The live TypeSafe docs are the source of truth. Read them as part of the task.**
This skill gives direction; the docs carry current concepts, prompting guidance,
API contracts, SDK usage, models, limits, and worked examples.

- Start with the [documentation index](https://docs.typesafe.ai/llms.txt) to discover
  relevant pages and cookbooks. Use targeted reads rather than loading the entire site.
- Mintlify serves Markdown by appending `.md` to a page path, for example
  [how to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md).
  Follow links from the index; convert extensionless documentation page links to
  `.md` when useful. Resolve relative links against `https://docs.typesafe.ai`.
- Before writing an integration, read the current API or chosen SDK page and the
  question guidance relevant to the design. For a new workflow, also inspect the
  closest cookbook: it often shows a better decomposition than a generic classifier.
- If the index is unavailable, use the direct links below or the site's navigation.
  If Markdown fetching fails, try the normal page. If live access is unavailable,
  use available local docs or installed SDK types, state that limitation, and avoid
  inventing version-dependent details.

| Task | Start here; follow the relevant details |
| --- | --- |
| Understand the programming model | [System One](https://docs.typesafe.ai/concepts/system-one.md), [building guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md) |
| Explore what to build | [Use-case map](https://docs.typesafe.ai/concepts/use-case-map.md), then relevant cookbooks from the index |
| Prepare inputs and questions | [State](https://docs.typesafe.ai/concepts/state.md), [primitives](https://docs.typesafe.ai/primitives.md), then the chosen primitive's page |
| Decide how to handle uncertainty | [Confidence](https://docs.typesafe.ai/confidence.md) |
| Write API code | [HTTP API](https://docs.typesafe.ai/api.md), [Python SDK](https://docs.typesafe.ai/sdk/python.md), or [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md) |
| Update an older integration | [Migration guide](https://docs.typesafe.ai/migrating-to-v1.md) and the installed SDK's current reference |

## Find the useful shape

Start from the behavior the user wants: what will the application show, select,
change, or hand off? Work backward to the judgments it needs. Keep known rules,
calculations, exact lookups, and execution in code. Preserve the user's chosen stack
and scope; add TypeSafe where semantic understanding helps.

When brainstorming or choosing an architecture, consider more than classification.
The patterns below are starting points: combine primitives around the user's goal,
including ideas that do not fit an established recipe.

- **Route and fill known arguments.** A request can select a handler and its typed
  parameters. Ask useful branch-specific questions up front and consume only the
  relevant answers. Explore [function calling](https://docs.typesafe.ai/cookbooks/function_calling.md)
  and [speculative fan-out](https://docs.typesafe.ai/patterns/fan-out.md).
- **Select instead of generate.** Find candidate values or source spans in code,
  use a judgment to select the intended one, then copy or normalize it. Code can
  also assemble source text into a formatted document or reading guide. Explore
  [value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook.md)
  and [structure recovery](https://docs.typesafe.ai/cookbooks/autoformat.md).
- **Find and judge evidence.** Retrieve candidates, compare their relevance to a
  query, and select useful context. Explore [reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md)
  and [hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification.md).
- **Turn judgments into reusable data.** Score dimensions once, then let code or
  user controls change weights, thresholds, rankings, and views. With labeled
  outcomes, those signals can become classical ML features. Explore
  [composite scoring](https://docs.typesafe.ai/patterns/composite-scoring.md) and
  [feature discovery](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery.md).
- **Verify and escalate.** Check specific claims or fields against their evidence;
  send uncertain or failing cases to a person or reasoning model. Explore
  [citation checks](https://docs.typesafe.ai/cookbooks/citation_check.md) and
  [extraction cascades](https://docs.typesafe.ai/cookbooks/sde_cascade.md).
- **Respond to changing state.** Code can retain goals and observations while fresh
  judgments guide the next bounded step. Keep inferred state distinct from observed
  facts, and check freshness before applying a result to a changed situation.

For open-ended requests, offer the few directions that best serve the user's goal
and recommend a starting point. For a concrete request, choose the relevant pattern
and build; a brainstorm is not a mandatory detour.

## Design the judgments

Choose by what the answer means, then read the relevant primitive page:

| Need | Primitive | Important distinction |
| --- | --- | --- |
| One of a defined set | [Choice](https://docs.typesafe.ai/primitives/choice.md) | Picks one option; its distribution compares competing options |
| Whether a condition holds | [Noul](https://docs.typesafe.ai/primitives/noul.md) | Probability of yes; no separate confidence; use one per label when several may apply |
| Degree along a described dimension | [Score](https://docs.typesafe.ai/primitives/score.md) | Probability-weighted position on ordered levels; use comparable per-item Scores for graded ranking |

Give each question enough relevant **state** to answer: source text, identities,
relationships, policies, and current facts. Prefer named JSON fields when context
has several parts. Put the judgment in **instructions** and define its possible
answers in **criteria**. Question IDs are for code and are not sent to the model;
include complete meaning in the question. Reference nested state with backticked
paths such as `ticket.messages[0].text`.

Ask one narrow, coherent judgment per question. Split independently useful dimensions,
without destroying the relationship being judged. A bounded action selection or
contextual interpretation is valid; atomic does not mean literal fact extraction
or a one-sentence limit. Strings work for simple questions. Use structured objects
or arrays when definitions, contrasts, exclusions, or examples clarify instructions
or criteria. Score levels must describe concrete situations and stand on their own.

Keep the needed answers available. Include a no-match outcome when nothing may fit;
use a separate presence judgment when it is independently useful. For source-value
selection, check candidate coverage: the model cannot choose an omitted value.

## Compose and verify

**Ask independent questions over the same state together**, including useful
speculative questions. They run in parallel and cannot see one another's answers.
State each speculative premise explicitly; code consumes the applicable answers.
A second request is warranted when an earlier answer is needed to fetch evidence,
construct new state, or determine the next options. Extra questions still use tokens;
measure actual request budgets, cost, and end-to-end latency.

Use probabilities and confidence to guide behavior, with thresholds evaluated on
the user's data and consequences. Choice/Score confidence summarizes distribution
concentration, not overall workflow correctness or permission to act. A Noul near
0.5 means similar probability for yes and no, not medium intensity. Several
acceptable alternatives can also spread probability; low confidence need not
invalidate a harmless preference choice. Ignore uncertainty on unused branches.

Keep policy explicit and raw judgments reusable. Weighted scores suit compensating
preferences; an “any serious violation” rule needs separate conditions. Changing a
weight or display filter need not rerun inference when evidence and question meanings
are unchanged. Typed output guarantees the interface, not truth. System One models
are trained for calibrated decisions; validate their performance in the target domain.

Test representative cases and the resulting application behavior. For failures,
inspect the exact state, questions, candidates, answers, composition, and observed
outcome. Separate missing evidence, model errors, code errors, and service failures.
Treat cookbook thresholds and demo results as examples to evaluate, not universal
rules or permanent model limitations. Keep API credentials server-side in web apps.
