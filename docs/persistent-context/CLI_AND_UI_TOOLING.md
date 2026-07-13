# CLI and UI Tooling

The recommended future CLI surface is:

```text
ompk context status
ompk context enable --scope session
ompk context enable --scope project --project <id>
ompk context enable --scope apps --app chrome --app slack
ompk context pause
ompk context resume
ompk context disable
ompk context inspect --session <id>
ompk context export --project <id>
ompk context delete --session <id>
ompk context delete --project <id>
ompk context delete --all
ompk context policy show
ompk context policy validate
ompk context policy simulate <artifact.json>
ompk context storage status
ompk context storage cleanup --dry-run
ompk context storage cleanup
ompk context reconcile
ompk context audit verify
```

These commands are design targets, not currently registered commands. They must only be added with user-mediated consent controls; an agent tool must never be able to enable persistent context.

The eventual Desktop Tag panel has Off / Session / Project / Selected Apps / Device scope, local-only versus encrypted remote sync, active app scope, pressure state, storage meter, pause, review timeline, deletion, policy, and export controls.

The unified management UI should show enabled devices, consent scope, active capture sessions, storage categories, remote-sync state, policy version, deletion jobs, quarantine count, and audit integrity state.
