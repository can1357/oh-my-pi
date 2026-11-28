/**
 * Sections of an `edit.mode: magic` payload: one file each, its changes described in words.
 *
 * The edit tool parses a finished payload with {@link splitMagicSections}; the
 * renderer reads one still streaming in.
 *
 * @example
 * ```ts
 * splitMagicSections("# a.ts\n- Rename `x` to `y`.\n# b.ts\n- Drop");
 * // → { runs: [{ path: "a.ts", text: "- Rename `x` to `y`.\n" }, { path: "b.ts", text: "- Drop\n" }], outside: "" }
 * ```
 */

/** One file's run of described changes, in payload order; runs naming the same path stay apart. */
export interface MagicRun {
	path: string;
	text: string;
}

const PATH_HEADER = /^# +(\S.*?)\s*$/;

const FENCE = /^\s*```/;

/** `(path, text)` runs of a payload in order; `outside` is whatever precedes the first `# path` line. */
export function splitMagicSections(input: string): { runs: MagicRun[]; outside: string } {
	const runs: MagicRun[] = [];
	let outside = "";
	let current: MagicRun | undefined;
	// A `# ` line inside a code fence is code, not the next file.
	let fenced = false;
	for (const line of input.replace(/\r\n/g, "\n").split("\n")) {
		const header = fenced ? null : PATH_HEADER.exec(line);
		if (header) {
			current = { path: header[1], text: "" };
			runs.push(current);
			continue;
		}
		if (FENCE.test(line)) fenced = !fenced;
		if (current) current.text += `${line}\n`;
		else outside += line;
	}
	return { runs, outside };
}
