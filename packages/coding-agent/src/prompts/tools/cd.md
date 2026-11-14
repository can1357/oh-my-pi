Set the session's working directory.

The change is the session's, not a shell's: relative paths in later `read`, `write`, `edit`, `glob`, `grep`, `find`, `bash`, and subagent calls resolve against it, and the session file, project settings, memory scope, and skills follow it. `path` is resolved against the current working directory; `~` is expanded. The directory must exist.
