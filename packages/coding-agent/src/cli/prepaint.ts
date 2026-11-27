/**
 * Which launches paint the speculative first frame (`modes/startup-composer.ts`) before their command
 * modules load. Free of runtime imports: `cli.ts` scans the argv here before anything else loads, and
 * `flag-tables.ts` validates `--prepaint` with it.
 */

export const PREPAINT_MODES = ["on", "off", "force"] as const;

/**
 * `--prepaint`: `on` (default) paints when the launch allows it (see {@link scanPrepaintArgv}), `off`
 * never paints, `force` paints whatever the other flags and config overlays say.
 */
export type PrepaintMode = (typeof PREPAINT_MODES)[number];

/** `value` as a {@link PrepaintMode}; `undefined` when it names none. */
export function parsePrepaintMode(value: string): PrepaintMode | undefined {
	return PREPAINT_MODES.find(mode => mode === value);
}

/**
 * Launch flags that only switch off discovery or persistence. An argv made of
 * these still enters interactive mode, so the speculative first frame is
 * valid; anything else (subcommands, `-p`, model/session selectors) skips it.
 */
const PREPAINT_SAFE_FLAGS: Record<string, true> = {
	"--no-session": true,
	"--no-extensions": true,
	"--no-skills": true,
	"--no-rules": true,
	"--no-context-files": true,
	"--no-tools": true,
	"--no-judge": true,
	"--no-spotlight": true,
	"--offline": true,
	"--no-lsp": true,
	"--no-title": true,
	"--no-prewalk": true,
	"--no-pty": true,
};

/**
 * Value flags that keep the frame valid; the value follows as the next token or
 * after `=`. `-e`/`--extension` only registers a path and the extension loads
 * later (issue #20158); `--config` overlays are checked once read
 * (`overlaysKeepPrepaint`); `--prepaint` picks the mode.
 */
const PREPAINT_VALUE_FLAGS: Record<string, true> = {
	"-e": true,
	"--extension": true,
	"--config": true,
	"--prepaint": true,
};

/** What a launch argv says about the first frame. */
export interface PrepaintArgv {
	/** The last `--prepaint` value; a missing or invalid one reads `off`, as the launch then fails with a usage error. */
	readonly mode: PrepaintMode;
	/** Every other token is a {@link PREPAINT_SAFE_FLAGS} flag or the value of a {@link PREPAINT_VALUE_FLAGS} flag. */
	readonly safe: boolean;
	/** The `--config` values, in argv order. */
	readonly overlays: readonly string[];
}

/** Classify a launch `argv` (no `process.argv` prefix) for the prepaint decision. */
export function scanPrepaintArgv(argv: readonly string[]): PrepaintArgv {
	let mode: PrepaintMode = "on";
	let safe = true;
	const overlays: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		if (PREPAINT_VALUE_FLAGS[flag] !== true) {
			if (PREPAINT_SAFE_FLAGS[arg] !== true) safe = false;
			continue;
		}
		// A missing `--config`/`--extension` value is a usage error the regular parse reports later.
		const value = eq === -1 ? argv[++index] : arg.slice(eq + 1);
		if (flag === "--prepaint") mode = parsePrepaintMode(value ?? "") ?? "off";
		else if (flag === "--config" && value !== undefined) overlays.push(value);
	}
	return { mode, safe, overlays };
}
