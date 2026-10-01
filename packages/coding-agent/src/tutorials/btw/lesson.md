---
id: btw
title: Side questions with /btw
minutes: 4
requires: []
steps:
  - id: start
    check:
      - command: /btw
      - turn
    hint: 'Send the JSDoc task first, then type `/btw <question>` while omp is still working. If the turn already ended, give it more work (e.g. `also add an @example to each`) and ask your /btw during that turn.'
    done: 'Your side question was answered from the session context, with no tools, and never entered the main transcript. The task ran on.'
  - id: landed
    check:
      - file: src/strings.ts
        matches: '(?<![\s\S])(?![\s\S]*(?<!\*/[ \t]*)\nexport function)[\s\S]*/\*\*'
      - file: src/dates.ts
        matches: '(?<![\s\S])(?![\s\S]*(?<!\*/[ \t]*)\nexport function)[\s\S]*/\*\*'
      - file: src/numbers.ts
        matches: '(?<![\s\S])(?![\s\S]*(?<!\*/[ \t]*)\nexport function)[\s\S]*/\*\*'
      - file: src/arrays.ts
        matches: '(?<![\s\S])(?![\s\S]*(?<!\*/[ \t]*)\nexport function)[\s\S]*/\*\*'
    hint: 'Every exported function in src/strings.ts, src/dates.ts, src/numbers.ts and src/arrays.ts needs a `/** ... */` block directly above it. Ask omp to finish any it skipped.'
    done: 'All four files are documented: the side question cost the main task nothing.'
  - id: history
    check:
      - command: /btw
    hint: 'Type `/btw` with nothing after it and press Enter.'
    done: 'Side questions are saved with the session; bare /btw brings them back.'
---
This lesson practises asking a quick side question while omp is busy, without interrupting or redirecting the work in progress.

You type real prompts into this session. It runs in a throwaway copy of a small TypeScript library at `{{dir}}`, committed to git so nothing you do here can hurt.
