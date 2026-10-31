import { Buffer } from "node:buffer";

/** Quote one argument for use in a POSIX shell command. */
export function quotePosixArgument(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Quote argv for use as a POSIX shell command string. */
export function quotePosixArgv(argv: readonly string[]): string {
	return argv.map(quotePosixArgument).join(" ");
}

function quotePosixUtf8Run(value: string): string {
	const octalBytes = Array.from(Buffer.from(value, "utf8"), byte => `\\${byte.toString(8).padStart(3, "0")}`).join("");
	// This run has no ASCII newline byte, so command substitution preserves it.
	return `"$(printf '${octalBytes}')"`;
}

function quotePosixArgumentAsciiSafe(value: string): string {
	const pieces: string[] = [];
	let asciiRun = "";
	let utf8Run = "";
	for (const character of value) {
		if (character.charCodeAt(0) <= 0x7f) {
			if (utf8Run) {
				pieces.push(quotePosixUtf8Run(utf8Run));
				utf8Run = "";
			}
			asciiRun += character;
		} else {
			if (asciiRun) {
				pieces.push(quotePosixArgument(asciiRun));
				asciiRun = "";
			}
			utf8Run += character;
		}
	}
	if (asciiRun) pieces.push(quotePosixArgument(asciiRun));
	if (utf8Run) pieces.push(quotePosixUtf8Run(utf8Run));
	return pieces.join("") || quotePosixArgument("");
}

/**
 * Build a POSIX shell command without literal non-ASCII input.
 * The optional cwd is quoted and changed to before invoking the command.
 */
export function quotePosixArgvAsciiSafe(argv: readonly string[], cwd?: string): string {
	const command = argv.map(quotePosixArgumentAsciiSafe).join(" ");
	if (cwd === undefined) return command;
	return `cd ${quotePosixArgumentAsciiSafe(cwd)} && ${command}`;
}
