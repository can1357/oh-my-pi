#!/usr/bin/env bash
# One-command setup for research mode: plugin, agents, prompts, config, launcher.
# Idempotent — safe to re-run; re-running refreshes installed files and keeps settings.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OMP_AGENT_DIR="${OMP_AGENT_DIR:-$HOME/.omp/agent}"
RH_HOME="$HOME/.research-harness"
CONFIG="$RH_HOME/config.env"
# Upstream/user agents this script must never overwrite, even if a same-named file appears.
PROTECTED_AGENTS="reviewer.md reviewer-deep.md tldr.md pr.md"

SUMMARY=()
note() { SUMMARY+=("$1"); }

if ! command -v omp >/dev/null 2>&1; then
	echo "setup: omp not found on PATH — install oh-my-pi first (https://github.com/can1357/oh-my-pi)" >&2
	exit 1
fi

# 1. Register the plugin (skills + prompts).
if omp plugin install "$REPO/research" >/dev/null 2>&1; then
	note "plugin   research-harness-tools registered with omp"
else
	omp plugin install --force "$REPO/research" >/dev/null
	note "plugin   research-harness-tools re-registered (--force)"
fi

# 2. Agents.
mkdir -p "$OMP_AGENT_DIR/agents"
agents=()
for f in "$REPO"/research/agents/*.md; do
	base="$(basename "$f")"
	case " $PROTECTED_AGENTS " in
	*" $base "*)
		echo "setup: refusing to overwrite protected agent $base" >&2
		continue
		;;
	esac
	cp "$f" "$OMP_AGENT_DIR/agents/$base"
	agents+=("${base%.md}")
done
note "agents   ${agents[*]} -> $OMP_AGENT_DIR/agents/"

# 3. Prompt templates (the /commands of the research mode).
mkdir -p "$OMP_AGENT_DIR/prompts"
prompts=()
for f in "$REPO"/research/prompts/*.md; do
	base="$(basename "$f")"
	cp "$f" "$OMP_AGENT_DIR/prompts/$base"
	prompts+=("/${base%.md}")
done
note "prompts  ${prompts[*]} -> $OMP_AGENT_DIR/prompts/"

# 4. State home.
mkdir -p "$RH_HOME/projects"
note "state    $RH_HOME (projects/, papers.db)"

# 5. Corpus detection — keep an already-configured value, detect the default,
#    otherwise ask exactly once (interactive shells only).
if [ -f "$CONFIG" ]; then
	# shellcheck disable=SC1090
	. "$CONFIG"
fi
if [ -z "${RESEARCH_CORPUS_DIR:-}" ]; then
	if [ -d "$HOME/Research/Papers" ]; then
		RESEARCH_CORPUS_DIR="$HOME/Research/Papers"
	elif [ -t 0 ]; then
		printf "Local PDF corpus directory (Enter to skip): "
		read -r answer || answer=""
		if [ -n "$answer" ]; then
			RESEARCH_CORPUS_DIR="${answer/#\~/$HOME}"
		fi
	fi
fi
if [ -n "${RESEARCH_CORPUS_DIR:-}" ]; then
	note "corpus   $RESEARCH_CORPUS_DIR ($(find "$RESEARCH_CORPUS_DIR" -maxdepth 1 -name '*.pdf' 2>/dev/null | wc -l | tr -d ' ') PDFs, read-only)"
else
	note "corpus   not set — web-only (set RESEARCH_CORPUS_DIR in $CONFIG later)"
fi

# 6. Persist settings.
PAPER_GRAPH_DB="${PAPER_GRAPH_DB:-$RH_HOME/papers.db}"
{
	echo "# research-harness settings — sourced by bin/research. Edit freely."
	echo "RESEARCH_HARNESS_HOME=\"$REPO\""
	echo "PAPER_GRAPH_DB=\"$PAPER_GRAPH_DB\""
	if [ -n "${RESEARCH_CORPUS_DIR:-}" ]; then
		echo "RESEARCH_CORPUS_DIR=\"$RESEARCH_CORPUS_DIR\""
	fi
} >"$CONFIG"
note "config   $CONFIG"
# Brand name: append-if-absent only. Step 6 rewrites config.env on every run, so
# today this always re-adds the default and a customized name does not survive a rerun.
if [ -f "$CONFIG" ] && ! grep -q '^RESEARCHHARNESS_BRAND_NAME=' "$CONFIG"; then
	printf '\n# Welcome-screen branding (read by bin/research)\nRESEARCHHARNESS_BRAND_NAME="Research Harness"\n' >>"$CONFIG"
	note "brand    Research Harness (RESEARCHHARNESS_BRAND_NAME in config.env)"
fi

# 7. Launcher on PATH.
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO/bin/research" "$HOME/.local/bin/research"
if command -v research >/dev/null 2>&1; then
	note "launcher research -> $REPO/bin/research"
else
	note "launcher $HOME/.local/bin/research (add $HOME/.local/bin to PATH to use plain 'research')"
fi

echo ""
echo "research-harness is wired:"
for line in "${SUMMARY[@]}"; do
	echo "  $line"
done
echo ""
echo "Next: run 'research' to open the TUI in research mode, or 'research doctor' to verify."
