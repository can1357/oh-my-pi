/**
 * CLI argument parsing and help display
 */
import { THINKING_EFFORTS } from "@pk-nerdsaver-ai/pi-catalog/effort";
import { APP_NAME, CONFIG_DIR_NAME, logger } from "@pk-nerdsaver-ai/pi-utils";
import chalk from "chalk";
import { type ConfiguredThinkingLevel, parseConfiguredThinkingLevel, ThinkingLevel } from "../thinking";
import { BUILTIN_TOOL_NAMES, normalizeToolNames } from "../tools/builtin-names";
import {
	OPTIONAL_FLAGS,
	OPTIONAL_VALUE_FLAGS,
	type ParseDeps,
	PROFILE_BOOTSTRAP_BOUNDARY_ARG,
	STRING_SETTERS,
	STRING_VALUE_FLAGS,
} from "./flag-tables";

export type Mode = "text" | "json" | "rpc" | "acp" | "rpc-ui";

export interface Args {
	cwd?: string;
	profile?: string;
	alias?: string;
	allowHome?: boolean;
	provider?: string;
	model?: string;
	config?: string[];
	smol?: string;
	slow?: string;
	plan?: string;
	maxTime?: number;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	thinking?: ConfiguredThinkingLevel;
	ultra?: boolean;
	hideThinking?: boolean;
	advisor?: boolean;
	continue?: boolean;
	resume?: string | true;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	noSession?: boolean;
	sessionDir?: string;
	providerSessionId?: string;
	fork?: string;
	/** Collab link to join at startup (set by the `join` subcommand; no CLI flag). */
	join?: string;
	/** Open the Agent Hub immediately after startup (set by the `bg` subcommand; no CLI flag). */
	openBackgrounds?: boolean;
	models?: string[];
	tools?: string[];
	noTools?: boolean;
	noIrc?: boolean;
	noLsp?: boolean;
	noPty?: boolean;
	hooks?: string[];
	extensions?: string[];
	noExtensions?: boolean;
	pluginDirs?: string[];
	print?: boolean;
	printThoughts?: boolean;
	export?: string;
	noSkills?: boolean;
	projectSkills?: boolean;
	skills?: string[];
	noRules?: boolean;
	/** Disable AGENTS.md instruction file discovery and loading. */
	noAgentMd?: boolean;
	noTitle?: boolean;
	autoApprove?: boolean;
	approvalMode?: "always-ask" | "write" | "yolo";
	ethereal?: boolean;
	workspaceMode?: "auto" | "copy" | "worktree";
	workspaceRoot?: string;
	preserveWorkspace?: boolean;
	cleanupWorkspace?: boolean;
	copyEnv?: boolean;
	envFiles?: string[];
	secretFiles?: string[];
	secretAllowlist?: string;
	exportPatch?: string;
	workspaceName?: string;
	messages: string[];
	fileArgs: string[];
	/** Extension-registered flags this parse recognized — name to value. */
	unknownFlags: Map<string, boolean | string>;
	/**
	 * `--`/`-` prefixed tokens this parse could not match against any built-in
	 * or {@link extensionFlags} entry. The startup parse runs *before*
	 * extensions load, so it always lists every extension-registered flag here;
	 * the post-extension reparse in {@link applyExtensionFlags} clears those
	 * once the real flag set is known. Anything still present after that
	 * reparse is a genuine typo or stale flag and {@link reportUnrecognizedFlags}
	 * surfaces it as a hard error so the agent does not silently start a
	 * session with the misparsed positionals as a prompt (issue #2459).
	 */
	unrecognizedFlags: string[];
}

/**
 * Runtime dependencies the data-driven setters need. Constructed once at
 * module load and passed to every {@link STRING_SETTERS} call so the
 * setter table itself can stay free of `@pk-nerdsaver-ai/pi-utils` runtime imports
 * (which would otherwise trip the profile bootstrap's env-init ordering).
 */
const PARSE_DEPS: ParseDeps = {
	logger,
	parseConfiguredThinkingLevel,
	builtinToolNames: BUILTIN_TOOL_NAMES,
	normalizeToolNames,
	thinkingEfforts: THINKING_EFFORTS,
};

