<system-notice>
Nothing new after {{waited}} of back-to-back waits.
Waiting is not progress: each response MUST advance the task.
Make as much progress as you can on everything that does not need what you are waiting on.
NEVER start `sleep` jobs just to keep calling `wait`: results and messages arrive on their own.
Waiting on something no job of yours reports (a CI run, a deploy, a set time)? Start one async `bash` watcher with `timeout: 0` that exits once it holds (`until <check>; do sleep 60; done`), then {{#if endTurn}}end your turn: its finish starts your next one{{else}}call `wait`: its finish ends the wait{{/if}}. NEVER ask the user to check back later instead.
</system-notice>
