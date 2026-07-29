# OMPK review priorities

Especially reject:

- New task paths that bypass AssignmentContract verification.
- Workers that report success without criterion-level evidence.
- Router fallbacks that silently change autonomy or tool ceilings.
- Subagent retries that lose the original contract digest.
- Prompt changes that duplicate instructions already supplied by tool schemas.
- New shared-context behavior that leaks sibling conclusions into blind exploration.
- Spawns that repeat the same `strategyFamily` and blocker fingerprint without a materially different mechanism.
- Root success claims that skip completion-gate criteria or trigger a non-solution rule.

Do not treat task-specific acceptance criteria as permanent watchdog rules — those belong in the active task or assignment contract.
