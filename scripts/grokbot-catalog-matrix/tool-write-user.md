{{!-- Write smoke uses Shell redirect, not Write. Live keep-model: medium/medium-fast passed bash+Read then policy-blocked on Write. isWriteLikeCall already accepts printf/echo > path. --}}
Please use the Shell tool to run: printf '%s\n' {{ping}} > notes/{{safeId}}.txt

