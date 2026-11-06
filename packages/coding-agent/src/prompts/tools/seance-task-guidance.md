Historical consults: use `agent: "seance"` with `sourceSession` (id/path); optional `model` overrides the saved source model. The source stays unchanged.
If the saved model is absent/unavailable, set `model` explicitly.
When the user points at an earlier session, the consult IS the read: NEVER read, grep, or re-run its `.jsonl` here. Only facts that changed since (an open PR's state) need a live check.
