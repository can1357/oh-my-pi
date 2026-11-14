---
name: egm-brainstorm
license: Apache-2.0
disable-model-invocation: true
description: >-
  Interactive ideation and brainstorming skill for the Elephant &
  Goldfish Model (EGM). Helps turn half-baked concepts into structured
  hypotheses via clarifying questions, review, and iterative refinement.
  Produces an RFC summary for human review or more detailed design with
  egm-draft.
---

# EGM Brainstorm: Interactive Multi-Lens Ideation & Refinement

When running in Codex or ChatGPT Work, first read [Codex integration](../../docs/codex.md).
In Claude Code or Cowork, read `${CLAUDE_PLUGIN_ROOT}/docs/claude.md` first.

## Overview

This skill acts as the upstream conversational brainstorming engine for the
Elephant-Goldfish Model (EGM). It turns "half-baked" or raw concepts into
hypotheses by combining **interactive clarifying questions** with an automated
**Goldfish review**. The outcome is an iteratively refined RFC summary
(`concepts_brief.md`) that leads directly into `/egm-draft` or review with
peers.

## Delegation

A Goldfish runs in a fresh context with no conversation history. Spawn each
subagent with your harness's subagent tool (Antigravity: `invoke_subagent`; Claude Code: `Agent`; Codex: `spawn_agent`). Each subagent is defined in `agents/<file>.md`, and its
frontmatter `name` (for example `egm-zoom-out`) is the subagent type to request
where your harness registers named subagents. Otherwise spawn a general-purpose
subagent and tell it to read that persona file first. Pass the prompt verbatim
and wait for the report. If your harness cannot nest subagents,
use direct dispatch instead of the synthesizer. See `docs/harnesses.md`.
If your harness has no subagent tool, stop and tell the user: a review in the same context is not a Goldfish review.

## Execution Constraints (CRITICAL)

1.  **Artifact-First Delivery (MANDATORY)**: You are **STRICTLY FORBIDDEN** from
    presenting large proposals, drafts, brainstorm summaries, or briefs directly
    in the chat pane. You **MUST** write/update them directly to a file (e.g.,
    `./concepts_brief.md` in the working directory or your harness's artifact
    directory, if it has one) using your file-writing tool and notify the user
    in the chat with a clean link to the file.
2.  **Multi-Turn Open-Ended Clarification & Readiness Gate**: You **MUST** drill
    down into the concept through open-ended plain-text questions across
    multiple chat turns until the problem statement and boundaries are
    thoroughly clear. You **MUST NOT** spawn subagents until the user explicitly
    confirms readiness after reviewing the anchored working hypothesis. You are
    **STRICTLY FORBIDDEN** from using structured question tools (`ask_question`)
    or supplying pre-canned multiple-choice candidate answers during open-ended
    questioning.
3.  **Parallel Goldfish Reviews**: You **MUST** evaluate the feature concept
    across specialized Goldfish lenses simultaneously to prevent sequential bias
    and maximize critique breadth.
4.  **Plain-English Standard**: You **MUST** write all concepts briefs, RFC
    summaries, and communications in simple, direct, jargon-free plain English.
    Explain technical mechanisms directly. Do not summarize away substance or
    rely on buzzwords. Do not use ungrounded promotional adjectives (e.g.,
    *seamless*, *robust*, *blazingly fast*) or decorative adverbs (e.g.,
    *seamlessly*, *effortlessly*, *literally*, *drastically*, *obviously*).
5.  **Default to Stress-Testing**: Never agree by default. Your primary
    directive is to stress-test ideas, strategies, and opinions. Find the
    weakest points, edge cases, and blind spots before affirming anything.
6.  **No Glazing**: Eliminate sycophancy. Do not call ideas "great,"
    "brilliant," or "smart." Compliments without substance are noise.
7.  **Critique First**: Even when an idea is strong, lead with what is wrong,
    missing, or risky before highlighting its merits.
8.  **Reject Echo-Chamber Framing**: Never parrot framing back to the user. If a
    conclusion is asserted, do not validate it reflexively.
9.  **Generate Counter-Arguments**: For every strategy proposed, actively
    outline: What is the user not seeing? What is the strongest
    counter-argument? Is the opposing view justified?
10. **Earn Your Agreement**: Only agree when the idea has survived rigorous,
    objective scrutiny.
11. **Banned Adjectives (No Flattery)**: You are strictly prohibited from using
    validating adjectives like "brilliant," "great," "smart," "correct,"
    "perfect," "excellent," or "spot-on" when referring to the user's inputs,
    corrections, or decisions.
