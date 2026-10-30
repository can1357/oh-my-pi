import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import type { CommandMetadata } from "@oh-my-pi/pi-utils/cli";

export const acpHelp = {
	get description() {
		return __ompTranslate("Run omp as an ACP (Agent Client Protocol) server over stdio");
	},
} satisfies CommandMetadata;

export const agentsHelp = {
	get description() {
		return __ompTranslate("Manage bundled task agents");
	},
} satisfies CommandMetadata;

export const anonymizeHelp = {
	get description() {
		return __ompTranslate(
			"Write a shareable copy of a session and its subagents: turn contents redacted, metadata kept, paths and literals replaced by consistent mock tokens",
		);
	},
} satisfies CommandMetadata;

export const authHelp = {
	get description() {
		return __ompTranslate("Export or import stored provider credentials (API keys and OAuth logins) as JSON");
	},
} satisfies CommandMetadata;

export const authBrokerHelp = {
	get description() {
		return __ompTranslate("Manage the omp auth-broker (credential vault)");
	},
} satisfies CommandMetadata;

export const authGatewayHelp = {
	get description() {
		return __ompTranslate(
			"Run an auth-gateway: an HTTP forward proxy backed by the configured broker, or JSON lines on stdio with your own credentials",
		);
	},
} satisfies CommandMetadata;

export const benchHelp = {
	get description() {
		return __ompTranslate(
			"Benchmark models: TTFT/prefill vs decode throughput with p50/p95, across chat, prefill, generation, and prompt-cache workloads, or single-user vs parallel load (--detailed)",
		);
	},
} satisfies CommandMetadata;

export const browserRelayHelp = {
	get description() {
		return __ompTranslate("Run the local CDP relay that lets the browser prelude drive your own Chrome tabs");
	},
} satisfies CommandMetadata;

export const cleanseHelp = {
	get description() {
		return __ompTranslate("Detect and fix project diagnostics with weighted parallel subagents");
	},
} satisfies CommandMetadata;

export const collabHelp = {
	get description() {
		return __ompTranslate(
			"List active local Collab host metadata without URLs; use collab link <instanceId|pid> to retrieve a control link (--view for view-only)",
		);
	},
} satisfies CommandMetadata;

export const clipHelp = {
	get description() {
		return __ompTranslate("Upload a /record recording to live.omp.sh as a public clip and print its URL");
	},
} satisfies CommandMetadata;

export const commitHelp = {
	get description() {
		return __ompTranslate("Generate a commit message and update changelogs");
	},
} satisfies CommandMetadata;

export const completionsHelp = {
	get description() {
		return __ompTranslate("Print a shell completion script (bash, zsh, or fish)");
	},
} satisfies CommandMetadata;

export const completeHelp = { hidden: true } satisfies CommandMetadata;

export const compressHelp = {
	get description() {
		return __ompTranslate("Rewrite a text file into the dense prompt register, reporting what it drops");
	},
} satisfies CommandMetadata;

export const configHelp = {
	get description() {
		return __ompTranslate("Manage configuration settings");
	},
} satisfies CommandMetadata;

export const dryBalanceHelp = {
	get description() {
		return __ompTranslate("Dry-run OAuth account balancing across random session ids");
	},
} satisfies CommandMetadata;

export const galleryHelp = {
	get description() {
		return __ompTranslate("Preview tool, composer, and status-line renderers in a deterministic visual gallery");
	},
} satisfies CommandMetadata;

export const gcHelp = {
	get description() {
		return __ompTranslate("Run storage garbage collection");
	},
} satisfies CommandMetadata;
export const ifBenchHelp = {
	get description() {
		return __ompTranslate(
			"Benchmark instruction following and working memory: one cached thread of glyph array actions with a moving cat-sound directive",
		);
	},
} satisfies CommandMetadata;
export const gitHelp = {
	get description() {
		return __ompTranslate("Interactive fullscreen git UI: split diff viewer, staging sidebar, and commit composer");
	},
} satisfies CommandMetadata;

export const findHelp = {
	get description() {
		return __ompTranslate("Semantic search: describe a behavior, get the files and line ranges that implement it");
	},
} satisfies CommandMetadata;

export const grepHelp = {
	get description() {
		return __ompTranslate("Test grep tool");
	},
} satisfies CommandMetadata;

export const grievancesHelp = {
	get description() {
		return __ompTranslate("View, clean, or push reported tool issues (auto-QA grievances)");
	},
} satisfies CommandMetadata;

