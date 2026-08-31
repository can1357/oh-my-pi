import type { CommandMetadata } from "@oh-my-pi/pi-utils/cli";

export const acpHelp = {
	description: "Run Oh My Pi as an ACP (Agent Client Protocol) server over stdio",
} satisfies CommandMetadata;

export const agentsHelp = { description: "Manage bundled task agents" } satisfies CommandMetadata;

export const authBrokerHelp = {
	description: "Manage the omp auth-broker (credential vault)",
} satisfies CommandMetadata;

export const authGatewayHelp = {
	description: "Run an auth-gateway forward proxy backed by the configured broker",
} satisfies CommandMetadata;

export const benchHelp = {
	description:
		"Benchmark models: TTFT/prefill vs decode throughput with p50/p95, across chat, prefill, generation, and prompt-cache workloads",
} satisfies CommandMetadata;

export const browserRelayHelp = {
	description: "Run the local CDP relay that lets the browser tool drive your own Chrome tabs",
} satisfies CommandMetadata;

export const cleanseHelp = {
	description: "Detect and fix project diagnostics with weighted parallel subagents",
} satisfies CommandMetadata;

export const commitHelp = { description: "Generate a commit message and update changelogs" } satisfies CommandMetadata;

export const completionsHelp = {
	description: "Print a shell completion script (bash, zsh, or fish)",
} satisfies CommandMetadata;

export const completeHelp = { hidden: true } satisfies CommandMetadata;

export const compressHelp = {
	description: "Rewrite a text file into the dense prompt register, reporting what it drops",
} satisfies CommandMetadata;

export const configHelp = { description: "Manage configuration settings" } satisfies CommandMetadata;

export const dryBalanceHelp = {
	description: "Dry-run OAuth account balancing across random session ids",
} satisfies CommandMetadata;

export const galleryHelp = {
	description: "Preview tool, composer, and status-line renderers in a deterministic visual gallery",
} satisfies CommandMetadata;

export const gcHelp = { description: "Run storage garbage collection" } satisfies CommandMetadata;
export const ifBenchHelp = {
	description:
		"Benchmark instruction following and working memory: one cached thread of glyph array actions with a moving cat-sound directive",
} satisfies CommandMetadata;
export const gitHelp = {
	description: "Interactive fullscreen git UI: split diff viewer, staging sidebar, and commit composer",
} satisfies CommandMetadata;

export const grepHelp = { description: "Test grep tool" } satisfies CommandMetadata;

export const grievancesHelp = {
	description: "View, clean, or push reported tool issues (auto-QA grievances)",
} satisfies CommandMetadata;

export const imagesHelp = {
	description: "Inspect, diagnose, probe, and purge image publication backends",
} satisfies CommandMetadata;

export const installHelp = {
	description: "Install or link an extension package (alias of `plugin install`/`plugin link`)",
} satisfies CommandMetadata;

export const joinHelp = { description: "Join a shared collab session (same as /join)" } satisfies CommandMetadata;

export const modelsHelp = { description: "List, search, and refresh available models" } satisfies CommandMetadata;

export const pluginHelp = { description: "Manage plugins (install, uninstall, list, etc.)" } satisfies CommandMetadata;

export const psHelp = {
	description: "List and control daemon-supervised background processes (logs, stop, kill, restart)",
} satisfies CommandMetadata;

export const readHelp = {
	description: "Show what the read tool will return for a path, URL, or internal URI",
} satisfies CommandMetadata;
export const renderHelp = {
	description: "Draw a session's entire thread through the production transcript pipeline (with repaint timing)",
} satisfies CommandMetadata;

export const sayHelp = {
	description: "Synthesize text with the local TTS engine and play it through the speakers",
} satisfies CommandMetadata;

export const searchHelp = { description: "Test web search providers" } satisfies CommandMetadata;

export const shareHelp = {
	description: "Share a saved session via an encrypted link (same as /share)",
} satisfies CommandMetadata;

export const setupHelp = {
	description: "Run onboarding setup or install dependencies for optional features",
} satisfies CommandMetadata;

export const shellHelp = { description: "Interactive shell console" } satisfies CommandMetadata;

export const sshHelp = { description: "Manage SSH host configurations" } satisfies CommandMetadata;

export const statsHelp = { description: "View usage statistics" } satisfies CommandMetadata;

export const tinyModelsHelp = {
	description: "Download tiny local models (session titles + memory)",
} satisfies CommandMetadata;

export const tokenHelp = { description: "Get the API key or OAuth token for a provider" } satisfies CommandMetadata;

export const ttsrHelp = {
	description: "Inspect and test Time-Traveling Stream Rules (TTSR)",
} satisfies CommandMetadata;

export const updateHelp = { description: "Check for and install updates" } satisfies CommandMetadata;

export const usageHelp = {
	description: "Show provider usage limits for every authenticated account",
} satisfies CommandMetadata;

export const worktreeHelp = {
	description: "List or clear agent-managed git worktrees (~/.omp/wt)",
} satisfies CommandMetadata;
