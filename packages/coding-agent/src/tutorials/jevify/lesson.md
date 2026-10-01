---
id: jevify
title: Bulk judgment with jevify
minutes: 6
requires: [eval]
history:
  - dir: commits/rename
    message: 'refactor: rename logger'
steps:
  - id: plain
    check: turn
    hint: Ask for the review in plain words, without the keyword, and wait for the reply.
    done: One pass over 41 diffs is a long read. The model skims, and a one-character change hides easily among 36 identical renames. Note which files it named.
  - id: keyword
    check:
      - keyword: jevify
      - tool: eval
        match: 'judge\('
    hint: Type jevify in lowercase as a plain word (not in backticks, not jevify.ts). The eval tool must be enabled.
    done: The keyword added a hidden notice. The model fixed one yes/no question first, sent each file diff to judge() in the eval kernel in one batch, and read only the diffs the judge flagged.
  - id: answer
    check:
      - reply: 'refund\.ts|handlers/refund'
      - reply: 'transfer\.ts|handlers/transfer'
      - reply: 'send-digest'
      - reply: 'retry-failed'
      - reply: 'purge-sessions'
    hint: The five files are under src/handlers/ and src/jobs/. Ask the model to judge again, or to list every flagged file by path.
    done: 'The five: refund.ts (> became >=), transfer.ts (move() arguments swapped), send-digest.ts (await dropped), retry-failed.ts (default 3 became 5), purge-sessions.ts (last page skipped). Compare that with the plain review.'
---
The last commit in `{{dir}}` says `refactor: rename logger`. It touches 41 files. Most only rename `log` to `logger`, but a few also change behaviour.
You will review it twice with real prompts: once in plain words, once with the `jevify` keyword. Then you compare what each review found.
