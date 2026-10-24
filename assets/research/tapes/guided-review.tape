# The repo's own testing runbook (docs/RUNBOOK.md), performed live in the omp TUI.
#
# Part 0 runs on camera as shell: `research doctor` and the test suite, the two gates the
# runbook makes you pass before starting a review. Then the session: the researcher says
# what they are reviewing, types /help to see what this workspace can do, imports a real
# 50-record PubMed export, dedupes it, finds the abstracts the export did not carry,
# screens the first ten, confirms the verdicts, and reads the PRISMA numbers off the store.
#
# The capture stops at /prisma on purpose. Runbook Steps 8-9 (`/graph add`, `/export
# included as ris`) need records in the `included` state, which only exists after full-text
# retrieval and a second screening pass; pre-flighted straight after title/abstract they
# report "nothing to file" and "0 included records" and refuse to write. Three dead turns
# is not a demo, and /fulltext is a network cascade too long to sit inside a capture.
#
# Nothing is replayed. Every number on screen is computed during the take: the import
# counts, the dedupe result, the screening verdicts, and the PRISMA arithmetic all come
# out of review.db as it fills up. Every typed line below was pre-flighted headless first
# (omp -p with the same mode prompt) — the Sleep after each one is that measured runtime
# plus roughly a quarter, so a finished turn does not stretch the video.
#
# The Hide block only prepares a sandbox: a scratch dir, a 6-PDF corpus subset copied out
# of the read-only library (pointing the corpus at all 43 fans the scholar agent into
# parallel extraction batches that outlive the capture), an advisor-off overlay, a scratch
# paper-graph db, and a throwaway project slug made active so the take cannot touch a real
# review. The launcher's own flags are used verbatim; `bin/research` is not called because
# it re-sources ~/.research-harness/config.env and would pull the real corpus and the real
# paper graph back in.
#
# Startup is NOT finished when the welcome panel paints — MCP servers are still wiring up,
# and keystrokes sent before that settles are swallowed (measured: 12 s too early, 41 s
# fine). Hence the long settle in the Hide block.
#
# Prereqs (once, from the repo root): ./setup.sh
# Render from the repo root:  vhs assets/research/tapes/guided-review.tape
# vhs Wait+Screen cannot see this TUI once a turn is streaming, so the run cannot be gated
# on output text; the raw capture ends with idle tail. Post-process afterwards: drop
# duplicate frames (mpdecimate), then trim to the last on-screen change + 5 s at 1x.
Output assets/research/guided-review.mp4

Require omp
Set FontSize 18
Set Width 1600
Set Height 1000
Set Theme "Catppuccin Mocha"
Set TypingSpeed 25ms
Set Shell "bash"
Set Framerate 12
Set PlaybackSpeed 1.0
Set WaitTimeout 2m

Hide
Type "rm -rf /tmp/rh-demo-v6-tape && mkdir -p /tmp/rh-demo-v6-tape/corpus && printf 'advisor:\n  enabled: false\n' > /tmp/rh-demo-v6-tape/overlay.yml"
Enter
Sleep 1s
Type "ls $HOME/Research/Papers/*.pdf | head -6 | tr '\n' '\0' | xargs -0 -I{} cp {} /tmp/rh-demo-v6-tape/corpus/; ls /tmp/rh-demo-v6-tape/corpus | wc -l"
Enter
Sleep 2s
Type "rm -rf $HOME/.research-harness/projects/llm-agent-teams-hospital-diagnosis && mkdir -p $HOME/.research-harness/projects/llm-agent-teams-hospital-diagnosis && echo llm-agent-teams-hospital-diagnosis > $HOME/.research-harness/active-project"
Enter
Sleep 1s
Type "export RESEARCH_HARNESS_HOME=$PWD RESEARCH_CORPUS_DIR=/tmp/rh-demo-v6-tape/corpus PAPER_GRAPH_DB=/tmp/rh-demo-v6-tape/papers.db"
Enter
Sleep 1s
Type "clear"
Enter
Sleep 1s
Show

# --- Part 0: the two gates the runbook makes you pass first -------------------
Sleep 2s
Type "bash bin/research doctor"
Sleep 1s
Enter
Sleep 12s

Type "bash research/tests/run.sh"
Sleep 1s
Enter
Sleep 12s

Hide
Type "omp --model sonnet --hide-thinking --auto-approve --append-system-prompt $RESEARCH_HARNESS_HOME/research/mode/system.md --config /tmp/rh-demo-v6-tape/overlay.yml --session-dir /tmp/rh-demo-v6-tape/.sessions --cwd /tmp/rh-demo-v6-tape"
Enter
Wait+Screen@90s /Recent sessions|Tip:/
Sleep 45s
Type "/clear"
Enter
Sleep 3s
Show

# --- Part 1: the worked pass, turn by turn ------------------------------------
# measured 75/79/86/91 s over four headless runs -> 105 s
Sleep 2s
Type "I'm starting a scoping review on whether teams of LLM agents that talk to each other make hospital diagnosis better than a single model. Where do I start?"
Sleep 2s
Enter
Sleep 105s

# renders instantly (handled in-process by the research-mode extension); the sleep is
# reading time for the 13-command table, not waiting time.
Type "/help"
Sleep 2s
Enter
Sleep 22s

# measured 39/40/40/41 s -> 50 s
Type "/import ~/Research/csv-multi-agen-set.csv from pubmed"
Sleep 2s
Enter
Sleep 50s

# measured 13/19/39/47 s -> 58 s
Type "/dedupe"
Sleep 2s
Enter
Sleep 58s

# measured 27/34/47 s -> 58 s. The PubMed CSV carries no abstract column; this is the
# turn where that shows, and it is why the next line exists.
Type "Show me record 1 from the store"
Sleep 2s
Enter
Sleep 58s

# measured 39 s -> 90 s (one sample, so a wide margin). /find is deliberately NOT used:
# it spawns an uncapped scholar subagent that ran 25 min with zero records written.
# Bounding the lookup to five is what keeps it inside a capture.
Type "can you look up the first five on OpenAlex and pull their abstracts in?"
Sleep 2s
Enter
Sleep 90s

# measured 196 s -> 250 s. Typed as a sentence, not /screen: the slash command pulls a
# fixed batch of ten and hands it to the screener subagent, which measured 434-451 s and
# parks the screen on a "waiting on N jobs" spinner for most of it. The plain request is
# the one /help itself advertises, it streams the verdict table as it is written, and it
# reaches the same place in less than half the time.
Type "go through the first five records against my criteria and tell me what you find"
Sleep 2s
Enter
Sleep 250s

# measured 38/81 s -> 100 s. Verdicts are shown before they are written; this is the
# confirmation that persists them.
Type "those look right, keep CARE-AD excluded - save them"
Sleep 2s
Enter
Sleep 100s

# measured 27/38/69 s -> 85 s. Closing frame: the diagram and its arithmetic line, derived.
Type "/prisma"
Sleep 2s
Enter
Sleep 85s
