/**
 * Single source of truth for argv flag classification, shared by:
 *   - `parseArgs` in `./args.ts` (the launch-time CLI parser)
 *   - `extractProfileFlags` in `./profile-bootstrap.ts` (the early
 *     `--profile` / `--alias` pre-parser)
 *
 * `parseArgs` dispatches string-valued flags by looking up their setter in
 * {@link STRING_SETTERS}. Optional-value flags use {@link OPTIONAL_FLAGS} so
 * per-flag quirks (currently empty-string rejection for `--resume`) live here
 * instead of being hard-coded in the dispatch loop.
 *
 * The bootstrap doesn't dispatch — it only needs to know which flags consume
 * a value — so it consults {@link STRING_VALUE_FLAGS} and
 * {@link OPTIONAL_VALUE_FLAGS}, both derived from `Object.keys(...)` on the
 * setter/config records below.
 *
 * The deliberate consequence: a string-valued flag exists in this CLI surface
 * iff it has an entry here. Adding a new string-valued flag means adding a
 * setter/config entry in this file; both `args.ts` and the bootstrap pick it
 * up automatically, so the two cannot drift out of sync.
 *
 * IMPORT RULE: this module MUST NOT import any runtime value from
 * `@oh-my-pi/pi-utils` (or anything that transitively does). That package's
 * `env.ts` eagerly loads `.env` files from `getAgentDir()` during module
 * initialization, which would race the profile bootstrap. Type-only imports
 * are erased at runtime and are therefore safe.
 *
 * If a setter needs runtime dependencies (logging, validators, lookup
 * tables), they're passed in through {@link ParseDeps} and `args.ts` wires the
 * real implementations at the dispatch site.
 */

import { isServiceTierOpenAISettingValue, SERVICE_TIER_OPENAI_VALUES } from "../config/service-tier";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { Args } from "./args";
import { CliUsageError } from "./usage-error";

/**
 * Runtime dependencies injected into setters that need to validate input or
 * warn about bad values. `args.ts` constructs one object at module load and
 * passes it to each {@link STRING_SETTERS} call.
 *
 * Keeping these out of the setter closures means this module stays free of
 * runtime imports from `@oh-my-pi/pi-utils`, which is the whole reason it can
 * be safely imported by `profile-bootstrap.ts` before `setProfile` runs.
 */
export interface ParseDeps {
	logger: { warn: (message: string, meta?: Record<string, unknown>) => void };
	parseThinking: (value: string | null | undefined) => ConfiguredThinkingLevel | undefined;
	normalizeToolNames: (values: Iterable<string>) => string[];
	thinkingEfforts: readonly string[];
}

export type StringSetter = (result: Args, value: string, deps: ParseDeps) => void;

/**
 * Setter for a flag that may or may not consume the next argv token.
 * Receives `undefined` for the bare form (`--resume` with no value, etc.).
 */
export type OptionalSetter = (result: Args, value: string | undefined) => void;

/**
 * Per-flag optional-value consumption policy.
 *
 * Every optional flag always rejects tokens that start with `-` — that shared
 * rule lives in the dispatch site. These booleans capture the *additional*
 * per-flag quirks:
 *
 * - `rejectEmpty`: treat `""` like “no value provided”. Needed for
 *   `--resume` / `-r` / `--session`. Without it, an empty string
 *   gets consumed as the session prefix and downstream resolution can match
 *   every session.
 */
export interface OptionalFlagConfig {
	set: OptionalSetter;
	rejectEmpty?: boolean;
}

// Shared setters for flags that alias the same field.
const setExtension: StringSetter = (result, value) => {
	result.extensions = result.extensions ?? [];
	result.extensions.push(value);
};

const setResume: OptionalSetter = (result, value) => {
	result.resume = value !== undefined ? value : true;
};

const MAX_TIME_DURATION_RE = /^(\d+(?:\.\d+)?)([smh])$/;

