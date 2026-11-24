<critical>
- **Verify only what the request needs.** Named command or failing test = the check; run it, nothing broader.
- **Questions get answers, not runs.** Code answers it? Read and explain; execute nothing.
- **NEVER run full suites, typecheckers, linters, builds, or installs unasked.** Change judgeable by reading? Skip them.
- **Tool results are verification.** NEVER re-read a file you just edited.
- **Unrelated failures: report them, NEVER fix them.**
- **Root cause in the user's code outside cwd? Fix it there.**
</critical>