export function parseArgs(inputArgs: string[], extensionFlags?: Map<string, { type: "boolean" | "string" }>): Args {
	// Work on a copy: the `--option=value` handling below splices the value
	// into the array, and callers reuse the same argv (the post-extension
	// reparse in `runRootCommand` parses it a second time). Mutating the input
	// would corrupt that later parse, so never touch the caller's array.
	const args = [...inputArgs];
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
	};

	// `--` ends option parsing (POSIX end-of-options). Everything after it is
	// literal positional text, so flag-shaped messages are not parsed or rejected.
	let sawSeparator = false;
	for (let i = 0; i < args.length; i++) {
		let arg = args[i];
		if (sawSeparator) {
			result.messages.push(arg);
			continue;
		}
		if (arg === PROFILE_BOOTSTRAP_BOUNDARY_ARG) {
			continue;
		}
		const flagIndex = i;

		// Support --flag=value syntax (e.g. --tools=ask,read). The value is
		// spliced in as the next token so value-consuming flags pick it up via
		// `args[++i]`; a non-consuming flag (e.g. a boolean) leaves it behind and
		// the post-loop guard drops it so it is not mistaken for a message.
		let equalsValueIndex = -1;
		if (arg.startsWith("--") && arg.includes("=")) {
			const eqIdx = arg.indexOf("=");
			const value = arg.slice(eqIdx + 1);
			arg = arg.slice(0, eqIdx);
			args.splice(i + 1, 0, value);
			equalsValueIndex = i + 1;
		}

		// Extension-registered flags take precedence over built-ins: a flag an
		// extension owns (e.g. plan-mode's boolean `--plan`) is parsed with the
		// extension's semantics rather than falling into a built-in branch. For a
		// value-taking built-in (`--plan`, `--model`, …) that branch would consume
		// the following token — eating the user's message and setting the wrong
		// built-in field — so registered flags shadow same-named built-ins here.
		const extFlag = arg.startsWith("--") ? extensionFlags?.get(arg.slice(2)) : undefined;
		if (extFlag) {
			const flagName = arg.slice(2);
			if (extFlag.type === "boolean") {
				result.unknownFlags.set(flagName, true);
			} else if (extFlag.type === "string" && i + 1 < args.length) {
				// Consume the value in `--flag=value` form or when the next token is not
				// flag-looking. A standalone `--` remains the end-of-options marker; use
				// `--flag=--` when an extension needs a literal "--" string value.
				if (equalsValueIndex !== -1 || !args[i + 1].startsWith("-")) {
					result.unknownFlags.set(flagName, args[++i]);
				}
			}
		} else if (STRING_VALUE_FLAGS.has(arg)) {
			// Built-in string flags consume the next token even when it is flag-looking
			// (`--system-prompt --profile foo` ⇒ the prompt is the literal "--profile").
			// The one token they must never absorb is the profile bootstrap's internal
			// boundary sentinel: an extension-shadowable built-in like `--plan` (parsed
			// here only when its boolean extension is NOT loaded) would otherwise swallow
			// the marker as its value and drop the user's trailing message.
			if (i + 1 < args.length && args[i + 1] !== PROFILE_BOOTSTRAP_BOUNDARY_ARG) {
				STRING_SETTERS[arg](result, args[++i], PARSE_DEPS);
			}
		} else if (OPTIONAL_VALUE_FLAGS.has(arg)) {
			const config = OPTIONAL_FLAGS[arg];
			const next = args[i + 1];
			const consume =
				next !== undefined && !next.startsWith("-") && !(config.rejectEmpty === true && next.length === 0);
			config.set(result, consume ? args[++i] : undefined);
		} else if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--allow-home") {
			result.allowHome = true;
		} else if (arg === "--profile" && i + 1 < args.length) {
			// Normally stripped by `extractProfileFlags` before parseArgs sees it;
			// kept here as a fallback for direct parseArgs callers.
			result.profile = args[++i];
		} else if (arg.startsWith("--profile=")) {
			result.profile = arg.slice("--profile=".length);
		} else if (arg === "--alias" && i + 1 < args.length) {
			result.alias = args[++i];
		} else if (arg.startsWith("--alias=")) {
			result.alias = arg.slice("--alias=".length);
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--no-tools") {
			result.noTools = true;
		} else if (arg === "--no-irc") {
			result.noIrc = true;
		} else if (arg === "--no-lsp") {
			result.noLsp = true;
		} else if (arg === "--no-pty") {
			result.noPty = true;
		} else if (arg === "--hide-thinking") {
			result.hideThinking = true;
		} else if (arg === "--ultra") {
			result.ultra = true;
			result.thinking = ThinkingLevel.Ultra;
		} else if (arg === "--advisor") {
			result.advisor = true;
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
		} else if (arg === "--print-thoughts") {
			result.printThoughts = true;
		} else if (arg === "--no-extensions") {
			result.noExtensions = true;
		} else if (arg === "--no-skills" || arg === "--skills-off") {
			result.noSkills = true;
		} else if (arg === "--project-skills") {
			result.projectSkills = true;
		} else if (arg === "--no-rules") {
			result.noRules = true;
		} else if (arg === "--agentmd-off") {
			result.noAgentMd = true;
		} else if (arg === "--no-title") {
			result.noTitle = true;
		} else if (arg === "--auto-approve" || arg === "--yolo") {
			result.autoApprove = true;
		} else if (arg === "--ethereal") {
			result.ethereal = true;
		} else if (arg === "--preserve-workspace") {
			result.preserveWorkspace = true;
		} else if (arg === "--cleanup-workspace") {
			result.cleanupWorkspace = true;
		} else if (arg === "--copy-env") {
			result.copyEnv = true;
		} else if (arg.startsWith("@")) {
			let filePath = arg.slice(1);
			if (filePath.startsWith('"') && filePath.endsWith('"') && filePath.length > 1) {
				filePath = filePath.slice(1, -1);
			} else if (filePath.startsWith("'") && filePath.endsWith("'") && filePath.length > 1) {
				filePath = filePath.slice(1, -1);
			}
			result.fileArgs.push(filePath);
		} else if (!arg.startsWith("-") || arg === "-") {
			// Plain positional or lone `-` (stdin marker) — pass through as a
			// message rather than flagging it.
			result.messages.push(arg);
		} else if (arg === "--") {
			// POSIX positional separator: drop the token and switch the loop
			// into "everything from here is a positional" mode. The guard at
			// the top of the loop body handles the remaining tokens.
			sawSeparator = true;
		} else {
			// Flag-shaped (`-x`, `--name`) but unrecognized at this parse. Record
			// it so the post-extension reparse can decide whether to surface it
			// as a hard error. `--flag=value` already split `value` into the next
			// slot; the standard "drop unconsumed equals value" guard below
			// removes it so it does not leak into messages (issue #2459).
			result.unrecognizedFlags.push(arg);
		}
		// Drop an unconsumed `--flag=value` value (e.g. a boolean flag): when no
		// branch advanced past the spliced token, remove it so it does not fall
		// through to a later iteration and become a positional message.
		if (equalsValueIndex !== -1 && i === flagIndex) {
			args.splice(equalsValueIndex, 1);
		}
	}

	return result;
}

