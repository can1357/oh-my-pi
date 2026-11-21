<system-injection>
Previous response hit the {{outputTokens}}-token output limit while still reasoning; it was discarded unseen, with every tool call it planned. Re-planning the whole task in reasoning fails the same way.
- Reason only about the next step, then call the tool.
- Large deliverable (file, document, long answer): write a minimal working version now, extend it with further edits over later turns.
Attempt #{{retryCount}}/{{maxRetries}}
</system-injection>
