import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { Args, type CommandMetadata, Flags } from "@oh-my-pi/pi-utils/cli";
import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";
import { formatKeyHint } from "@oh-my-pi/pi-tui/key-hint-format";
import { CLI_THINKING_LEVELS } from "@oh-my-pi/pi-tui/thinking";
import { SERVICE_TIER_OPENAI_VALUES } from "../config/service-tier";

export const launchHelp = {
	description: __ompTranslate("AI coding assistant"),
	hidden: true,
	args: {
		messages: Args.string({
			description: __ompTranslate("Messages to send (prefix files with @)"),
			required: false,
			multiple: true,
		}),
	},
	flags: {
		model: Flags.string({
			description: 'Model to use (fuzzy match: "opus", "gpt-5.2"; exact with a provider: "openai/gpt-5.2")',
		}),
		smol: Flags.string({
			description: __ompTranslate("Smol/fast model for lightweight tasks (or PI_SMOL_MODEL env)"),
		}),
		slow: Flags.string({
			description: __ompTranslate("Slow/reasoning model for thorough analysis (or PI_SLOW_MODEL env)"),
		}),
		plan: Flags.string({
			description: __ompTranslate("Plan model for architectural planning (or PI_PLAN_MODEL env)"),
		}),
		goal: Flags.string({
			description: __ompTranslate(
				"Start fresh in goal mode (interactive only; bypasses autoResume; no positional prompt, startup plan mode, or explicit resume)",
			),
		}),
		prewalk: Flags.boolean({
			description: __ompTranslate(
				"Switch from the active model to a fast/cheap model at the first edit/write after the plan's todo list exists (default off; see prewalk.enabled)",
			),
		}),
		"no-prewalk": Flags.boolean({
			description: __ompTranslate("Disable prewalk, including prewalk.auto, even if prewalk.enabled is set"),
		}),
		"prewalk-into": Flags.string({
			description: __ompTranslate('Target model for prewalk (default the "smol" role)'),
		}),
		"plan-yolo": Flags.boolean({
			description: __ompTranslate(
				"Force read-only plan mode at start, auto-approve the plan on the model's first resolve call, then switch to --plan-yolo-into to implement it",
			),
		}),
		"plan-yolo-into": Flags.string({
			description: __ompTranslate('Target model for plan-yolo execution (default the "smol" role)'),
		}),
		provider: Flags.string({ description: __ompTranslate("Provider to use (legacy; prefer --model)") }),
		"api-key": Flags.string({ description: __ompTranslate("API key (defaults to env vars)") }),
		"system-prompt": Flags.string({
			description: __ompTranslate("System prompt (default: coding assistant prompt)"),
		}),
		"system-prompt-template": Flags.string({
			description: __ompTranslate("Handlebars system prompt template (mutually exclusive with --system-prompt)"),
		}),
		"append-system-prompt": Flags.string({
			description: __ompTranslate("Append text or file contents to the system prompt"),
		}),
		"allow-home": Flags.boolean({
			description: __ompTranslate("Allow starting in ~ without auto-switching to a temp dir"),
		}),
		profile: Flags.string({
			description: __ompTranslate("Use an isolated profile for auth, sessions, settings, and caches"),
		}),
		alias: Flags.string({ description: __ompTranslate("Create a shell shortcut for the selected profile and exit") }),
		cwd: Flags.string({ description: __ompTranslate("Directory to start in (overrides the launch cwd)") }),
		mode: Flags.string({
			description: __ompTranslate("Output mode: text (default), json, rpc, or rpc-ui"),
			options: ["text", "json", "rpc", "acp", "rpc-ui"],
		}),
		config: Flags.string({
			description: __ompTranslate("Load an extra config.yml-style overlay for this run (repeatable)"),
			multiple: true,
		}),
		"add-dir": Flags.string({
			description: __ompTranslate("Add a workspace directory beyond the working directory (repeatable)"),
			multiple: true,
		}),
		print: Flags.boolean({ char: "p", description: __ompTranslate("Non-interactive mode: process prompt and exit") }),
		continue: Flags.boolean({ char: "c", description: __ompTranslate("Continue previous session") }),
		resume: Flags.string({
			char: "r",
			description: __ompTranslate("Resume a session (by ID prefix, path, or picker if omitted)"),
		}),
		restore: Flags.string({
			description: __ompTranslate(
				"Resume a session as --resume does, then go on with what its last process left unfinished (the interrupted turn and the subagents it was running)",
			),
		}),
		"from-claude": Flags.boolean({ description: __ompTranslate("Import a Claude Code session into OMP") }),
		"from-codex": Flags.boolean({ description: __ompTranslate("Import a Codex session into OMP") }),
		"session-dir": Flags.string({ description: __ompTranslate("Directory for session storage and lookup") }),
		"no-session": Flags.boolean({ description: __ompTranslate("Don't save session (ephemeral)") }),
		models: Flags.string({
			description: __ompTranslate("Comma-separated model patterns for {0} cycling", `${formatKeyHint("ctrl+p")}`),
		}),
		"no-tools": Flags.boolean({ description: __ompTranslate("Disable all built-in tools") }),
		"no-lsp": Flags.boolean({ description: __ompTranslate("Disable LSP tools, formatting, and diagnostics") }),
		"no-pty": Flags.boolean({ description: __ompTranslate("Disable PTY-based interactive bash execution") }),
		tools: Flags.string({ description: __ompTranslate("Comma-separated list of tools to enable (default: all)") }),
		thinking: Flags.string({
			description: __ompTranslate("Set thinking level: {0}", `${CLI_THINKING_LEVELS.join(", ")}`),
			options: [...CLI_THINKING_LEVELS],
		}),
		"service-tier": Flags.string({
			description: __ompTranslate("OpenAI service tier for this session (none omits service_tier)"),
			options: [...SERVICE_TIER_OPENAI_VALUES],
		}),
		"hide-thinking": Flags.boolean({
			description: __ompTranslate(
				"Hide thinking blocks in TUI output (display only, does not disable model thinking)",
			),
		}),
		advisor: Flags.boolean({
			description: __ompTranslate("Enable the advisor runtime (passively reviews each turn and injects notes)"),
		}),
		"wait-async": Flags.boolean({
			description: __ompTranslate(
				"Print mode: before exiting, wait for this run's background jobs and wake the session with each result (async.printWake); no time limit unless --max-time is set",
			),
		}),
		"external-thinking": Flags.boolean({
			description: __ompTranslate(
				"Use a private scratchpad while disabling supported GPT, Claude, and Gemini reasoning (at your own risk: providers have flagged this request shape as abuse)",
			),
		}),
		hook: Flags.string({
			description: __ompTranslate("Load a hook/extension file (can be used multiple times)"),
			multiple: true,
		}),
		extension: Flags.string({
			char: "e",
			description: __ompTranslate("Load an extension file (can be used multiple times)"),
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: __ompTranslate("Disable extension discovery (explicit -e paths still work)"),
		}),
		"no-skills": Flags.boolean({ description: __ompTranslate("Disable skills discovery and loading") }),
		skills: Flags.string({
			description: __ompTranslate("Comma-separated glob patterns to filter skills (e.g., git-*,docker)"),
		}),
		"no-rules": Flags.boolean({ description: __ompTranslate("Disable rules discovery and loading") }),
		"no-context-files": Flags.boolean({
			description: __ompTranslate("Disable context files (AGENTS.md, CLAUDE.md, ...)"),
		}),
		export: Flags.string({ description: __ompTranslate("Export session file to HTML and exit") }),
		"no-title": Flags.boolean({ description: __ompTranslate("Disable title auto-generation") }),
		"no-ui": Flags.boolean({
			description: __ompTranslate(
				"With --mode rpc or rpc-ui: run extensions headless (rpc-ui tool UI remains enabled)",
			),
		}),
		"print-thoughts": Flags.boolean({
			description: __ompTranslate("Include thinking blocks in print mode text output"),
		}),
		"max-time": Flags.string({
			description: __ompTranslate("Stop the session after this duration (e.g., 600, 10m, 1h)"),
		}),
		"warn-cost": Flags.string({
			description: __ompTranslate("Warn once when the session's spend, subagents included, reaches this many USD"),
		}),
		"max-cost": Flags.string({
			description: __ompTranslate(
				"Stop sending model requests once the session's spend reaches this many USD; requests already in flight can finish past it (print mode exits 3)",
			),
		}),
		"auto-approve": Flags.boolean({
			aliases: ["yolo"],
			description: __ompTranslate("Auto-approve all tool calls (skip approval prompts)"),
		}),
		"approval-mode": Flags.string({
			options: ["always-ask", "always-ask-cached", "write", "yolo"],
			description: __ompTranslate(
				"Override tools.approvalMode for this session (always-ask|always-ask-cached|write|yolo)",
			),
		}),
	},
	examples: [
		__ompTranslate("# Interactive mode\n  {0}", `${APP_NAME}`),
		__ompTranslate('# Interactive mode with initial prompt\n  {0} "List all .ts files in src/"', `${APP_NAME}`),
		__ompTranslate('# Start working on a goal immediately\n  {0} --goal "Investigate the importer"', `${APP_NAME}`),
		__ompTranslate(
			'# Include files in initial message\n  {0} @prompt.md @image.png "What color is the sky?"',
			`${APP_NAME}`,
		),
		__ompTranslate('# Non-interactive mode (process and exit)\n  {0} -p "List all .ts files in src/"', `${APP_NAME}`),
		__ompTranslate('# Continue previous session\n  {0} --continue "What did we discuss?"', `${APP_NAME}`),
		__ompTranslate(
			"# Pick a session back up after a crash, subagents included\n  {0} --restore ~/.omp/agent/sessions/--path--/session.jsonl",
			`${APP_NAME}`,
		),
		__ompTranslate(
			"# Create a shell shortcut for a work profile\n  {0} --profile work --alias omp-work",
			`${APP_NAME}`,
		),
		__ompTranslate(
			'# Use different model (fuzzy matching)\n  {0} --model opus "Help me refactor this code"',
			`${APP_NAME}`,
		),
		__ompTranslate(
			"# Limit model cycling to specific models\n  {0} --models claude-sonnet,claude-haiku,gpt-4o",
			`${APP_NAME}`,
		),
		__ompTranslate(
			"# Export a session file to HTML\n  {0} --export ~/.omp/agent/sessions/--path--/session.jsonl",
			`${APP_NAME}`,
		),
	],
} satisfies CommandMetadata;