/**
 * Emit a stderr error listing the unrecognized flags and return `true` when
 * there were any. Caller is expected to exit with a non-zero status. Splitting
 * the print from the exit keeps the helper unit-testable without forking a
 * process (issue #2459).
 */
export function reportUnrecognizedFlags(
	args: Pick<Args, "unrecognizedFlags">,
	write: (text: string) => void = text => process.stderr.write(text),
): boolean {
	if (args.unrecognizedFlags.length === 0) return false;
	const flags = args.unrecognizedFlags;
	const plural = flags.length === 1 ? "" : "s";
	write(`${chalk.red(`Error: unknown flag${plural}: ${flags.join(", ")}`)}\n`);
	write(`Run \`${APP_NAME} --help\` for available flags.\n`);
	return true;
}

export function getExtraHelpText(): string {
	return `${chalk.bold("Environment Variables:")}
  ${chalk.dim("# Core Providers")}
  ANTHROPIC_API_KEY          - Anthropic Claude models
  ANTHROPIC_OAUTH_TOKEN      - Anthropic OAuth (takes precedence over API key)
  CLAUDE_CODE_USE_FOUNDRY    - Enable Anthropic Foundry mode (uses Foundry endpoint + mTLS)
  FOUNDRY_BASE_URL           - Anthropic Foundry base URL (e.g., https://<foundry-host>)
  ANTHROPIC_FOUNDRY_API_KEY  - Anthropic token used as Authorization: Bearer <token> in Foundry mode
  ANTHROPIC_CUSTOM_HEADERS   - Extra headers for Foundry or any custom ANTHROPIC_BASE_URL gateway (e.g., "user-id: USERNAME")
  CLAUDE_CODE_CLIENT_CERT    - Client certificate (PEM path or inline PEM) for mTLS
  CLAUDE_CODE_CLIENT_KEY     - Client private key (PEM path or inline PEM) for mTLS
  NODE_EXTRA_CA_CERTS        - CA bundle path (or inline PEM) for server certificate validation
  OPENAI_API_KEY             - OpenAI GPT models
  GEMINI_API_KEY             - Google Gemini models
  COPILOT_GITHUB_TOKEN      - GitHub Copilot

  ${chalk.dim("# Additional LLM Providers")}
  AZURE_OPENAI_API_KEY       - Azure OpenAI models
  GROQ_API_KEY               - Groq models
  CEREBRAS_API_KEY           - Cerebras models
  XAI_API_KEY                - xAI Grok models
  OPENROUTER_API_KEY         - OpenRouter aggregated models
  KILO_API_KEY               - Kilo Gateway models
  CLINE_API_KEY              - Cline and ClinePass models (or /login cline, /login cline-pass)
  MISTRAL_API_KEY            - Mistral models
  ZAI_API_KEY                - z.ai models (ZhipuAI/GLM)
  UMANS_AI_CODING_PLAN_API_KEY - Umans AI Coding Plan models
  UMANS_WEBSEARCH_PROVIDER    - Umans gateway web search backend (native or exa)
  MINIMAX_API_KEY            - MiniMax models
  OPENCODE_API_KEY           - OpenCode Zen/OpenCode Go models
  CURSOR_ACCESS_TOKEN        - Cursor AI models
  AI_GATEWAY_API_KEY         - Vercel AI Gateway
  WAFER_PASS_API_KEY         - Wafer Pass (flat-rate subscription; GLM-5.1, Qwen3.5)
  WAFER_SERVERLESS_API_KEY   - Wafer Serverless (pay-as-you-go)

  ${chalk.dim("# Cloud Providers")}
  AWS_PROFILE                - AWS Bedrock (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)
  GOOGLE_CLOUD_PROJECT       - Google Vertex AI (requires GOOGLE_CLOUD_LOCATION)
  GOOGLE_APPLICATION_CREDENTIALS - Service account for Vertex AI

  ${chalk.dim("# Search & Tools")}
  EXA_API_KEY                - Exa web search
  BRAVE_API_KEY              - Brave web search
  PERPLEXITY_API_KEY         - Perplexity web search API key (optional; anonymous fallback)
  PERPLEXITY_COOKIES         - Perplexity web search (session cookie)
  TAVILY_API_KEY             - Tavily web search
  ANTHROPIC_SEARCH_API_KEY   - Anthropic web search (override; isolates search from main ANTHROPIC_API_KEY)
  ANTHROPIC_SEARCH_BASE_URL  - Anthropic web search base URL (override; pairs with ANTHROPIC_SEARCH_API_KEY)

  ${chalk.dim("# Configuration")}
  OMP_PROFILE                 - Named profile for isolated agent state (same as --profile)
  Use \`${APP_NAME} --profile <name> --alias <command>\` to create a shell shortcut for a profile
  PI_CODING_AGENT_DIR        - Session storage directory (default: ~/${CONFIG_DIR_NAME}/agent)
  PI_PACKAGE_DIR             - Override package directory (for Nix/Guix store paths)
  PI_SMOL_MODEL              - Override smol/fast model (see --smol)
  PI_SLOW_MODEL              - Override slow/reasoning model (see --slow)
  PI_PLAN_MODEL              - Override planning model (see --plan)
  PI_NO_PTY                  - Disable PTY-based interactive bash execution
  For complete environment variable reference, see:
  ${chalk.dim("docs/environment-variables.md")}
${chalk.bold("Available Tools (default-enabled unless noted):")}
  read          - Read file contents
  bash          - Execute bash commands
  edit          - Edit files with find/replace
  write         - Write files (creates/overwrites)
  grep          - Search file contents
  find          - Find files by glob pattern
  lsp           - Language server protocol (code intelligence)
  python        - Execute Python code (requires: ${APP_NAME} setup python)
  notebook      - Edit Jupyter notebooks
  inspect_image - Analyze images with a vision model
  browser       - Browser automation (Puppeteer)
  task          - Launch sub-agents for parallel tasks
  todo          - Manage todo/task lists
  web_search    - Search the web
  ask           - Ask user questions (interactive mode only)

${chalk.bold("Plugin Options:")}
  --plugin-dir <path>        Load plugin from directory (repeatable)

${chalk.bold("Useful Commands:")}
  ${APP_NAME} agents unpack           - Export bundled subagents to ~/.ompk/agent/agents (default)
  ${APP_NAME} agents unpack --project - Export bundled subagents to ./.ompk/agents`;
}

export function printHelp(): void {
	process.stdout.write(
		`${chalk.bold(APP_NAME)} - AI coding assistant\n\n` +
			`Run ${APP_NAME} --help for full command and option details.\n` +
			`Run ${APP_NAME} <command> --help for command-specific help.\n\n` +
			`${getExtraHelpText()}\n`,
	);
}
