/**
 * Bootstrap-time argv preparser for the global `--profile` / `--alias` flags.
 *
 * Profile selection MUST happen before any module reads `getAgentDir()` (notably
 * `@oh-my-pi/pi-utils/env`, which eagerly loads `.env` from the agent directory
 * during its own import). The full `parseArgs` from `./args.ts` lives downstream
 * of those imports, so we can't rely on it for profile bootstrap — we have to
 * crack open argv before the lazy command modules load.
 *
 * Because of that, this preparser must respect the same value-consumption
 * contract as `args.ts`: known string-valued flags usually consume the next
 * token even when it starts with `-`, except for string flags that can be
 * shadowed by preloaded boolean extensions (currently `--plan`). Optional-value
 * flags (`--resume`, `--session`, `-r`) consume the next token only when it
 * doesn't look like another flag. Without this, `omp --system-prompt --profile
 * foo` silently activates profile `foo`
 * instead of passing the literal `--profile` to the system prompt and `foo`
 * as a positional message.
 *
 * The shared classification lives in {@link ./flag-tables}, imported below,
 * so the bootstrap and `args.ts` reference one source of truth instead of
 * maintaining parallel constants.
 *
 * An unclassified bare long option (one not in any flag table) is treated as a
 * possible extension string flag, but the bootstrap mirrors `parseArgs`'
 * extension-flag rules ({@link ./args}): a string extension flag consumes its
 * successor ONLY when that successor is value-like (does not start with `-`), and
 * a boolean extension flag consumes nothing. So the successor is forwarded
 * untouched (and never read as a global `--profile`/`--alias`) only when it is
 * value-like; a flag-looking successor is left for normal processing, so
 * `omp --some-ext-flag --profile work` still selects a profile. Known value-less
 * launch flags ({@link VALUELESS_FLAGS}) are exempt so a trailing profile after
 * them also activates (`omp --print --profile work`).
 */

import { isSubcommand, LAUNCH_FLAG_COMMANDS } from "../cli-commands";
import {
	EXTENSION_SHADOWABLE_STRING_FLAGS,
	isUnknownLongValueCandidate,
	OPTIONAL_FLAGS,
	OPTIONAL_VALUE_FLAGS,
	PROFILE_BOOTSTRAP_BOUNDARY_ARG,
	STRING_VALUE_FLAGS,
} from "./flag-tables";

function needsBoundaryAfterGlobalStrip(stripped: readonly string[]): boolean {
	const previous = stripped[stripped.length - 1];
	return (
		previous !== undefined &&
		(OPTIONAL_VALUE_FLAGS.has(previous) ||
			EXTENSION_SHADOWABLE_STRING_FLAGS.has(previous) ||
			isUnknownLongValueCandidate(previous))
	);
}

export interface ProfileBootstrapResult {
	argv: string[];
	profile?: string;
	aliasName?: string;
}

/**
 * Strip `--profile` / `--alias` from argv while preserving the surrounding
 * argument structure, returning the residual argv to hand to the launch parser
 * and the captured flag values.
 *
 * Global flag extraction stops only when the first residual argv token names a
 * registered command that owns its own flags (e.g. `grep`): everything from
 * that token onward is forwarded verbatim so a subcommand's own flags and
 * positionals are never stolen (`omp grep --profile <path>` greps for
 * `--profile`; it does not select a profile). `launch` and `acp` are explicit
 * spellings of launch-shaped commands, so `omp launch --profile work` and
 * `omp acp --profile work` still select profile `work`.
 *
 * Throws when either flag is supplied without a value.
 */
