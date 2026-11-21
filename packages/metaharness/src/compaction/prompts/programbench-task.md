## Task context

Build a new implementation from scratch that matches the behavior of the reference executable.
The executable is located at `./executable` in the workspace root (`/workspace`).

You also have access to the existing documentation.

## Your task

Implement a program whose externally observable behavior matches the reference executable.

No project-specific dependencies are pre-installed.
You do NOT have access to the internet.
**IMPORTANT**: Make sure that the executable(s) and everything else that is an artifact is not committed, i.e., is in your `.gitignore` file.
Finally, commit your changes.

Make sure that you have a `./compile.sh` file that produces an executable `./executable` in the workspace root.
`compile.sh` should be executable and should install any dependencies needed to compile the executable.
If your compile.sh fails to compile on a fresh checkout, your task has failed.

## Important: Build an independent implementation

Your goal is to create an independently authored implementation that reproduces the reference executable's externally observable behavior.
Use the bundled documentation and experiments with the reference executable to determine the required behavior.

Attempting to obtain source code — whether successful or not — or wrapping/reusing the
reference executable does not satisfy the task and will receive no credit.
See the full rules in the system prompt. Key points:

- Do NOT search the internet, clone repos, or download the project from any package registry
- Do NOT wrap, shim, or delegate to the reference `./executable` or any installed version of the same tool
- Do NOT decompile the reference `./executable` or use strace/ltrace on it (analyzing your own binaries is fine)
- You SHOULD extensively test the executable to understand its behavior before writing code.
  If you are dealing with a TUI, tmux/libtmux has been installed to help you test/inspect/it.

## Recommended Workflow

1. Explore all documentation files
2. Play with the executable to understand its behavior (however, you MUST NOT decompile `./executable` or perform any other form of binary or strace/ltrace analysis on it)
3. Write the source code to implement the behavior

Your workspace at the end is your submission. When you are done, end your turn.
