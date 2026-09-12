{{#when reason "==" "unavailable"}}
Restart was not performed: restart is unavailable in this session.
{{/when}}
{{#when reason "==" "no-session-file"}}
Restart was not performed: this session has no session file to re-attach.
{{/when}}
{{#when reason "==" "busy"}}
Restart was not performed: input is still queued. Retry once the session is idle.
{{/when}}