export function extractProfileFlags(argv: readonly string[]): ProfileBootstrapResult {
	const stripped: string[] = [];
	let profile: string | undefined;
	let aliasName: string | undefined;
	let passThrough = false;
	let sawSubcommand = false;
	let canDispatchSubcommand = true;
	let insertBoundaryBeforeNextValue = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];

		if (passThrough || sawSubcommand) {
			stripped.push(arg);
			continue;
		}

		if (insertBoundaryBeforeNextValue) {
			if (!arg.startsWith("-")) {
				stripped.push(PROFILE_BOOTSTRAP_BOUNDARY_ARG);
			}
			insertBoundaryBeforeNextValue = false;
		}

		// `--` ends option processing. Anything that follows is forwarded verbatim
		// so users can pass arbitrary tokens (including a literal `--profile`) to
		// downstream tools without the bootstrap stealing them.
		if (arg === "--") {
			passThrough = true;
			stripped.push(arg);
			continue;
		}

		if (arg === "--profile") {
			const value = argv[index + 1];
			if (!value || value.startsWith("-")) {
				throw new Error("--profile requires a profile name");
			}
			profile = value;
			insertBoundaryBeforeNextValue = needsBoundaryAfterGlobalStrip(stripped);
			index += 1;
			continue;
		}
		if (arg.startsWith("--profile=")) {
			const value = arg.slice("--profile=".length);
			if (!value) {
				throw new Error("--profile requires a profile name");
			}
			profile = value;
			insertBoundaryBeforeNextValue = needsBoundaryAfterGlobalStrip(stripped);
			continue;
		}
		if (arg === "--alias") {
			const value = argv[index + 1];
			if (!value || value.startsWith("-")) {
				throw new Error("--alias requires a command name");
			}
			aliasName = value;
			insertBoundaryBeforeNextValue = needsBoundaryAfterGlobalStrip(stripped);
			index += 1;
			continue;
		}
		if (arg.startsWith("--alias=")) {
			const value = arg.slice("--alias=".length);
			if (!value) {
				throw new Error("--alias requires a command name");
			}
			aliasName = value;
			insertBoundaryBeforeNextValue = needsBoundaryAfterGlobalStrip(stripped);
			continue;
		}

		// Known string flags normally consume flag-looking values (for example
		// `--system-prompt --profile foo` means the system prompt is literally
		// `--profile`). A small allow-list of built-ins can be shadowed by boolean
		// extensions before extension metadata is loaded; those mirror extension
		// consumption here so `--plan --profile work` still activates `work`.
		if (EXTENSION_SHADOWABLE_STRING_FLAGS.has(arg)) {
			canDispatchSubcommand = false;
			stripped.push(arg);
			const next = argv[index + 1];
			if (next !== undefined && !next.startsWith("-")) {
				stripped.push(next);
				index += 1;
			}
			continue;
		}

		// Forward both the flag and its value untouched so the downstream parser
		// gets exactly what the user typed. Critical for `--system-prompt
		// --profile foo`: the bootstrap must NOT interpret `--profile` here, it
		// belongs to `--system-prompt`.
		if (STRING_VALUE_FLAGS.has(arg)) {
			canDispatchSubcommand = false;
			stripped.push(arg);
			if (index + 1 < argv.length) {
				stripped.push(argv[index + 1]);
				index += 1;
			}
			continue;
		}

		if (OPTIONAL_VALUE_FLAGS.has(arg)) {
			canDispatchSubcommand = false;
			stripped.push(arg);
			const config = OPTIONAL_FLAGS[arg];
			const next = argv[index + 1];
			if (next !== undefined && !next.startsWith("-") && !(config.rejectEmpty === true && next.length === 0)) {
				stripped.push(next);
				index += 1;
			}
			continue;
		}

		// An unclassified bare long option (`--xxx` with no `=`) may be an extension
		// string flag that consumes the next token as its value. The bootstrap runs
		// before extensions load, so it cannot consult the extension flag table; it
		// therefore mirrors the value-consumption rule `parseArgs` applies to
		// extension flags (./args.ts): a string extension flag consumes its successor
		// ONLY when that successor is value-like (does not start with `-`), and a
		// boolean extension flag consumes nothing. So protect (forward + skip) the
		// successor only when it is value-like — `omp --bar val --profile work` keeps
		// `val` with `--bar` and still extracts the trailing profile — and otherwise
		// forward just the flag, letting the loop process a flag-looking successor so
		// a trailing global flag still applies (`omp --some-ext-bool --profile work`
		// selects profile `work`). A `--` successor is deliberately NOT protected
		// here: it falls through to the end-of-options arm above, keeping `--` a
		// single, consistent meaning instead of being swallowed as a flag value.
		// Known value-less launch flags are exempt so a trailing profile still
		// activates (`omp --print --profile work`).
		if (isUnknownLongValueCandidate(arg)) {
			canDispatchSubcommand = false;
			stripped.push(arg);
			const next = argv[index + 1];
			if (next !== undefined && !next.startsWith("-")) {
				stripped.push(next);
				index += 1;
			}
			continue;
		}

		// Only the first residual argv token can be the dispatched subcommand. Once
		// any other token has been forwarded, later subcommand names are launch text.
		// `launch` and `acp` are explicit spellings of launch-shaped commands, so
		// global launch flags that follow them must still be extracted.
		if (canDispatchSubcommand && isSubcommand(arg) && LAUNCH_FLAG_COMMANDS[arg] !== true) {
			sawSubcommand = true;
		}
		canDispatchSubcommand = false;
		stripped.push(arg);
	}

	return { argv: stripped, profile, aliasName };
}
