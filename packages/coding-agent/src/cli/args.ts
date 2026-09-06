/**
 * CLI argument parsing and help display
 */
import * as path from "node:path";
import { $env, APP_NAME, logger } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { ServiceTierOpenAISettingValue } from "../config/service-tier";
import { CLI_THINKING_LEVELS, type ConfiguredThinkingLevel, parseCliThinkingLevel } from "../thinking";
import { normalizeToolNames } from "../tools/builtin-names";
import {
	OPTIONAL_FLAGS,
	OPTIONAL_VALUE_FLAGS,
	type ParseDeps,
	PROFILE_BOOTSTRAP_BOUNDARY_ARG,
	STRING_SETTERS,
	STRING_VALUE_FLAGS,
} from "./flag-tables";
import { getExtraHelpText } from "./help-extra";
import { CliUsageError } from "./usage-error";

export { getExtraHelpText };

export type Mode = "text" | "json" | "rpc" | "acp" | "rpc-ui";

export interface Args {
	cwd?: string;
	/** Workspace directories beyond cwd for this session (repeatable `--add-dir`). */
	addDir?: string[];
	profile?: string;
	alias?: string;
	allowHome?: boolean;
	provider?: string;
	model?: string;
	config?: string[];
	reapplyConfig?: boolean;
	smol?: string;
	slow?: string;
	plan?: string;
	prewalk?: boolean;
	noPrewalk?: boolean;
	prewalkInto?: string;
	planYolo?: boolean;
	planYoloInto?: string;
	maxTime?: number;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	thinking?: ConfiguredThinkingLevel;
	serviceTier?: ServiceTierOpenAISettingValue;
	hideThinking?: boolean;
	advisor?: boolean;
	externalThinking?: boolean;
	continue?: boolean;
	resume?: string | true;
	fromClaude?: boolean;
	fromCodex?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	noSession?: boolean;
	sessionDir?: string;
	providerSessionId?: string;
	providerPromptCacheKey?: string;
	fork?: string;
	/** Collab link to join at startup (set by the `join` subcommand; no CLI flag). */
	join?: string;
	models?: string[];
	tools?: string[];
	noTools?: boolean;
	noLsp?: boolean;
	noPty?: boolean;
	hooks?: string[];
	extensions?: string[];
	trustedExtensions?: string[];
	noExtensions?: boolean;
	pluginDirs?: string[];
	print?: boolean;
	printThoughts?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	noRules?: boolean;
	noTitle?: boolean;
	autoApprove?: boolean;
	approvalMode?: "always-ask" | "write" | "yolo";
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
 * setter table itself can stay free of `@oh-my-pi/pi-utils` runtime imports
 * (which would otherwise trip the profile bootstrap's env-init ordering).
 */
const PARSE_DEPS: ParseDeps = {
	logger,
	parseThinking: parseCliThinkingLevel,
	normalizeToolNames,
	thinkingEfforts: CLI_THINKING_LEVELS,
};

const WINDOWS_PATH_VALUE_FLAGS = new Set(["--extension", "-e", "--hook", "--trusted-extension"]);
const WINDOWS_PATH_START_RE =
	/^(?:[A-Za-z]:[\\/]|\\\\[?]\\(?:[A-Za-z]:[\\/]|UNC[\\/])|\\\\[^\\/]+[\\/][^\\/]+[\\/]|\/\/[?]\/(?:[A-Za-z]:\/|UNC\/)|\/\/[^/]+\/[^/]+\/)/;
const WINDOWS_MODULE_PATH_SUFFIX_RE = /\.(?:[cm]?[jt]sx?)$/i;

function consumeBuiltInStringValue(flag: string, args: string[], valueIndex: number): { value: string; index: number } {
	const value = args[valueIndex];
	if (
		value === undefined ||
		!WINDOWS_PATH_VALUE_FLAGS.has(flag) ||
		!WINDOWS_PATH_START_RE.test(value) ||
		WINDOWS_MODULE_PATH_SUFFIX_RE.test(value)
	) {
		return { value: value ?? "", index: valueIndex };
	}

	let candidate = value;
	for (let index = valueIndex + 1; index < args.length; index++) {
		const next = args[index];
		if (next === PROFILE_BOOTSTRAP_BOUNDARY_ARG || next.startsWith("-")) break;
		candidate += ` ${next}`;
		if (WINDOWS_MODULE_PATH_SUFFIX_RE.test(candidate)) {
			return { value: candidate, index };
		}
	}

	return { value, index: valueIndex };
}

export function parseArgs(inputArgs: string[], extensionFlags?: Map<string, { type: "boolean" | "string" }>): Args {
	// Work on a copy: the `--option=value` handling below splices the value
	// into the array, and callers reuse the same argv (the post-extension
	// reparse in `runRootCommand` parses it a second time). Mutating the input
	// would corrupt that later parse, so never touch the caller's array.
	const args = [...inputArgs];
	const parseDeps = PARSE_DEPS;
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		sessionDir: $env.PI_CODING_AGENT_SESSION_DIR || undefined,
	};

	// `--` ends option parsing (POSIX end-of-options). Everything after it is
	// literal positional text, so flag-shaped messages are not parsed or rejected.
	let sawSeparator = false;
	let trustedFlagCount = 0;
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
			if (arg === "--trusted-extension") trustedFlagCount++;
			// Built-in string flags consume the next token even when it is flag-looking
			// (`--system-prompt --profile foo` ⇒ the prompt is the literal "--profile").
			// The one token they must never absorb is the profile bootstrap's internal
			// boundary sentinel: an extension-shadowable built-in like `--plan` (parsed
			// here only when its boolean extension is NOT loaded) would otherwise swallow
			// the marker as its value and drop the user's trailing message.
			if (i + 1 < args.length && args[i + 1] !== PROFILE_BOOTSTRAP_BOUNDARY_ARG) {
				const consumed = consumeBuiltInStringValue(arg, args, i + 1);
				i = consumed.index;
				STRING_SETTERS[arg](result, consumed.value, parseDeps);
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
		} else if (arg === "--from-claude") {
			result.fromClaude = true;
		} else if (arg === "--from-codex") {
			result.fromCodex = true;
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--no-tools") {
			result.noTools = true;
		} else if (arg === "--no-lsp") {
			result.noLsp = true;
		} else if (arg === "--no-pty") {
			result.noPty = true;
		} else if (arg === "--hide-thinking") {
			result.hideThinking = true;
		} else if (arg === "--advisor") {
			result.advisor = true;
		} else if (arg === "--external-thinking") {
			result.externalThinking = true;
		} else if (arg === "--prewalk") {
			result.prewalk = true;
		} else if (arg === "--no-prewalk") {
			result.noPrewalk = true;
		} else if (arg === "--plan-yolo") {
			result.planYolo = true;
		} else if (arg === "--reapply-config") {
			result.reapplyConfig = true;
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
		} else if (arg === "--print-thoughts") {
			result.printThoughts = true;
		} else if (arg === "--no-extensions") {
			result.noExtensions = true;
		} else if (arg === "--no-skills") {
			result.noSkills = true;
		} else if (arg === "--no-rules") {
			result.noRules = true;
		} else if (arg === "--no-title") {
			result.noTitle = true;
		} else if (arg === "--auto-approve" || arg === "--yolo") {
			result.autoApprove = true;
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

	const swallowedTrustedFlag = [...(result.extensions ?? []), ...(result.hooks ?? [])].some(
		value => value === "--trusted-extension" || value.startsWith("--trusted-extension="),
	);
	if ((result.trustedExtensions?.length ?? 0) !== trustedFlagCount || swallowedTrustedFlag) {
		throw new CliUsageError("--trusted-extension requires a non-empty, non-flag value");
	}
	if (trustedFlagCount > 0 && ((result.extensions?.length ?? 0) > 0 || (result.hooks?.length ?? 0) > 0)) {
		throw new CliUsageError("--trusted-extension cannot be combined with --extension, -e, or --hook");
	}
	for (const trustedPath of result.trustedExtensions ?? []) {
		if (trustedPath.length === 0) {
			throw new CliUsageError("--trusted-extension requires a non-empty, non-flag value");
		}
		if (!path.isAbsolute(trustedPath)) {
			throw new CliUsageError(`--trusted-extension requires an absolute path: ${trustedPath}`);
		}
	}

	return result;
}

/** Reject requested tool names absent from the fully discovered session registry. */
export function validateToolNames(requested: readonly string[] | undefined, known: readonly string[]): void {
	if (!requested) return;
	const knownNames = new Set(known);
	const unknown = requested.filter(name => !knownNames.has(name));
	if (unknown.length === 0) return;
	throw new CliUsageError(
		`Unknown tool${unknown.length === 1 ? "" : "s"} in --tools: ${unknown.join(", ")}. Valid tools: ${known.join(", ")}.`,
	);
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

/** Emit a clean CLI usage error without an internal stack trace. */
export function reportCliUsageError(
	error: unknown,
	write: (text: string) => void = text => process.stderr.write(text),
): boolean {
	if (!(error instanceof CliUsageError)) return false;
	write(`${chalk.red(`Error: ${error.message}`)}\n`);
	write(`Run \`${APP_NAME} --help\` for available flags.\n`);
	return true;
}

export function printHelp(): void {
	process.stdout.write(
		`${chalk.bold(APP_NAME)} - AI coding assistant\n\n` +
			`Run ${APP_NAME} --help for full command and option details.\n` +
			`Run ${APP_NAME} <command> --help for command-specific help.\n\n` +
			`${getExtraHelpText()}\n`,
	);
}
