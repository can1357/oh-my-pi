import { Args, type CommandMetadata, Flags } from "@oh-my-pi/pi-utils/cli";
import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";
import { CLI_THINKING_LEVELS } from "../cli/thinking-levels";
import { SERVICE_TIER_OPENAI_VALUES } from "../config/service-tier";

export const launchHelp = {
	description: "AI coding assistant",
	hidden: true,
	args: {
		messages: Args.string({
			description: "Messages to send (prefix files with @)",
			required: false,
			multiple: true,
		}),
	},
	flags: {
		model: Flags.string({
			description: 'Model to use (fuzzy match: "opus", "gpt-5.2", or "openai/gpt-5.2")',
		}),
		smol: Flags.string({ description: "Smol/fast model for lightweight tasks (or PI_SMOL_MODEL env)" }),
		slow: Flags.string({ description: "Slow/reasoning model for thorough analysis (or PI_SLOW_MODEL env)" }),
		plan: Flags.string({ description: "Plan model for architectural planning (or PI_PLAN_MODEL env)" }),
		prewalk: Flags.boolean({
			description:
				"Switch from the active model to a fast/cheap model at the first edit/write after the plan's todo list exists (default off; see prewalk.enabled)",
		}),
		"no-prewalk": Flags.boolean({ description: "Disable prewalk even if prewalk.enabled is set" }),
		"prewalk-into": Flags.string({ description: 'Target model for prewalk (default the "smol" role)' }),
		"plan-yolo": Flags.boolean({
			description:
				"Force read-only plan mode at start, auto-approve the plan on the model's first resolve call, then switch to --plan-yolo-into to implement it",
		}),
		"plan-yolo-into": Flags.string({ description: 'Target model for plan-yolo execution (default the "smol" role)' }),
		provider: Flags.string({ description: "Provider to use (legacy; prefer --model)" }),
		"api-key": Flags.string({ description: "API key (defaults to env vars)" }),
		"system-prompt": Flags.string({ description: "System prompt (default: coding assistant prompt)" }),
		"append-system-prompt": Flags.string({ description: "Append text or file contents to the system prompt" }),
		"allow-home": Flags.boolean({ description: "Allow starting in ~ without auto-switching to a temp dir" }),
		profile: Flags.string({ description: "Use an isolated profile for auth, sessions, settings, and caches" }),
		alias: Flags.string({ description: "Create a shell shortcut for the selected profile and exit" }),
		cwd: Flags.string({ description: "Directory to start in (overrides the launch cwd)" }),
		mode: Flags.string({
			description: "Output mode: text (default), json, rpc, or rpc-ui",
			options: ["text", "json", "rpc", "acp", "rpc-ui"],
		}),
		config: Flags.string({
			description: "Load an extra config.yml-style overlay for this run (repeatable)",
			multiple: true,
		}),
		"reapply-config": Flags.boolean({
			description:
				"On resume, use the config-resolved default model, thinking level, and service tier instead of restoring the session's own — applied per knob (and per family for the service tier), so anything the config does not specify keeps the session's; lets a --config/--profile overlay re-apply on resume (default off)",
		}),
		"add-dir": Flags.string({
			description: "Add a workspace directory beyond the working directory (repeatable)",
			multiple: true,
		}),
		print: Flags.boolean({ char: "p", description: "Non-interactive mode: process prompt and exit" }),
		continue: Flags.boolean({ char: "c", description: "Continue previous session" }),
		resume: Flags.string({ char: "r", description: "Resume a session (by ID prefix, path, or picker if omitted)" }),
		"from-claude": Flags.boolean({ description: "Import a Claude Code session into OMP" }),
		"from-codex": Flags.boolean({ description: "Import a Codex session into OMP" }),
		"session-dir": Flags.string({ description: "Directory for session storage and lookup" }),
		"no-session": Flags.boolean({ description: "Don't save session (ephemeral)" }),
		models: Flags.string({ description: "Comma-separated model patterns for Ctrl+P cycling" }),
		"no-tools": Flags.boolean({ description: "Disable all built-in tools" }),
		"no-lsp": Flags.boolean({ description: "Disable LSP tools, formatting, and diagnostics" }),
		"no-pty": Flags.boolean({ description: "Disable PTY-based interactive bash execution" }),
		tools: Flags.string({ description: "Comma-separated list of tools to enable (default: all)" }),
		thinking: Flags.string({
			description: `Set thinking level: ${CLI_THINKING_LEVELS.join(", ")}`,
			options: [...CLI_THINKING_LEVELS],
		}),
		"service-tier": Flags.string({
			description: "OpenAI service tier for this session (none omits service_tier)",
			options: [...SERVICE_TIER_OPENAI_VALUES],
		}),
		"hide-thinking": Flags.boolean({
			description: "Hide thinking blocks in TUI output (display only, does not disable model thinking)",
		}),
		advisor: Flags.boolean({
			description: "Enable the advisor runtime (passively reviews each turn and injects notes)",
		}),
		"external-thinking": Flags.boolean({
			description:
				"Use a private scratchpad while disabling supported GPT, Claude, and Gemini reasoning (at your own risk: providers have flagged this request shape as abuse)",
		}),
		hook: Flags.string({ description: "Load a hook/extension file (can be used multiple times)", multiple: true }),
		extension: Flags.string({
			char: "e",
			description: "Load an extension file (can be used multiple times)",
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: "Disable extension discovery (explicit -e paths still work)",
		}),
		"no-skills": Flags.boolean({ description: "Disable skills discovery and loading" }),
		skills: Flags.string({ description: "Comma-separated glob patterns to filter skills (e.g., git-*,docker)" }),
		"no-rules": Flags.boolean({ description: "Disable rules discovery and loading" }),
		export: Flags.string({ description: "Export session file to HTML and exit" }),
		"no-title": Flags.boolean({ description: "Disable title auto-generation" }),
		"print-thoughts": Flags.boolean({ description: "Include thinking blocks in print mode text output" }),
		"max-time": Flags.string({ description: "Stop the session after this duration (e.g., 600, 10m, 1h)" }),
		"auto-approve": Flags.boolean({
			aliases: ["yolo"],
			description: "Auto-approve all tool calls (skip approval prompts)",
		}),
		"approval-mode": Flags.string({
			options: ["always-ask", "write", "yolo"],
			description: "Override tools.approvalMode for this session (always-ask|write|yolo)",
		}),
	},
	examples: [
		`# Interactive mode\n  ${APP_NAME}`,
		`# Interactive mode with initial prompt\n  ${APP_NAME} "List all .ts files in src/"`,
		`# Include files in initial message\n  ${APP_NAME} @prompt.md @image.png "What color is the sky?"`,
		`# Non-interactive mode (process and exit)\n  ${APP_NAME} -p "List all .ts files in src/"`,
		`# Continue previous session\n  ${APP_NAME} --continue "What did we discuss?"`,
		`# Create a shell shortcut for a work profile\n  ${APP_NAME} --profile work --alias omp-work`,
		`# Use different model (fuzzy matching)\n  ${APP_NAME} --model opus "Help me refactor this code"`,
		`# Limit model cycling to specific models\n  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o`,
		`# Export a session file to HTML\n  ${APP_NAME} --export ~/.omp/agent/sessions/--path--/session.jsonl`,
	],
} satisfies CommandMetadata;
