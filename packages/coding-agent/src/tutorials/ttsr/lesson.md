---
id: ttsr
title: Stream rules (TTSR)
minutes: 6
requires: [bash, write]
steps:
  - id: trip
    check:
      - file: src/report.ts
        matches: '^(?![\s\S]*console\.log)[\s\S]*\blog\.(info|warn|error)\('
    hint: Ask for src/report.ts and name console.log in the request. The finished file should call log.info and contain no console.log.
    done: 'The write stopped as soon as console.log streamed, before anything reached disk. omp showed "Injecting rule: no-console-log", dropped the partial output, gave the model the rule, and the model wrote the file again with log.info. Until then the rule cost no context.'
  - id: inspect
    check:
      - tool: bash
        match: 'ttsr\s+(list|scan|test)'
    hint: Ask the model to run omp ttsr list and omp ttsr scan with its bash tool. omp must be on your PATH.
    done: list shows every rule omp registered here and what triggers it. scan runs the rules over existing files and finds the old console.log in src/legacy-export.ts. omp ttsr test checks a snippet against the rules without using a model turn.
  - id: own
    check:
      - file: .omp/rules/use-clock.md
        matches: '(^|\n)(condition|astCondition)\s*:\s*\S'
    hint: The rule needs frontmatter between --- lines with a condition (a regex) plus a scope. Copy the shape of .omp/rules/no-console-log.md.
    done: Each file in .omp/rules/*.md is one rule, named after the file. condition is a regex (or a list of them) that runs on streamed output. scope limits which streams it watches. The body is what the model gets when the rule fires.
  - id: own-trip
    check:
      - command: /clear
      - file: src/token.ts
        matches: '^(?![\s\S]*(Date\.now|new Date))[\s\S]*\bnow\('
    hint: Run /clear first so omp loads the new rule, then ask for src/token.ts. The finished file should import now() from ./clock and contain no Date.now or new Date.
    done: Your rule fired, or the model found src/clock.ts first and never needed it. Either way the file uses now(). Rules are loaded at session start and again on /clear. After you edit a rule, run /clear before testing it.
---
`{{dir}}` contains a project rule, `.omp/rules/no-console-log.md`. Its `condition` is a regex that omp checks against the model's output while it streams.
When the regex matches, omp stops the response, gives the model the rule, and the model tries again.
In this lesson you trigger that rule, inspect it, and then write and trigger a rule of your own.
