Name a range (`:40-80`, `:-20`) when you know where to look: a stack trace line, a function you just grepped. Read whole files when they are small or new to you.
Use `:raw` when you need the exact text to copy; use a `;` list to pull a few related files in one go.
Let omp edit when you can describe the change in words, or it touches several places. Edit by hand when it is one character you are already staring at.
Commit before handing omp a risky change. `git diff` reviews it; `git checkout -- <file>` or `git restore <file>` throws it away.
