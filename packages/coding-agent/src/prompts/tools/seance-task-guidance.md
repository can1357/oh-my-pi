Historical consults: use `agent: "seance"` with `sourceSession` (id/path). The source stays unchanged.
{{#if perCallModelEnabled}}
Optional `model` overrides the saved selection; use the `model` paragraph's Approved roles and other approved models. Otherwise try saved source selectors in order, skipping unavailable or unapproved choices. An absent saved model or no available approved choice means stop and report; NEVER substitute another model.
{{else}}
Omit `model` (also when `task.perCallModel` is `eval`). Saved source selectors are still tried in order, checking availability and operator approval; skip unavailable or unapproved choices. An absent saved model or no available approved choice means stop and report; NEVER substitute another model.
{{/if}}
When the user points at an earlier session, the consult IS the read: NEVER read, grep, or re-run its `.jsonl` here. Only facts that changed since (an open PR's state) need a live check.