export const loginHelp = {
	get description() {
		return __ompTranslate("Log in to a model provider (terminal counterpart of /login)");
	},
} satisfies CommandMetadata;

export const imagesHelp = {
	get description() {
		return __ompTranslate("Inspect, diagnose, probe, and purge image publication backends");
	},
} satisfies CommandMetadata;

export const installHelp = {
	get description() {
		return __ompTranslate("Install or link an extension package (alias of `plugin install`/`plugin link`)");
	},
} satisfies CommandMetadata;

export const joinHelp = {
	get description() {
		return __ompTranslate("Join a shared collab session (same as /join)");
	},
} satisfies CommandMetadata;

export const modelsHelp = {
	get description() {
		return __ompTranslate("List, search, and refresh available models");
	},
} satisfies CommandMetadata;

export const pluginHelp = {
	get description() {
		return __ompTranslate("Manage plugins (install, uninstall, list, etc.)");
	},
} satisfies CommandMetadata;

export const playHelp = {
	get description() {
		return __ompTranslate("Replay a /record session recording in the terminal (space pauses, q quits)");
	},
} satisfies CommandMetadata;

export const predictHelp = {
	get description() {
		return __ompTranslate("Type a prompt and compare every word-completion engine's ghost text live");
	},
} satisfies CommandMetadata;

export const psHelp = {
	get description() {
		return __ompTranslate("List and control daemon-supervised background processes (logs, stop, kill, restart)");
	},
} satisfies CommandMetadata;

export const readHelp = {
	get description() {
		return __ompTranslate("Show what the read tool will return for a path, URL, or internal URI");
	},
} satisfies CommandMetadata;
export const renderHelp = {
	get description() {
		return __ompTranslate(
			"Draw a session's entire thread through the production transcript pipeline (with repaint timing)",
		);
	},
} satisfies CommandMetadata;

export const sayHelp = {
	get description() {
		return __ompTranslate("Synthesize text with the local TTS engine and play it through the speakers");
	},
} satisfies CommandMetadata;

export const searchHelp = {
	get description() {
		return __ompTranslate("Test web search providers");
	},
} satisfies CommandMetadata;

export const sessionHelp = {
	get description() {
		return __ompTranslate("Hand a session to another machine: pack it, unpack it, or mark the local copy moved");
	},
} satisfies CommandMetadata;

export const shareHelp = {
	get description() {
		return __ompTranslate("Share a saved session via an encrypted link (same as /share)");
	},
} satisfies CommandMetadata;

export const setupHelp = {
	get description() {
		return __ompTranslate("Run onboarding setup or install dependencies for optional features");
	},
} satisfies CommandMetadata;

export const shellHelp = {
	get description() {
		return __ompTranslate("Interactive shell console");
	},
} satisfies CommandMetadata;

export const skillHelp = {
	get description() {
		return __ompTranslate("Install, search, publish, and manage skills on the Skillshare registry (skills.omp.sh)");
	},
} satisfies CommandMetadata;

export const sshHelp = {
	get description() {
		return __ompTranslate("Manage SSH host configurations");
	},
} satisfies CommandMetadata;

export const statsHelp = {
	get description() {
		return __ompTranslate("View usage statistics");
	},
} satisfies CommandMetadata;

export const streamHelp = {
	get description() {
		return __ompTranslate("Broadcast local omp session screens and chat to your public live channel");
	},
} satisfies CommandMetadata;

export const tinyModelsHelp = {
	get description() {
		return __ompTranslate("Download tiny local models (session titles, memory, word completion)");
	},
} satisfies CommandMetadata;

export const tokenHelp = {
	get description() {
		return __ompTranslate("Get the API key or OAuth token for a provider");
	},
} satisfies CommandMetadata;

export const toksHelp = {
	get description() {
		return __ompTranslate("Count a file or text with every embedded offline tokenizer (OpenAI, Claude, Qwen, …)");
	},
} satisfies CommandMetadata;

export const ttsrHelp = {
	get description() {
		return __ompTranslate("Inspect and test Time-Traveling Stream Rules (TTSR)");
	},
} satisfies CommandMetadata;

export const updateHelp = {
	get description() {
		return __ompTranslate("Check for and install updates");
	},
} satisfies CommandMetadata;

export const usageHelp = {
	get description() {
		return __ompTranslate("Show provider usage limits for every authenticated account");
	},
} satisfies CommandMetadata;

export const worktreeHelp = {
	get description() {
		return __ompTranslate("Add, list, or clear git worktrees (clone-first when enabled)");
	},
} satisfies CommandMetadata;
