Results auto-deliver; NEVER poll.{{#if waitTool}} Completely blocked? Call `wait` to receive the first settled job{{#if ircEnabled}} or peer message{{/if}}.{{/if}}
{{#if ircEnabled}}Coordinate while peers run via `write agent://<id>` (or `agent://all` to broadcast).{{/if}}

`read proc://` lists jobs/services; `read proc://<id>` inspects status/output without consuming delivery. Empty `write proc://<id>` cancels/stops.

Job IDs are process-local; delivered results expire shortly (~30s), unconsumed results within ~5min. Agent output/transcripts remain readable at `agent://<id>` / `history://<id>`.{{#if ircEnabled}} `write agent://<id>` messages a live agent.{{/if}}

`completed`: subagent yielded successfully; claimed artifacts unverified.
