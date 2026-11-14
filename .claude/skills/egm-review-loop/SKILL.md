---
name: egm-review-loop
license: Apache-2.0
disable-model-invocation: true
description: >-
  Executes the Antagonistic-Review process from the Elephant-Goldfish
  Model (EGM) via an automated multi-agent review loop to audit documents
  against qualitative standards and structural templates, and automatically
  apply approved fixes. Use when reviewing design docs, READMEs, feature
  specifications, implementation plans, or verifying document completeness
  and tone.
---

# Goldfish Review: Loop (Orchestration Driver)

When running in Codex or ChatGPT Work, first read [Codex integration](../../docs/codex.md).
In Claude Code or Cowork, read `${CLAUDE_PLUGIN_ROOT}/docs/claude.md` first.

## Overview

This skill acts as the central orchestration engine driving the multi-agent
review loop. It coordinates two distinct agent memory models:

*   **The Goldfish (Adversarial Auditors)**: Subagents spawned in isolated,
    fresh context windows to catch unstated assumptions without historical bias.
*   **The Elephant (Persistent Resolver)**: The primary agent context holding
    institutional knowledge to evaluate findings and apply approved repairs.

The driver manages argument intake, resolves paths for reviewers and standards,
unconditionally re-parses target line ranges before every iteration, spawns
concurrent specialized Goldfish auditors based on configuration, and coordinates
with the Elephant context to resolve findings.

## Delegation

A Goldfish runs in a fresh context with no conversation history. Spawn each
subagent with your harness's subagent tool (Antigravity: `invoke_subagent`; Claude Code: `Agent`; Codex: `spawn_agent`). Each subagent is defined in `agents/<file>.md`, and its
frontmatter `name` (for example `egm-zoom-out`) is the subagent type to request
where your harness registers named subagents. Otherwise spawn a general-purpose
subagent and tell it to read that persona file first. Pass the prompt verbatim
and wait for the report. If your harness cannot nest subagents,
use direct dispatch instead of the synthesizer. See `docs/harnesses.md`.
If your harness has no subagent tool, stop and tell the user: a review in the same
context is not a Goldfish review.

## Inputs

The caller or user provides exactly these parameters:

