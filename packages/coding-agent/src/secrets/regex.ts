/** Add global flag while preserving user-provided flags. */
function enforceGlobalFlag(flags: string): string {
	return flags.includes("g") ? flags : `${flags}g`;
}

/** Compile a secret regex entry with global scanning enabled by default. */
export function compileSecretRegex(pattern: string, flags?: string): RegExp {
	let resolvedPattern = pattern;
	let resolvedFlags = flags ?? "";

	// Detect regex literal syntax: /pattern/flags
	const literalMatch = /^\/((?:[^\\/]|\\.)*)\/([ gimsuy]*)$/.exec(pattern);
	if (literalMatch) {
		resolvedPattern = literalMatch[1];
		// Merge flags from literal with explicit flags param (deduplicate)
		const combined = new Set([...resolvedFlags, ...literalMatch[2]]);
		resolvedFlags = [...combined].join("");
	}

	return new RegExp(resolvedPattern, enforceGlobalFlag(resolvedFlags));
}