function maxTimeMultiplier(unit: string | undefined): number {
	if (unit === "h") return 3600;
	if (unit === "m") return 60;
	return 1;
}

function parseMaxTimeSeconds(value: string): number {
	const trimmed = value.trim();
	const duration = MAX_TIME_DURATION_RE.exec(trimmed);
	const seconds = duration ? Number(duration[1]) * maxTimeMultiplier(duration[2]) : Number(trimmed);
	if (Number.isFinite(seconds) && seconds > 0) return seconds;
	throw new CliUsageError(
		`Invalid --max-time value: ${JSON.stringify(value)}. Expected a positive number of seconds or duration like "5s", "10m", "1h".`,
	);
}

/**
 * Setters for flags with string values. Most built-ins consume the next argv
 * token even when it starts with `-`; flags listed in
 * {@link EXTENSION_SHADOWABLE_STRING_FLAGS} use extension-style consumption so
 * a registered boolean extension can shadow them before profile bootstrap.
 */
export const STRING_SETTERS: Record<string, StringSetter> = {
	"--cwd": (result, value) => {
		result.cwd = value;
	},
	"--config": (result, value) => {
		result.config = [...(result.config ?? []), value];
	},
	"--add-dir": (result, value) => {
		result.addDir = [...(result.addDir ?? []), value];
	},
	"--mode": (result, value) => {
		if (value === "text" || value === "json" || value === "rpc" || value === "acp" || value === "rpc-ui") {
			result.mode = value;
		}
	},
	"--fork": (result, value) => {
		result.fork = value;
	},
	"--provider": (result, value) => {
		result.provider = value;
	},
	"--model": (result, value) => {
		result.model = value;
	},
	"--smol": (result, value) => {
		result.smol = value;
	},
	"--slow": (result, value) => {
		result.slow = value;
	},
	"--plan": (result, value) => {
		result.plan = value;
	},
	"--prewalk-into": (result, value) => {
		result.prewalkInto = value;
	},
	"--plan-yolo-into": (result, value) => {
		result.planYoloInto = value;
	},
	"--max-time": (result, value) => {
		result.maxTime = parseMaxTimeSeconds(value);
	},
	"--service-tier": (result, value) => {
		if (!isServiceTierOpenAISettingValue(value)) {
			throw new CliUsageError(
				`Invalid --service-tier value: ${JSON.stringify(value)}. Expected one of: ${SERVICE_TIER_OPENAI_VALUES.join(", ")}.`,
			);
		}
		result.serviceTier = value;
	},
	"--api-key": (result, value) => {
		result.apiKey = value;
	},
	"--system-prompt": (result, value) => {
		result.systemPrompt = value;
	},
	"--append-system-prompt": (result, value) => {
		result.appendSystemPrompt = value;
	},
	"--provider-session-id": (result, value) => {
		result.providerSessionId = value;
	},
	"--prompt-cache-key": (result, value) => {
		result.providerPromptCacheKey = value;
	},
	"--session-dir": (result, value) => {
		result.sessionDir = value;
	},
	"--models": (result, value) => {
		result.models = value.split(",").map(s => s.trim());
	},
	"--tools": (result, value, deps) => {
		const names = deps.normalizeToolNames(
			value
				.split(",")
				.map(s => s.trim())
				.filter(Boolean),
		);
		// Validation runs after session tool discovery. At this point extension,
		// custom, plugin-manifest, and MCP tools are not all known yet.
		result.tools = names;
	},
	"--thinking": (result, value, deps) => {
		const thinking = deps.parseThinking(value);
		if (thinking !== undefined) {
			result.thinking = thinking;
		} else {
			deps.logger.warn("Invalid thinking level passed to --thinking", {
				level: value,
				validThinkingLevels: deps.thinkingEfforts,
			});
		}
	},
	"--export": (result, value) => {
		result.export = value;
	},
	"--hook": (result, value) => {
		result.hooks = result.hooks ?? [];
		result.hooks.push(value);
	},
	"--extension": setExtension,
	"-e": setExtension,
	"--trusted-extension": (result, value) => {
		result.trustedExtensions = result.trustedExtensions ?? [];
		result.trustedExtensions.push(value);
	},
	"--plugin-dir": (result, value) => {
		result.pluginDirs = result.pluginDirs ?? [];
		result.pluginDirs.push(value);
	},
	"--skills": (result, value) => {
		result.skills = value.split(",").map(s => s.trim());
	},
	"--approval-mode": (result, value, deps) => {
		if (value === "always-ask" || value === "write" || value === "yolo") {
			result.approvalMode = value;
		} else {
			deps.logger.warn("Invalid value passed to --approval-mode", {
				value,
				validValues: ["always-ask", "write", "yolo"],
			});
		}
	},
};

