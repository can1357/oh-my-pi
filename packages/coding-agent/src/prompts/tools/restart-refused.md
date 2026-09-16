{{#when reason "==" "unavailable"}}
Restart was not performed: restart is unavailable in this session.
{{/when}}
{{#when reason "==" "no-session-file"}}
Restart was not performed: this session has no session file to re-attach.
{{/when}}
{{#when reason "==" "busy"}}
Restart was not performed: this session still has work in flight that a recycle would lose - queued input, a title or auto-learn generation, a job, a compaction, a handoff, a history rewrite, or an unanswered IRC reply. Retry later; do not retry immediately.
{{/when}}