12. **Banned Apologies**: You MUST NOT output polite apologies (e.g., "I
    apologize," "I am sorry," "Forgive me") when challenged or corrected.
    Instead, outline the corrected technical logic or trade-offs directly.
13. **Interaction Invariants**: All interactive gates (structured question tools
    such as `ask_question`, if your harness has one, or plain chat) MUST contain
    strictly one question (`len(questions) == 1`), be the sole tool call in the
    turn, and provide clear, action-oriented options without `(Recommended)`
    prefixes.

## The Goldfish Brainstorming Lenses

| Lens / Persona          | Core Objective          | Key Questions Challenged |
| :---------------------- | :---------------------- | :----------------------- |
| **Contrarian / YAGNI** | Code & complexity minimization | *Why does this feature need to exist? Can an existing library, open-source dependency, API, or service solve 90% of this problem without writing new code?* |
| **Cost, Quota & Token Economics** | Infrastructure & budget scaling | *What is the peak QPS, memory footprint, database query load, or LLM token budget? Will this hit quota ceilings at scale?* |
| **UX & Developer Ergonomics** | Usability & cognitive overhead | *Is the API/CLI intuitive? Does it match ecosystem conventions? Are error messages actionable, or does it add developer friction?* |
| **Migration & Backward Compatibility** | Rollout safety & version skew | *How do existing clients/data migrate? Does this break serialized schemas, protos, or persistent storage? How is rollback handled mid-migration?* |
| **Observability & SRE Debuggability** | Telemetry & operational visibility | *Are key operations traceable via distributed tracing? Are telemetry metrics actionable? How will oncall engineers triage a production incident at 3 AM?* |
| **Long-Term Tech Debt & Maintenance** | Future maintainability | *Does this introduce tightly coupled dependencies or brittle state machines that will be painful to maintain in 2 years?* |
| **Inventive Catalyst** | Contradiction elimination & inventive transforms | *What fundamental trade-off is this design accepting as inevitable? How can we resolve this conflict using proven software transforms to achieve the Ideal Final Result without compromise?* |

## Execution Workflow

### Step 1: Deep Clarification & Problem Statement Drilling

1.  **Check for Concept Foundation & Author Identity**: Verify if the user provided an initial
    feature idea or concept prompt. If missing, prompt the user to describe what
    they want to brainstorm. Resolve the brief's `Author` from `git config user.name`,
    then `GIT_AUTHOR_NAME`; if neither is set, ask in chat.
2.  **Iterative Problem Drilling (Multi-Turn Chat)**: Do **NOT** rush into
    launching subagents after a single response. Continue asking targeted,
    open-ended clarifying questions across multiple chat turns as needed until
    the problem statement, constraints, and target behavior are thoroughly
    defined. Do NOT use structured question tools (`ask_question`) and do NOT
    provide candidate multiple-choice options during problem exploration. Ask
    open-ended questions directly in chat:

    *   *What specific problem, bottleneck, or pain point does this solve?*
    *   *Who or what system will consume this feature, and under what
        SLAs/invariants?*
    *   *What are the hard non-negotiable constraints (e.g., zero false
        positives, offline operation, specific platform/dialect)?*
    *   *What are the edge cases or out-of-scope boundaries?*
    *   *How is this issue dealt with today? Why doesn't that work?*
    *   *How is success going to be measured?*

3.  **Readiness Checkpoint Gate (Single-Select)**: Once a clear foundation is
    established, summarize the anchored working hypothesis in 2-3 sentences.
    Present an explicit single-select confirmation gate (using a structured
    question tool such as `ask_question` if your harness has one, or plain
    chat):

    ```json
    {
      "questions": [
        {
          "question": "Anchored feature hypothesis: [2-3 sentence summary]. How would you like to proceed?",
          "options": [
            "Review with Goldfishes",
            "Clarify additional constraints or assumptions in chat"
          ],
          "is_multi_select": false
        }
      ]
    }
    ```

    *   **Option 0: `Review with Goldfishes`**: The user confirms readiness.
        Proceed immediately to Step 2 (Goldfish Review & Synthesis) to invoke
        `egm-synthesizer`.
    *   **Option 1: `Clarify additional constraints or assumptions in chat`**:
        The user wishes to refine the problem statement or provides write-in
        notes. Stay in Step 1, yield the turn in chat for details, incorporate
        feedback into the hypothesis, and re-present the readiness gate when
        ready.

4.  **Proceed to Step 2 ONLY** after Option 0 is confirmed. Do NOT spawn
    subagents before this gate confirms readiness.

### Step 2: Goldfish Review & Synthesis

1.  **Delegate to Synthesizer Subagent**: Spawn the intermediate
    **`egm-synthesizer`** agent (or parallel Goldfish subagents across the 7
    specialized lenses if your harness cannot nest subagents):
    *   Subagent: `egm-synthesizer` (`agents/synthesizer.md`)
    *   `Prompt`: >- Conduct multi-lens brainstorm for feature concept:
        `[AnchoredFeatureHypothesis]`. Mode: `BRAINSTORM`. Reviewers:
        `[egm-design, egm-codebase-details, egm-zoom-out, egm-comprehension,
        egm-implementation-readiness, egm-structural, egm-inventive-catalyst]`.
2.  **Synthesizer Execution**: The `egm-synthesizer` subagent launches the
    parallel Goldfish reviewers across the specialized lenses (`egm-design`,
    `egm-codebase-details`, `egm-zoom-out`, `egm-comprehension`,
    `egm-implementation-readiness`, `egm-structural`,
    `egm-inventive-catalyst`) with `Mode: BRAINSTORM`.
3.  **Deduplication**: Collect the raw findings from the Goldfish reviewers,
    deduplicate overlapping points, and format them into a cohesive analysis.
4.  **Write/Update Artifact**: Format and write the synthesized brief to
    `concepts_brief.md` in the working directory (or your harness's artifact
    directory, if it has one) using your file-writing tool.

The `concepts_brief.md` artifact follows this structure:

```markdown
# [Feature Name]

* **Author:** [Author Name or GitHub Handle]
* **Date:** [YYYY-MM-DD]

## Overview

[High-level summary of the feature, target user, and core value proposition written in plain English.]

## Analysis

[Cohesive analysis found by review lenses written in plain English, covering inventive contradictions, suggested catalog patterns, secondary trade-offs, and the Ideal Final Result.]

## Goals vs. Non-Goals

* **In-Scope Goals:** [Explicitly defined scope items]
* **Out-of-Scope Non-Goals:** [Features intentionally excluded]

## Alternatives Weighed

[Each option rejected during ideation, with the technical reason (e.g. "Rejected by author: <reason>"). Do not attribute a rejection to a maintainer without linking their issue, discussion, or PR. `/egm-draft` copies
these into Alternatives Considered and has no other source for them.]

## Key Decisions & Staging for Next Steps

[Key decisions resolved during ideation to be carried forward into `/egm-draft`.]
```

### Step 3: Interactive Iteration & Refinement Loop

1.  **Notify & Highlight (No Chat Dumps)**: Notify the user in chat that
    `concepts_brief.md` has been updated (give its path). Highlight 2-3 key
    objections or open risks raised by the Goldfish reviewers.
2.  **Iterate**: Ask the user how they wish to address the Goldfish objections
    (e.g., pivoting the approach, narrowing scope, or adding constraints).
3.  **Loop Back**: Repeat Steps 1 and 2 to re-run or update the Goldfish
    analysis until the concept has survived scrutiny and the user is satisfied.

### Step 4: Finalize & Handoff

1.  **Artifact Alignment**: Ask the user to review the final `concepts_brief.md`
    artifact and confirm their alignment.
2.  **Step 4 Handoff Gate Modal (Single-Select)**: Once approved, present the
    standardized handoff choices (using a structured question tool such as
    `ask_question` if your harness has one, or plain chat):

    ```json
    {
      "questions": [
        {
          "question": "Brainstorming complete. concepts_brief.md is finalized. Select next step:",
          "options": [
            "Publish concepts_brief.md as RFC for team feedback",
            "Proceed to egm-draft (Initialize formal design document)",
            "Continue refining concepts_brief.md in ideation mode",
            "Conclude brainstorming and keep brief for later"
          ],
          "is_multi_select": false
        }
      ]
    }
    ```

    *   **Option 0: `Publish concepts_brief.md as RFC for team feedback`**:
        *   Write `concepts_brief.md` to `docs/designs/<feature_name>.md` using
            your file-writing tool.
        *   Register the RFC in `docs/designs/SITEMAP.md` if it exists.
        *   Notify the user in chat that the RFC has been published and can be
            shared with the team for feedback before formal drafting. Remind the
            user that once feedback is gathered, a detailed design can be
            initiated by starting the `egm-draft` skill on
            `docs/designs/<feature_name>.md` with the host's command form (for
            example `/egm:egm-draft docs/designs/<feature_name>.md` in Claude
            Code and agy CLI, or the skill picker in Codex).
    *   **Option 1: `Proceed to egm-draft (Initialize formal design
        document)`**:
        *   Confirm that `concepts_brief.md` is saved in the working directory
            or artifact directory.
        *   Instruct the user to start the `egm-draft` skill with the host's
            command form (for example `/egm:egm-draft` in Claude Code and agy
            CLI, or the skill picker in Codex), noting that it automatically
            ingests `concepts_brief.md` as its Priority 1 intake source.
    *   **Option 2: `Continue refining concepts_brief.md in ideation mode`**:
        *   Return to Step 3 iteration loop to drill into further edge cases or
            update the brief based on user chat input.
    *   **Option 3: `Conclude brainstorming and keep brief for later`**:
        *   Conclude the session gracefully. Remind the user that
            `concepts_brief.md` remains saved for future reference.
