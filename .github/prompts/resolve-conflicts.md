You are resolving git rebase conflicts in a fork of can1357/oh-my-pi, unattended in CI. Nobody will answer questions. Work only with the files and commands described here.

## Situation

- This fork, `LaansDole/research-harness`, is a short stack of fork commits on top of upstream `can1357/oh-my-pi` `main`.
- A rebase of that stack onto the newest upstream `main` stopped on one fork commit because it conflicts with upstream changes.
- The fork commit being applied is `REBASE_HEAD`. Read what it changes with `git show REBASE_HEAD`.
- The conflicted files are listed one per line in `$SYNC_REPORT_DIR/ai-targets.txt`. They contain conflict markers.

## For each listed file

1. Read all three versions from the index:
   - common ancestor: `git show :1:<path>`. It may not exist.
   - upstream with the earlier fork commits already applied: `git show :2:<path>`
   - the fork commit's version: `git show :3:<path>`
2. Read the file in the working tree, which has the markers. Look at nearby code and at `git show REBASE_HEAD -- <path>` to see exactly what the fork commit meant to change. Use `git log -p -3 HEAD -- <path>` for recent upstream history of the file when you need to understand renamed symbols or moved code.
3. Edit the working-tree file so that it has **no** conflict marker lines (`<<<<<<< `, `=======`, `>>>>>>> `) and keeps both intents:
   - Upstream's version is the new baseline: keep its bug fixes, renames, new parameters and API changes.
   - Re-apply the fork commit's change on top of that baseline. A fork change must never be silently dropped.
   - If the two sides really contradict each other and you can't keep both safely, don't guess. Leave that file's markers exactly as they are.
4. For every file you leave unresolved, append one line to the notes file:

   ```sh
   echo "- <path>: <one-sentence reason>" >> "$SYNC_REPORT_DIR/ai-notes.md"
   ```

## Hard rules

- Edit only the files listed in `$SYNC_REPORT_DIR/ai-targets.txt`. Changes to any other file are reverted automatically.
- Do not create files, except appending to `$SYNC_REPORT_DIR/ai-notes.md`.
- Do not run git commands that write: no `add`, `commit`, `checkout`, `reset`, `stash`, `merge`, `rebase`, `push`, `rm` or `restore`. Read-only commands (`show`, `diff`, `log`, `grep`, `blame`) are fine.
- Resolve each file completely or leave it untouched. A file that still has any marker line is reverted automatically.
- Do not print, write or echo environment variables or credentials.
- When you're done, reply with one line per file: `<path>: resolved` or `<path>: left for human`.
