# S0 source audit and EGM review

Date:2026-11-16. Source `a4b1325ef85a6c6a309015319026b0c673b0ef59`.
Scope: detailed design and read-only preflight, not implementation or activation.

The independent source worker read the merged plan, CI jobs, native actions,
path/policy tests and official dispatch/artifact documentation. It confirmed
that the original named GitHub Actions jobs can remain reporters, and identified
these design obligations: pin controller code independently of source; bootstrap
dispatch on the default branch; preserve the producer/annotation consumer;
update worker-only CI path triggers; keep fork dispatch impossible; verify real
Mac admission, tools and cache ownership. Those requirements are incorporated
in the design and preflight rather than reported as runtime successes.

Dispatch documentation has evolved: the current official workflow REST page
documents API `2026-03-10` returning200 with `workflow_run_id`, `run_url` and
`html_url`. Older indexed documentation describes204 and optional detailed
responses. The proposed client pins the API version, verifies the returned ID
and retains correlation for uncertain responses. No live dispatch was made to
certify that contract here. Cross-run artifact download with explicit run ID
and token is documented by
[actions/download-artifact](https://github.com/actions/download-artifact#download-artifacts-from-other-workflow-runs-or-repositories).

## Fresh-context EGM round

Reviewer `mac_s0_review` used `fork_turns: none`, read the vendored design critic,
feature-spec standard, plan, complete design and preflight, CI workflow and
ruleset, and reported completing those reads. No writes, tests or external
mutations were reported. Tool allowlists and instruction-file exclusion remain
unverified, as disclosed in the original [EGM record](egm-review.md).

| Finding | Severity | Resolution in design |
| --- | --- | --- |
| s0-design-1-1: undefined trusted-event eligibility | Major | Explicit event table, default-off Mac admission, initial owner actor allowlist, parent workflow digest and independent worker checks against GitHub. Broader writer trust remains a prerequisite, not implied acceptance |
| s0-design-1-2: undefined orphan admission expiry | Major |15s polling,90s last-valid-observation expiry, immediate terminal/superseded revocation; TERM10s/KILL5s cleanup contract and live descendant-cleanup canary. No universal process-isolation claim |
| s0-design-1-3: reruns could overlap old workers | Major | Discover prior generations with pagination, cancel and settle active old ownership before replacements; missing history/cleanup confirmation fails closed |

The reviewer findings were accepted as design refinements. Edits were not
independently re-reviewed afterward; no clean-round/convergence credit or
implementation-readiness approval is claimed. Three operational gaps remain:
runner/variable inventory403, no established direct Mac access, and no verified
runner-access boundary or broader-trust acceptance. Live API/runner canaries
necessarily remain follow-up acceptance work after reviewed implementation.

Only documentation changes in this S0 PR. No workflow, dispatcher, token,
runner registration, ruleset, BuildBuddy setting or PR#658 merge was performed.
