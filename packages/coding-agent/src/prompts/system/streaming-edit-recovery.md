<system-injection>
Your last turn stopped during a streamed `edit` call: the harness's final patch preview for the target file reported an error, so the patch was never applied. The turn was cut short on purpose; this continuation replaces it.

Preview error: {{diagnostic}}

Act on the error now instead of re-sending the same payload:
- Read the target file again so line anchors match its current content.
- Then re-issue the edit with corrected anchors, or use `write` when the change is large.

Internal coding-agent auto-recovery after a failed streaming edit preview, not a user instruction.
</system-injection>
