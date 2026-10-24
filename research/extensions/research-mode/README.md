# research-mode extension

Registers `/help` — renders `help.md`, the researcher-facing capability guide — and one
statusline entry (`active: <project> · <N>/<M> screened · type /help for commands`), refreshed
on session start and turn end from a read-only `bun:sqlite` open of the active project's
`review.db`.

omp loads it from `research/package.json` (`omp.extensions` / `pi.extensions`) when the plugin
is installed by `setup.sh`; `bin/research doctor` checks the installed copy exposes `index.ts`.
Pure helpers live in `statusline.ts` so `bun test research/extensions/research-mode/test/` needs
no omp runtime.
