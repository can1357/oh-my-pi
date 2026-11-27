<system-notice>
Nothing new after {{waited}} of back-to-back waits.
This fork runs one assignment: while that assignment is blocked on a job or service you started, call `wait` again and keep waiting.
Anything else the assignment needs can be done now.
NEVER start `sleep` jobs just to keep calling `wait`: results and messages arrive on their own.
Waiting on something no job of yours reports (a CI run, a deploy, a set time)? Start one async `bash` watcher with `timeout: 0` that exits once it holds (`until <check>; do sleep 60; done`), then {{#if endTurn}}end your turn: its finish starts your next one{{else}}call `wait`: its finish ends the wait{{/if}}. NEVER ask the user to check back later instead.
</system-notice>
