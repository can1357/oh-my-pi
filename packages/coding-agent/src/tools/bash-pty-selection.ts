import { $env } from "@oh-my-pi/pi-utils/env";
import { tokenizeShellSegments } from "./shell-tokenize";

/** Minimal UI-capability fields needed to decide whether bash can use the local PTY overlay. */
export interface BashPtyContext {
	hasUI?: boolean;
	ui?: unknown;
}

/** Return whether a bash tool call should use the local interactive PTY overlay. */
export function canUseInteractiveBashPty(pty: boolean, ctx: BashPtyContext | undefined): boolean {
	if (!pty) return false;
	if ($env.PI_NO_PTY === "1") return false;
	return ctx?.hasUI === true && ctx.ui !== undefined;
}

/**
 * Commands that read a privileged password from the controlling terminal:
 * `doas`, `sudo`, and `sudoedit` (the `sudo -e` alias) open `/dev/tty`
 * themselves and never read the password from stdin, so without a PTY they die
 * with `Authentication failed` instead of prompting.
 */
const TTY_AUTH_COMMANDS = new Set(["doas", "sudo", "sudoedit"]);

/**
 * Short options that already say where the answer comes from — `-n` (fail
 * rather than prompt), `-A` (askpass helper), `-S` (read the password from
 * stdin). A caller that passed one did not ask for a prompt, so no terminal is
 * allocated. Checked per letter, so a cluster such as `-Sn` counts as `-S`.
 */
const NON_PROMPT_SHORT_OPTIONS = new Set(["n", "A", "S"]);

/** Long forms of {@link NON_PROMPT_SHORT_OPTIONS}. */
const NON_PROMPT_LONG_OPTIONS = new Set(["non-interactive", "askpass", "stdin"]);

/**
 * Auth-command options that consume the next word when written separately
 * (`sudo -u root -n id`), so the scan must skip that word instead of reading it
 * as a command or an option. From the `sudo -h` option list; `doas` shares the
 * ones it has.
 */
const OPTION_ARG_SHORT = new Set(["u", "g", "p", "C", "h", "r", "t", "U", "D", "R", "T", "a"]);

/** Long forms of {@link OPTION_ARG_SHORT}. */
const OPTION_ARG_LONG = new Set([
	"user",
	"group",
	"prompt",
	"close-from",
	"host",
	"role",
	"type",
	"other-user",
	"chdir",
	"chroot",
	"command-timeout",
	"auth-type",
]);

/** A leading `NAME=value` assignment, which prefixes a command word without being it. */
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/u;

/**
 * Shell words that run the word after them as the command they wrap, so
 * `! sudo true` and `time sudo true` prompt like a bare `sudo true`.
 */
const SHELL_PREFIXES = new Set(["!", "time", "command", "exec", "nohup", "env"]);

/** Options of the prefixes above that consume the next word (`env -u NAME sudo id`). */
const PREFIX_OPTION_ARG = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a"]);

/**
 * Return whether the command needs a controlling terminal for a password
 * prompt, so the bash tool can route it through the interactive PTY (or the
 * client terminal bridge) the way an explicit `pty` request is routed.
 *
 * Any command position counts — `echo hi && doas pacman -S x` needs the
 * terminal as much as a bare `doas` — a command word named by path
 * (`/usr/bin/doas`) is the same command, and a shell prefix (`!`, `time`,
 * `env …`) is looked through.
 */
export function bashNeedsAuthTerminal(command: string): boolean {
	for (const segment of tokenizeShellSegments(command)) {
		if (segmentNeedsAuthTerminal(segment)) return true;
	}
	return false;
}

/** The command name without its directory, so `/usr/bin/doas` is `doas`. */
function baseName(word: string): string {
	return word.slice(word.lastIndexOf("/") + 1);
}

/**
 * Index of the word the shell executes, skipping the assignments and prefix
 * commands (`!`, `time`, `command`, `exec`, `nohup`, `env`) in front of it.
 * Returns -1 when the segment holds no command word.
 */
function effectiveCommandIndex(segment: string[]): number {
	let i = 0;
	while (i < segment.length) {
		const word = segment[i];
		if (SHELL_ASSIGNMENT.test(word)) {
			i++;
			continue;
		}
		if (!SHELL_PREFIXES.has(baseName(word))) return i;
		i = skipPrefixOperands(segment, i + 1);
	}
	return -1;
}

/** Skip a prefix command's own assignments and options, stopping at the word it wraps. */
function skipPrefixOperands(segment: string[], index: number): number {
	let i = index;
	while (i < segment.length) {
		const word = segment[i];
		if (SHELL_ASSIGNMENT.test(word)) {
			i++;
			continue;
		}
		if (!word.startsWith("-") || word === "-" || word === "--") break;
		i += PREFIX_OPTION_ARG.has(word) ? 2 : 1;
	}
	return i;
}

function segmentNeedsAuthTerminal(segment: string[]): boolean {
	const commandIndex = effectiveCommandIndex(segment);
	if (commandIndex === -1) return false;
	if (!TTY_AUTH_COMMANDS.has(baseName(segment[commandIndex]))) return false;
	return authCommandMayPrompt(segment, commandIndex + 1);
}

/**
 * Scan only the auth command's own leading options — a `-n` in the wrapped
 * command's arguments (`sudo printf -- -n`) says nothing about how the password
 * is read — and report whether any of them asks for no prompt.
 */
function authCommandMayPrompt(segment: string[], start: number): boolean {
	for (let i = start; i < segment.length; i++) {
		const token = segment[i];
		// `--` ends the option list: what follows is the wrapped command.
		if (token === "--") break;
		// The first non-option word is the wrapped command.
		if (!token.startsWith("-") || token === "-") break;
		if (token.startsWith("--")) {
			const equals = token.indexOf("=");
			const name = (equals === -1 ? token : token.slice(0, equals)).slice(2);
			if (NON_PROMPT_LONG_OPTIONS.has(name)) return false;
			// `--user=root` carries its own value; `--user root` takes the next word.
			if (equals === -1 && OPTION_ARG_LONG.has(name)) i++;
			continue;
		}
		// A short cluster (`-Sn`): letters are flags, the rest of the cluster is
		// the value of the first letter that takes one.
		for (let letter = 1; letter < token.length; letter++) {
			const flag = token[letter];
			if (NON_PROMPT_SHORT_OPTIONS.has(flag)) return false;
			if (!OPTION_ARG_SHORT.has(flag)) continue;
			if (letter === token.length - 1) i++;
			break;
		}
	}
	return true;
}
