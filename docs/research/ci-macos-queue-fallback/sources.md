# Sources and prior art

Source inspection, not runtime verification. Retrieved 2026-11-16.
OMP2: `1a32fad0dfe602da1db6ee53c24577a7941b8e78`.

## Official contracts

- [Workflow jobs API](https://docs.github.com/en/rest/actions/workflow-jobs):
  get/list/log/rerun; no documented individual-job cancel operation.
- [Run cancellation](https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run)
  and [force cancellation](https://docs.github.com/en/rest/actions/workflow-runs#force-cancel-a-workflow-run)
  are run-wide. A 202 response is acceptance, not terminal settlement.
- [Workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event):
  `ref` is documented as branch/tag. Explicit tested-source identity still needs
  validation and trusted workflow-code selection.
- [Self-hosted routing](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/using-self-hosted-runners-in-a-workflow):
  multiple labels are conjunctions, not alternative runner queues.
- [Job conditions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions):
  skipped required jobs may count as successful; candidate absence is not evidence.

A step inside an unassigned job cannot monitor its own queue. Execution
`timeout-minutes` is not a queue-selection deadline. Polling needs an already
available controller. Official HTML/text snapshots are temporary files under
`/tmp/mac-fallback-docs` and `/tmp/mac-fallback-research`, not committed artifacts.
No cancellation or dispatch was exercised to establish these API behaviors.

## Inspected GitHub implementations

| Pinned source | Actual behavior | Reuse decision |
| --- | --- | --- |
| [mikehardy/runner-fallback-action index.js](https://github.com/mikehardy/runner-fallback-action/blob/dc7732f9e532c451b2527b288ba8d58fd4b0a4ca/index.js) | One GET of self-hosted runner inventory; matching online labels, optional exclusion of busy runners, JSON label output | Not a hosted queue monitor; reversing labels cannot reveal hosted capacity |
| [hutch-fail/github-runner-then-fallback decide.sh](https://github.com/hutch-fail/github-runner-then-fallback/blob/b57e8832ca404d6a931485bb1a300ae2851385ca/scripts/decide.sh) | Billing-usage chooser for GitHub, Blacksmith, Jog; emits labels before work | Name matches direction; wrong trigger. No queue age, cancellation or dispatch |
| [runs-on/action index.template.js](https://github.com/runs-on/action/blob/7b022acfcc7b2128151807204dcf850818864503/index.template.js) | Cache/metrics helper after runner assignment; Linux x64/arm64 and Windows x64 wrappers; unsupported-platform success exit | No Darwin queue fallback or useful scheduling mechanism |

All three pinned checkouts have MIT licenses, inspected in their `LICENSE`
files. No code was copied and no action dependency was added.

Mike Hardy's [action.yml](https://github.com/mikehardy/runner-fallback-action/blob/dc7732f9e532c451b2527b288ba8d58fd4b0a4ca/action.yml)
uses Node20 and bundled JavaScript; `package.json` uses `@actions/core` and
`@actions/http-client`. Its runner-list access exceeds ordinary Actions read
permission. The source reads one page and reserves no runner, so an availability
result races actual scheduling.

Hutch's [action.yml](https://github.com/hutch-fail/github-runner-then-fallback/blob/b57e8832ca404d6a931485bb1a300ae2851385ca/action.yml)
uses Bash, Python3 and curl. Its README requests an organization-billing classic
PAT with `admin:org`, explaining `GITHUB_TOKEN` is insufficient. Optional
Blacksmith support uses a network-fetched shell installer. Neither the extra
credentials nor providers solve this repository's queue-capacity problem.

RunsOn's [action.yml](https://github.com/runs-on/action/blob/7b022acfcc7b2128151807204dcf850818864503/action.yml)
uses Node24 plus platform Go binaries and the RunsOn environment/agent. It is
not a drop-in scheduling solution for the owner's Mac.

Search also found archived `jimmygchen/runner-fallback-action`; its maintained
Mike Hardy successor was inspected instead. No exact reusable solution was
established by this bounded search, which is not proof none exists on GitHub.

## Search procedure and limitations

Native GitHub connector queries: `runner fallback`, `self-hosted runner fallback`,
`github hosted fallback`, `runner queue fallback`, `self hosted runner timeout`,
`runner fallback ChristopherHX`; code queries `cancelWorkflowRun fallback` and
`runner fallback queue timeout`. REST repository searches included
`fallback user:ChristopherHX` and `runner fallback in:name`.

The ChristopherHX user-qualified search returned422 through both connector and
REST. Broad code search had mostly irrelevant results. A `tonychen15/deputy`
hit was inspected and rejected as unrelated task orchestration. Source clones
are temporary under `/tmp/mac-fallback-research`; SHA links above are durable.

No paid runner was dispatched or cancelled for research. No benchmark, real
Mac installation, token creation or check-producer migration was performed.
Earlier monitoring of #658 observed hosted ARM64 capacity annotations; those
time-specific observations do not establish current Mac availability or
diagnose every queued job. The plan remains subject to approval and design.

Read-only API observation: `GET /repos/blyzer/oh-my-pi` reported a public personal
repository with default branch `omp2`. Runner-access controls must therefore be
checked for this account rather than assumed from an enterprise runner-group
example. The inspected ruleset's non-strict status policy is at
`.github/rulesets/omp2-protected.json:35`; the GitHub Actions producer filter and
proof annotation lookup are `.github/workflows/ci.yml:404–409`.
