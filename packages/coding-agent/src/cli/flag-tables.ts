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
 * `@pk-nerdsaver-ai/pi-utils` (or anything that transitively does). That package's
 * `env.ts` eagerly loads `.env` files from `getAgentDir()` during module
 * initialization, which would race the profile bootstrap. Type-only imports
 * are erased at runtime and are therefore safe.
 *
 * If a setter needs runtime dependencies (logging, validators, lookup
 * tables), they're passed in through {@link ParseDeps} and `args.ts` wires the
 * real implementations at the dispatch site.
 */

import type { ConfiguredThinkingLevel } from "../thinking";
import type { Args } from "./args";

/**
 * Runtime dependencies injected into setters that need to validate input or
 * warn about bad values. `args.ts` constructs one object at module load and
 * passes it to each {@link STRING_SETTERS} call.
 *
 * Keeping these out of the setter closures means this module stays free of
 * runtime imports from `@pk-nerdsaver-ai/pi-utils`, which is the whole reason it can
 * be safely imported by `profile-bootstrap.ts` before `setProfile` runs.
 */
export interface ParseDeps {
	logger: { warn: (message: string, meta?: Record<string, unknown>) => void };
	parseConfiguredThinkingLevel: (value: string | null | undefined) => ConfiguredThinkingLevel | undefined;
	builtinToolNames: readonly string[];
	normalizeToolNames: (names: Iterable<string>) => string[];
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
	"--max-time": (result, value, deps) => {
		const seconds = Number(value);
		if (Number.isFinite(seconds) && seconds > 0) {
			result.maxTime = seconds;
		} else {
			deps.logger.warn("Invalid seconds passed to --max-time", { value });
		}
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
	"--session-dir": (result, value) => {
		result.sessionDir = value;
	},
	"--workspace-mode": (result, value, deps) => {
		if (value === "auto" || value === "copy" || value === "worktree") {
			result.workspaceMode = value;
		} else {
			deps.logger.warn("Invalid value passed to --workspace-mode", {
				value,
				validValues: ["auto", "copy", "worktree"],
			});
		}
	},
	"--workspace-root": (result, value) => {
		result.workspaceRoot = value;
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
		const valid: string[] = [];
		for (const name of names) {
			if (deps.builtinToolNames.includes(name)) {
				valid.push(name);
			} else {
				deps.logger.warn("Unknown tool passed to --tools", {
					tool: name,
					validTools: deps.builtinToolNames,
				});
			}
		}
		result.tools = valid;
	},
	"--thinking": (result, value, deps) => {
		const thinking = deps.parseConfiguredThinkingLevel(value);
		// `inherit` is the internal scoped-model sentinel, not a CLI-facing level.
		if (thinking !== undefined && thinking !== "inherit") {
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
	"--env-file": (result, value) => {
		result.envFiles = [...(result.envFiles ?? []), value];
	},
	"--copy-secret": (result, value) => {
		result.secretFiles = [...(result.secretFiles ?? []), value];
	},
	"--secret-allowlist": (result, value) => {
		result.secretAllowlist = value;
	},
	"--export-patch": (result, value) => {
		result.exportPatch = value;
	},
	"--workspace-name": (result, value) => {
		result.workspaceName = value;
	},
	"--hook": (result, value) => {
		result.hooks = result.hooks ?? [];
		result.hooks.push(value);
	},
	"--extension": setExtension,
	"-e": setExtension,
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
	"--no-session",
	"--no-tools",
	"--no-irc",
	"--no-lsp",
	"--no-pty",
	"--hide-thinking",
	"--advisor",
	"--print",
	"--print-thoughts",
	"--no-extensions",
	"--no-skills",
	"--skills-off",
	"--project-skills",
	"--no-rules",
	"--agentmd-off",
	"--no-title",
	"--auto-approve",
	"--yolo",
	"--ethereal",
	"--preserve-workspace",
	"--cleanup-workspace",
	"--copy-env",
]);

/**
 * True for a `--`-prefixed token that is not any known launch flag and carries
 * no inline `=value`: an UNKNOWN long option (typically an extension string
 * flag) that may consume the next argv token as its value. The bootstrap
 * pre-parser treats such a token's successor as value-like so it never steals
 * that token as a global `--profile`/`--alias` value.
 */
export function isUnknownLongValueCandidate(arg: string): boolean {
	if (!arg.startsWith("--") || arg === "--" || arg.includes("=")) return false;
	return (
		!STRING_VALUE_FLAGS.has(arg) &&
		!OPTIONAL_VALUE_FLAGS.has(arg) &&
		!VALUELESS_FLAGS.has(arg) &&
		arg !== PROFILE_BOOTSTRAP_BOUNDARY_ARG
	);
}
