export interface BuildBindingsOptions {
	dest: string | null;
}

/** Parse the isolated output destination used by packaging builds. */
export function parseBuildBindingsArgs(argv: readonly string[]): BuildBindingsOptions {
	let dest: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dest") {
			const value = argv[++i];
			if (!value) throw new Error("--dest requires a directory argument");
			dest = value;
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`Unknown flag ${arg}`);
	}
	return { dest };
}
