Historical consults: `agent: "seance"` with `sourceSession` (id/path); the source stays unchanged. `model` overrides the saved source model; set it when that one is absent/unavailable.
When the user points at an earlier session, the consult IS the read: NEVER read, grep, or re-run its `.jsonl` here. Only facts that changed since (an open PR's state) need a live check.
