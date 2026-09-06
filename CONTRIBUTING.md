# Contributing to oh-my-pi

Pull requests are welcome. Keep them focused, understand the work you submit,
and be prepared to explain and maintain it.

> [!NOTE]
> Pull requests are **temporarily open to everyone** as a trial. We previously
> required a vouch before accepting PRs; that requirement is lifted for now
> while we evaluate how open contributions go. Depending on the results, the
> vouch system may return.

## Before you start

### Small changes

Bug fixes, documentation updates, and narrowly scoped improvements can go
straight to a pull request.

### Major changes

Discuss major features and broad architectural or behavioral changes in
[Discord](https://discord.gg/4NMW9cdXZa) **before writing the implementation**.
This includes new subsystems, large UI changes, new dependencies, and changes
that span several packages. A GitHub issue is not a substitute for this
discussion, and prior discussion does not guarantee that a pull request will be
merged.

### Do not open an issue for work you are about to submit

If you intend to implement a change yourself, **do not create an issue for it
first**. robomp treats actionable issues as work to pick up and may start the
same fix in parallel, wasting compute and maintainer time.

Open an issue when you are reporting a problem or proposing work that you are
not already turning into a pull request. If a relevant issue already exists,
link it from your pull request instead of creating another one.

## AI-assisted contributions

AI agents are welcome as tools, not as unattended contributors. Do not give an
agent a vague goal and submit whatever it produces.

Before opening a pull request, you must:

- constrain the agent to the agreed scope and reject unrelated changes;
- review every changed file and understand the resulting behavior;
- run the relevant checks and exercise the changed behavior yourself; and
- submit the pull request only after that review, rather than letting an agent
  publish it autonomously.

You are responsible for the code, regardless of who or what generated it.

## Pull request requirements

Every pull request body **MUST include at least one sentence written by you, in
your own words**, explaining what changed and why. A generated summary, pasted
agent transcript, or checklist alone does not satisfy this requirement.

One honest line is enough:

> I reviewed the full diff; this change fixes duplicate PR reviews by reusing
> the existing delivery guard.

You **MUST verify that the change works as intended**. `bun check` and automated
tests are expected where relevant, but they are not proof that the behavior
works. Exercise the changed path yourself and report the exact scenario and
result in the pull request:

- for a bug fix, reproduce the bug and confirm the same reproduction no longer
  fails;
- for a feature, launch the product and use the feature end to end; and
- for a UI change, interact with it and inspect the rendered result.

“`bun check` passes” by itself is not sufficient verification. For coding-agent
development commands and repository structure, see
[`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md).

Keep each pull request to one logical change. Avoid unrelated cleanup,
drive-by refactors, generated noise, or features that were not part of the
agreed scope.

## Contribution licensing

A contribution intentionally submitted for inclusion in OMP is licensed under
the MIT License.

This policy does not relicense third-party or vendored code. You must have the
right to submit your contribution and must preserve applicable copyright,
license, attribution, and notice material. Submitting a contribution does not
require signing a Contributor License Agreement (CLA) or certifying a
Developer Certificate of Origin (DCO).

## Review

Maintainers review the submitted behavior and the contributor's understanding
of it—not the volume of generated code. Respond to review feedback yourself,
and only apply suggestions you have checked.

Pull requests may be closed when they skip required prior discussion, lack the
human-written explanation, contain unreviewed agent output, or mix unrelated
changes.
