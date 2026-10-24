# The librarian agent growing the second-brain paper graph, live in the omp TUI.
# Nothing is replayed: the corpus scan, add/link with metadata, OpenAlex auto-edges, the
# connection answer, and the interactive HTML export all execute on camera at real-time
# pacing (the Hide block only sets up a scratch dir, env, and an advisor-off config
# overlay).
#
# The demo corpus is a 6-paper subset copied read-only from ~/Research/Papers into the
# scratch dir; the real library is 43 papers and a full scan does not fit a capture.
#
# The typed lines are deliberately researcher-grade: plain sentences, no flags, no
# command recall - the researcher describes what they have and what they want.
#
# Prereqs (once, from the repo root): ./setup.sh   (plugin + agents + prompts installed)
# Render from the repo root:  vhs assets/research/tapes/paper-graph.tape
# Post-process afterwards: drop duplicate frames (mpdecimate), then trim to the last
# on-screen change + 5 s, keeping 1x pacing.
# (vhs Wait+Screen cannot see this TUI's screen once a turn is streaming, so the run
# cannot be gated on output text - hence the fixed sleeps.)
Output assets/research/paper-graph.mp4

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
Type "rm -rf /tmp/rh-demo-graph && mkdir -p /tmp/rh-demo-graph/corpus && printf 'advisor:\n  enabled: false\n' > /tmp/rh-demo-graph/overlay.yml"
Enter
Type `cp "$HOME/Research/Papers/A_Self-Evolving_Framework_for_Multi-Agent_Medical_Consultation_Based_on_Large_Language_Models.pdf" "$HOME/Research/Papers/MedCoAct_Confidence-Aware_Multi-Agent_Collaboration_for_Complete_Clinical_Decision.pdf" "$HOME/Research/Papers/Enhancing_Medical_Question_Answering_via_a_Multi-Agent_Debate_Framework.pdf" "$HOME/Research/Papers/ClinicalAgent.pdf" "$HOME/Research/Papers/A_Self-Reflective_Multi-Agent_Physician_Recommendation_Framework.pdf" "$HOME/Research/Papers/A_Hierarchical_Multi-Agent_Framework_for_Improved_Clinical_Diagnosis.pdf" /tmp/rh-demo-graph/corpus/`
Enter
Type "export RESEARCH_HARNESS_HOME=$PWD RESEARCH_CORPUS_DIR=/tmp/rh-demo-graph/corpus PAPER_GRAPH_DB=/tmp/rh-demo-graph/papers.db"
Enter
Type "omp --model sonnet --hide-thinking --auto-approve --append-system-prompt $RESEARCH_HARNESS_HOME/research/mode/system.md --config /tmp/rh-demo-graph/overlay.yml --session-dir /tmp/rh-demo-graph/.sessions --cwd /tmp/rh-demo-graph"
Enter
Wait+Screen@90s /Recent sessions|Tip:/
Sleep 5s
Type "/clear"
Enter
Sleep 2s
Show

Sleep 1s
Type "here's my folder of papers on multi-agent medical AI - add the most relevant ones to my paper graph and tell me what connects them"
Sleep 3s
Enter
Sleep 360s

Type "export that view so I can explore it myself"
Sleep 3s
Enter
Sleep 240s