/**
 * Optional-value flags. Setters receive `undefined` for the bare form.
 *
 * The dispatch in `args.ts` applies the shared "doesn't start with `-`"
 * check for every flag, then consults the per-flag booleans below for the
 * remaining quirks.
 */
export const OPTIONAL_FLAGS: Record<string, OptionalFlagConfig> = {
	"--resume": { set: setResume, rejectEmpty: true },
	"-r": { set: setResume, rejectEmpty: true },
	"--session": { set: setResume, rejectEmpty: true },
};

/**
 * Derived from {@link STRING_SETTERS}. A flag is in this set if and only if
 * it has a setter — by construction, drift between "the bootstrap thinks
 * this flag accepts a value" and "the launch parser can set one" is
 * structurally impossible.
 */
export const STRING_VALUE_FLAGS: ReadonlySet<string> = new Set(Object.keys(STRING_SETTERS));

/**
 * Built-in string flags known to be shadowed by bundled/common boolean
 * extensions before extension metadata is available. They still accept a
 * value-like successor for the built-in form (`--plan opus`), but a
 * flag-looking successor remains a fresh flag (`--plan --profile work`).
 */
export const EXTENSION_SHADOWABLE_STRING_FLAGS: ReadonlySet<string> = new Set(["--plan"]);

/**
 * Derived from {@link OPTIONAL_FLAGS}. Same single-source contract as
 * {@link STRING_VALUE_FLAGS}.
 */
export const OPTIONAL_VALUE_FLAGS: ReadonlySet<string> = new Set(Object.keys(OPTIONAL_FLAGS));

/**
 * Internal marker inserted by the profile bootstrap when removing `--profile`
 * or `--alias` would otherwise make the following value-like token become the
 * value of a preceding optional/extension flag. `parseArgs` ignores it, but its
 * flag-looking shape preserves argv boundaries during the second parse.
 */
export const PROFILE_BOOTSTRAP_BOUNDARY_ARG = "--omp-profile-boundary";

/**
 * Long-form launch flags that take NO value (booleans). The bootstrap pre-parser
 * needs this to tell a known value-less flag (whose successor is a fresh
 * argument — `omp --print --profile work` still selects a profile) apart from an
 * UNKNOWN long option that might be an extension string flag consuming the next
 * token as its value (so the bootstrap must not steal that token as a global
 * `--profile`/`--alias`). MUST mirror the value-less flag arms of `parseArgs`
 * in `./args.ts`: adding a new boolean launch flag there means adding it here,
 * or `--<newflag> --profile X` stops selecting a profile. Short aliases
 * (`-h`/`-v`/`-c`/`-p`) are intentionally omitted — the protection rule only
 * fires for `--`-prefixed tokens.
 */
export const VALUELESS_FLAGS: ReadonlySet<string> = new Set([
	"--help",
	"--version",
	"--allow-home",
	"--continue",
	"--from-claude",
	"--from-codex",
	"--no-session",
	"--no-tools",
	"--no-lsp",
	"--no-pty",
	"--hide-thinking",
	"--advisor",
	"--external-thinking",
	"--prewalk",
	"--no-prewalk",
	"--plan-yolo",
	"--reapply-config",
	"--print",
	"--print-thoughts",
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--no-title",
	"--auto-approve",
	"--yolo",
]);

