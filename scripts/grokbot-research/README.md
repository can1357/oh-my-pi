# Grok Bot research probes (fork-only)

Local spike scripts for sand HTTP 400 / slug sweeps. Not required for production gates.

- Run only with your own `~/.omp/agent/secrets/grokbot.env` (never commit credentials).
- Upstream PRs should not include these files.

Production gate: `../grokbot-automation-tools-probe.mjs` and `../grokbot-matrix.mjs --mode opus-tools`.

Scripts in this directory:

- `grokbot-opus-tools-probe.mjs`
- `grokbot-opus-slug-sweep.mjs`
- `grokbot-opus-f3only-probe.mjs`
- `grokbot-opus-harness-probe.mjs`
- `grokbot-opus-harness-probe2.mjs`
