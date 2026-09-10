# Live provider tool smoke

Runs the source omp CLI with real credentials and real read, write, and bash tools in a fresh temporary directory. Requests may consume provider quota. It keeps the temporary directory and event transcript for inspection.

```sh
bun scripts/provider-tool-smoke.ts cursor/default
bun scripts/provider-tool-smoke.ts cursor/auto
bun scripts/provider-tool-smoke.ts cursor/claude-opus-5-medium medium
bun scripts/provider-tool-smoke.ts grokbot/default
bun scripts/provider-tool-smoke.ts grokbot/auto
bun scripts/provider-tool-smoke.ts grokbot/claude-opus-5 medium
```

The optional third argument selects the evidence directory. Use a distinct directory for each run:

```sh
bun scripts/provider-tool-smoke.ts grokbot/claude-opus-5 medium /tmp/grokbot-opus-smoke
```

A pass requires successful read → write → bash execution in that order, a byte-identical file copy, a clean terminal assistant response, and a fresh random token both in the bash result and at the end of the answer. The token is kept out of the prompt and can only be learned by executing the challenge script. A bash workaround before Write, a provider error with process exit zero, or an answer claiming completion without executing tools fails.

Cursor's internal destination read can report a missing file before a successful Write; that expected probe is retained in the event log. Provider-reported model identifiers are recorded but do not independently attest model weights. Defaults use the effective account catalog and may route to another model. For an explicit effort, the CLI's normal selection and validation path is used.

Exit status is 0 only for `PROVIDER_TOOL_SMOKE_PASS`. Inspect `summary.json`, `events.jsonl`, `stderr.txt`, and the workspace path in the summary on failure. The CLI has a 150-second deadline and the probe kills the child after 175 seconds. Authentication failures are failed rows, never skips.

Offline negative controls:

```sh
bun test scripts/provider-tool-smoke.test.ts
```
