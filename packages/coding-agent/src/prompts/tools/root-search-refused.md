Refusing to search the filesystem root `{{root}}`. You most likely did not mean this. Never search a full disk: walking every file on the machine can take hours to days.
Search the directory you actually need instead: the workspace (omit `path` or pass `.`), the project root, or a specific subdirectory.
Only when the user explicitly asked for a whole-disk search, run it in bash with the opt-in flag (`find / -allow-root …`, `rg --allow-root …`).
