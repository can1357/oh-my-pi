---
id: basics
title: Reading and editing like omp
minutes: 5
requires: [read, edit, bash]
steps:
  - id: range
    check:
      - tool: read
        match: '"path":"[^"]*:-?\d'
    hint: 'Name the file and the lines, e.g. `show me lines 9-16 of src/cart.ts`. The check wants a read with a line selector such as `:9-16`, `:9+8` or `:9`.'
    done: 'omp read only the lines you asked for: the selector rode along on the path.'
  - id: selectors
    check:
      - tool: read
        match: '"path":"[^"]*(?::raw|;)'
    hint: 'Put the selector in your prompt verbatim: `read src/money.ts:raw`, or list files with `;` like `read src/money.ts;src/inventory.ts`.'
    done: 'You passed a selector straight through your prompt; omp did not have to guess.'
  - id: edit
    check:
      - tool: edit
      - file: src/cart.ts
        matches: '(?<![\s\S])(?![\s\S]*<=\s*lines\.length\s*;)[\s\S]*function cartTotal'
    hint: 'Ask omp to fix the crash, e.g. `fix the crash in cartTotal in src/cart.ts`. The loop in cartTotal must stop before `lines.length`.'
    done: 'omp patched the loop with the edit tool; `bun src/main.ts` now prints a receipt.'
  - id: undo
    check:
      - file: src/cart.ts
        matches: 'i\s*<=\s*lines\.length\s*;'
    hint: 'Ask omp to restore the file from git, e.g. `undo that change with git`. The check looks for the original `i <= lines.length` loop.'
    done: 'The file is back to the committed version. Git undid the edit in one command.'
---
This lesson practises how omp reads and changes code: line selectors, raw reads, a real edit, and git as the undo button.

You type real prompts into this session. It runs in a throwaway copy of a tiny TypeScript project at `{{dir}}`, committed to git so nothing you do here can hurt.
