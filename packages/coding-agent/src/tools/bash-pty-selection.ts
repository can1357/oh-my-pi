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
 * `doas` and `sudo` open `/dev/tty` themselves and never read the password from
 * stdin, so without a PTY they die with `Authentication failed` instead of
 * prompting.
 */
const TTY_AUTH_COMMANDS = new Set(["doas", "sudo"]);

/**
 * Options that already say where the answer comes from — `-n` (fail rather than
 * prompt), `-A` (askpass helper), `-S` (read the password from stdin). A caller
 * that passed one did not ask for a prompt, so no terminal is allocated.
 */
const NON_PROMPT_OPTIONS = new Set(["-n", "--non-interactive", "-A", "--askpass", "-S", "--stdin"]);

/** A leading `NAME=value` assignment, which prefixes a command word without being it. */
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/u;

/**
 * Return whether the command needs a controlling terminal for a password
 * prompt, so the bash tool can route it through the interactive PTY (or the
 * client terminal bridge) the way an explicit `pty` request is routed.
 *
 * Any command position counts — `echo hi && doas pacman -S x` needs the
 * terminal as much as a bare `doas` — and a command word named by path
 * (`/usr/bin/doas`) is the same command.
 */
export function bashNeedsAuthTerminal(command: string): boolean {
	for (const segment of tokenizeShellSegments(command)) {
		if (segmentNeedsAuthTerminal(segment)) return true;
	}
	return false;
}

function segmentNeedsAuthTerminal(segment: string[]): boolean {
	const commandIndex = segment.findIndex(token => !SHELL_ASSIGNMENT.test(token));
	if (commandIndex === -1) return false;
	const commandWord = segment[commandIndex];
	if (!TTY_AUTH_COMMANDS.has(commandWord.slice(commandWord.lastIndexOf("/") + 1))) return false;
	// Only the auth command's own leading options decide; a `-n` in the wrapped
	// command's arguments says nothing about how the password is read.
	for (let i = commandIndex + 1; i < segment.length; i++) {
		const token = segment[i];
		if (token === "--") break;
		if (!token.startsWith("-") || token === "-") break;
		if (NON_PROMPT_OPTIONS.has(token)) return false;
	}
	return true;
}
