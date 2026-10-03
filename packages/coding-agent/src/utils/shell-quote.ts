/** Quote one argument for use in a POSIX shell command. */
export function quotePosixArgument(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Quote argv for use as a POSIX shell command string. */
export function quotePosixArgv(argv: readonly string[]): string {
	return argv.map(quotePosixArgument).join(" ");
}
