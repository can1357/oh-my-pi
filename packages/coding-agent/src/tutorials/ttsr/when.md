Write a stream rule for a mistake that keeps coming back and that a regex or ast-grep pattern can spot in the output: a banned API, a deprecated import, a project helper the model keeps bypassing.
These rules add nothing to the prompt until they fire. A large rule set is fine.
Do not use one for style a formatter or linter already enforces. Let the linter handle it.
Do not use one for one-off guidance or general preferences. Put that in the prompt or in AGENTS.md.
Keep conditions narrow. A pattern that also matches prose or harmless code interrupts good output.
Rules live in .omp/rules/*.md (project) or ~/.omp/agent/rules/*.md (user). Run /clear after editing one.