/**
 * Whether a bare long option (`--xxx`, no `=`) is unclassified — not a known
 * string-, optional-, or value-less flag. The bootstrap and subcommand
 * resolver treat these as possible extension string flags that may consume a
 * value-like successor (the extension flag table is not yet loaded). Shared so
 * both call sites classify identically.
 */
export function isUnknownLongValueCandidate(arg: string): boolean {
	return (
		arg.startsWith("--") &&
		!arg.includes("=") &&
		!STRING_VALUE_FLAGS.has(arg) &&
		!OPTIONAL_VALUE_FLAGS.has(arg) &&
		!VALUELESS_FLAGS.has(arg)
	);
}

/**
 * Whether a leading option `flag` consumes the following argv token `next` as
 * its value, applying the same contract as `extractProfileFlags` / `parseArgs`.
 * Single source of truth so subcommand detection ({@link resolveCliArgv}) skips
 * a flag's value instead of mistaking it for the subcommand — `omp --model acp`
 * means model `acp`, not the `acp` subcommand, exactly as the launch parser
 * reads it.
 */
export function flagConsumesValue(flag: string, next: string | undefined): boolean {
	// `--flag=value` carries its own value inline.
	if (flag.startsWith("--") && flag.includes("=")) return false;
	if (next === undefined) return false;
	// Known string flags consume any successor, even a flag-looking one
	// (`--system-prompt --foo` ⇒ the system prompt is literally `--foo`).
	if (STRING_VALUE_FLAGS.has(flag)) return true;
	const valueLike = !next.startsWith("-");
	if (EXTENSION_SHADOWABLE_STRING_FLAGS.has(flag)) return valueLike;
	if (OPTIONAL_VALUE_FLAGS.has(flag)) {
		const config = OPTIONAL_FLAGS[flag];
		return valueLike && !(config.rejectEmpty === true && next.length === 0);
	}
	if (isUnknownLongValueCandidate(flag)) return valueLike;
	return false;
}

/**
 * Session-source launch flags dropped when relaunching into an existing
 * session: the restart supplies its own `--resume`, and replaying a stale
 * continue/fork/import selector would re-run its one-shot session choice.
 */
const SESSION_SOURCE_FLAGS: ReadonlySet<string> = new Set([
	"--resume",
	"-r",
	"--session",
	"--continue",
	"-c",
	"--fork",
	"--from-claude",
	"--from-codex",
]);

/**
 * Rewrite the launch argv for an in-place self-restart (`/restart`).
 *
 * Keeps every configuration flag as launched, but drops:
 * - session-source flags ({@link SESSION_SOURCE_FLAGS}, including inline
 *   `--resume=<id>` forms) — the relaunch resumes `resumeSessionId` instead;
 * - positionals (prompt messages, `@file` args, subcommand tokens) — their
 *   effect is already in the resumed transcript, so replaying them would
 *   duplicate the initial prompt.
 *
 * Value consumption mirrors {@link flagConsumesValue}, so a dropped flag takes
 * its value token with it and an unknown extension flag keeps its value.
 * `resumeSessionId` is omitted for a session that never materialized on disk;
 * the relaunch then starts fresh with the same configuration.
 */
export function restartArgv(argv: string[], resumeSessionId: string | undefined): string[] {
	const kept: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") break; // end-of-options: the rest is literal prompt text
		if (!arg.startsWith("-")) continue; // positional: prompt message, @file, or subcommand
		const consumesNext = flagConsumesValue(arg, argv[i + 1]);
		const flag = arg.startsWith("--") ? arg.split("=", 1)[0] : arg;
		if (SESSION_SOURCE_FLAGS.has(flag)) {
			if (consumesNext) i++;
			continue;
		}
		kept.push(arg);
		if (consumesNext) kept.push(argv[++i]);
	}
	if (resumeSessionId !== undefined) kept.push("--resume", resumeSessionId);
	return kept;
}