*   **`TargetFile`**: Absolute or relative path to target document.
*   **`SemanticTarget`**: Descriptive targeting string (e.g., *"Target the H4
    block with SS-ID 'S1.12'"*), or `full file`.
*   **`Reviewers`**: List of reviewer names (shortnames or paths).
*   **`Standards`**: Mapping of reviewer names to standard names (shortnames or
    paths).
*   **`GoldfishContext`**: A reading list (source files, directories, or
    documentation URLs) fed to reviewers to establish their baseline. An empty
    list from the caller counts as provided; do not ask for it again. Some
    reviewers cannot open URLs, so before the first round save the raw page of
    each URL as a new file in the working directory (or your harness's artifact
    directory) and pass its absolute path instead. If a page cannot be saved,
    ask the user for a local copy and end your turn; if no one can answer,
    as in a headless run, leave it out, tell the user, and keep going.

## Path & Standard Resolution Logic

When resolving names in `Reviewers` and `Standards`:

*   **Reviewer Shortnames**: Map reviewer shortname (e.g., `design_critic`,
    `structural`, `style`, `implementation_readiness`,
    `codebase_details`, `comprehension`, `zoom_out`) to `agents/{name}.md`.
    The persona file defines the reviewer's core mandates, audit vectors, and
    output format.
*   **Standard Shortnames**: Map standard shortname (e.g., `feature-spec-standard`,
    `implementation-readiness-standard`, `zoom-out-standard`, `heilmeier-standard`,
    `re-implementation-standard`) to `resources/document_standards/{name}.md`.
*   **Custom Paths**: If the name contains a slash (`/`), treat it as an
    absolute or workspace-relative path and read it directly.

## Execution Workflow

### Step 1: Intake & Configuration UX

Evaluate the provided inputs (`TargetFile`, `SemanticTarget`, `Reviewers`,
`Standards`, `GoldfishContext`).

1.  **Identify Missing Inputs**: Determine which of the required parameters are
    missing.
2.  **Interactive Onboarding**:
    *   If **all** inputs are present, proceed to Step 2.
    *   If **some or all** inputs are missing, interactively prompt the user
        **only for the missing inputs**, one at a time via chat messages.
3.  **Reviewer Recommendations**:
    *   *Feature Specs*: Recommend `design_critic` (mapped to
        `resources/document_standards/feature-spec-standard.md`) and
        `structural` (mapped to `resources/document_standards/feature-spec-standard.md`).
    *   *Implementation Plans*: Recommend `implementation_readiness`
        (mapped to `resources/document_standards/implementation-readiness-standard.md`)
        and `codebase_details`.
4.  **Confirm Configuration**: Display the consolidated plan (Target, Reviewers,
    and mapped Standards) and ask the user to confirm before proceeding.

### Step 2: The Sharpening Loop (Iterative Cycle)

Execute the following sequence in a continuous loop:

#### 2.1 Unconditional Target Resolution

Before every iteration, unconditionally re-scan `TargetFile` by reading it
and using the stable `SemanticTarget` string (e.g., locating the target header) to
dynamically determine the updated absolute start and end line numbers. This
ensures absolute accuracy even if the file was edited in prior rounds. (If `full
file` mode is specified, confirm full-file line bounds).

#### 2.2 Review Swarm Execution

1.  **Launch Subagent Swarm**:
    Spawn subagents to execute the review:
    *   **Hierarchical Dispatch (Synthesizer)**: Spawn the intermediate
        synthesizer subagent (`agents/synthesizer.md` / `egm-synthesizer`).
        The synthesizer spawns the Goldfish review swarm in
        parallel, deduplicates findings, writes the report artifact, and
        returns a single summary message to avoid context pollution in the root
        conversation. Pass it the Failed Reviewers rule below and
        `GoldfishContext`, and tell it to give those files to each reviewer.
        Its summary must give a status, `completed` or `not run`, for each
        requested reviewer.
    *   **Direct Dispatch (Flat Swarm)**: Alternatively, spawn each requested
        reviewer subagent in `Reviewers` directly.
        Instruct each subagent to first read its persona definition in
        `agents/{name}.md`, then audit `TargetFile` at the resolved line range
        against its designated standard in `resources/document_standards/`,
        supplying `GoldfishContext`.
    *   Each reviewer produces findings with severity (🔴 Blocker, 🟡 Major, 🟢
        Nit), line numbers, discrepancy descriptions, and rationales.
2.  **Consolidate Findings**: Collect all findings across reviewers into a single
    flat `FindingsList`. Give each finding a stable id
    (`<reviewer>-<round>-<n>`) and record its reviewer, severity, and affected
    scope.
3.  **Failed Reviewers**: A reviewer that times out, fails, or returns no report
    did not review. Retry it once. If it fails again, record it as **not run**
    in the report. Never count it as a reviewer with zero findings. If the
    synthesizer summary has no status for a requested reviewer, record that
    reviewer as not run.

#### 2.3 Aggregated Resolution Hand-off

1.  Pass `TargetFile`, the active line range, and the aggregated `FindingsList`
    to the **`egm-resolve`** workflow.
2.  Execute the resolution workflow in the primary Elephant context:
    *   Categorize findings into `CONTEST` vs. `PROPOSE FIX`.
    *   Save `goldfish_review_report.md` with your file-writing tool.
    *   Present the interactive decision gate (Auto accept, Continue, Interactive
        breakdown).
    *   Apply approved text repairs to `TargetFile` using your file-editing tool.

#### 2.4 Iteration Check & Turn Boundary

Fresh reviewers sample differently each round, so a round with zero findings
is rare even when the document improves. Use these rules instead:

*   **Settled findings**: A finding is settled when it is contested or
    recorded without a fix (accepted risk). Keep the settled list across
    rounds. If a new reviewer raises a settled finding again (same affected
    scope, same issue), do not re-open it.
*   **Fixed findings**: An applied fix does not settle a finding. If a later
    reviewer raises the same issue at the same scope, the fix failed or a
    later edit reintroduced the issue. Re-open the finding.
*   **Clean round**: A round is clean when no reviewer raises a Blocker or
    Major finding that is not settled. Nits do not block. A reviewer recorded
    as not run makes the round not clean. Decide this from the review results,
    before you apply the fixes of that round.
*   **Converged**: Two consecutive clean rounds. One clean round is not enough,
    because the next fresh reviewer can find a different gap in the same text.
*   **Cap**: 5 rounds.
*   **Churn**: A new finding is at the scope of an applied fix, and reverting
    that fix would resolve it.

On converged, go to Step 3. On cap or churn, write a short list of the open
findings by severity, then ask the user one question: accept and proceed,
continue past the cap, or return the document to drafting.

**Crucial Turn-Taking Requirement**: After the resolution phase finishes for a
given round, the loop driver **MUST respect the turn-taking checkpoint in
`egm-resolve`**. The driver must remain idle across human turns,
only looping back to Step 2.1 when the user explicitly confirms they wish to run
another round of review.

### Step 3: Output Boundary & Final Checkpoint

Upon completion (converged, cap or churn accepted by the user, or manual
halt):

*   **Programmatic Callers**: If running as a subflow of `egm-review`, exit
    cleanly to hand execution back to the parent workflow.
*   **Manual Invocations**: Output a summary of completion in chat: *"The review
    loop has completed after [N] rounds ([converged | accepted at cap | halted]).
Open findings are in the report. Would you like to proceed to
    the next stage, or do you have any final questions?"*
