# wait

> Block until the next background result, peer message, or steering interrupt when there is no other work to do.

## Source
- Entry: `packages/coding-agent/src/tools/wait.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/wait.md`
- Job delivery: `packages/coding-agent/src/async/job-manager.ts`

## Input and availability
`wait` has no arguments. It is an essential, read-approved, interruptible tool available when async jobs, peer messaging, or supervised services are enabled; it does not select a particular peer or job.

## Behavior
- Returns on the first settled caller-owned job or incoming peer message. Job results delivered by this call are consumed so no duplicate async-result follows.
- A pending steering/abort interrupt cuts the wait short. The agent should handle the incoming notice before calling `wait` again.
- A single 30-minute safety cap returns a still-running snapshot; there is no polling ladder or per-call timeout.
- If no owned job, live peer, or owned service can wake it, returns immediately with “Nothing to wait for” and a snapshot.
- Results and peer messages also auto-deliver without calling `wait`. Continue useful work instead of polling.
- Wake progress already resumes an idle agent. Never call `wait` or repeatedly read `proc://` merely to watch it; end the turn and let the pushed progress arrive. Ambient progress waits for an active turn and does not wake an idle agent.

## Related surfaces
- `read proc://` lists caller-visible jobs and project services; `read proc://<id>` inspects state/output without consuming delivery.
- `write proc://<id>/kill` cancels a job or owned subagent, or stops a service; no `content` needed. Bare `proc://<id>` writes send stdin only to a service, including empty input.
- `write agent://<id>` sends a peer message; `agent://all` broadcasts to visible live peers. Bare `read history://` discovers registered agent transcripts. The final result of a subagent is delivered to its parent automatically.
- Start supervised services with `bash` `name`, optional `ready`, and optional `progress: "wake" | "ambient" | "off"`. Readiness belongs to the launch call; `wait` has no service selector or readiness arguments.
- Write `wake`, `ambient`, or `off` to `proc://<name>/progress` to attach, retune, or detach a service monitor. For running jobs with an existing progress channel, `proc://<job-id>/progress` accepts only `wake` or `ambient`; jobs reject `off` and cannot gain a channel after launch.
