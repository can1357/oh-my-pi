/**
 * `find` modes. One tool, three engines, chosen by which arguments the call
 * supplies:
 *
 * - `query`            -> semantic: the judged cascade ({@link runCascade}).
 * - `pattern`          -> content: exact regex over file contents ({@link ContentSearch}).
 * - `glob` / `path` only -> names: exact file/directory matching ({@link NameSearch}).
 *
 * Content and names are deterministic and unjudged; semantic is judged and can
 * miss. They are exclusive so a caller never gets a judged answer where it asked
 * for an exact one.
 */
import { type } from "@oh-my-pi/omptype";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { hasGlobPathChars } from "../path-utils";
import type { GrepToolInput } from "./content-search";
import type { GlobToolInput } from "./name-search";

export const findSchema = type({
	"query?": "string",
	"grep_keywords?": "string[]",
	"pattern?": "string",
	"glob?": "string",
	"path?": "string",
	"case?": "boolean",
	"gitignore?": "boolean",
	"hidden?": "boolean",
	"limit?": "1 <= number.integer <= 200",
	"skip?": type("number").or("null"),
});

export type FindToolInput = typeof findSchema.infer;

export type FindMode = "semantic" | "content" | "names";

/** Arguments each mode reads; any other supplied argument is refused rather than silently dropped. */
const MODE_ARGUMENTS: Record<FindMode, Partial<Record<keyof FindToolInput, true>>> = {
	semantic: { query: true, grep_keywords: true, path: true },
	content: { pattern: true, glob: true, path: true, case: true, gitignore: true, skip: true },
	names: { glob: true, path: true, hidden: true, gitignore: true, limit: true },
};

const MODE_PURPOSE: Record<FindMode, string> = {
	semantic: "`query` (+ `grep_keywords`, `path`): judged search by description; can miss, takes seconds",
	content: "`pattern` (+ `glob`, `path`, `case`, `gitignore`, `skip`): exact regex over file contents",
	names: "`glob` or `path` alone (+ `hidden`, `gitignore`, `limit`): exact file and directory names, also lists a directory",
};

const present = (value: unknown): boolean => value !== undefined && (typeof value !== "string" || value.trim() !== "");

/** The mode a call's arguments point at; never throws, so approval can classify a call before it is validated. */
export function inferFindMode(params: FindToolInput): FindMode {
	if (present(params.query)) return "semantic";
	if (present(params.pattern)) return "content";
	return present(params.glob) || present(params.path) ? "names" : "semantic";
}

/** Pick the mode a call asks for, or refuse it saying why and which arguments to use instead. */
export function resolveFindMode(params: FindToolInput): FindMode {
	const hasQuery = present(params.query);
	const hasPattern = present(params.pattern);
	const hasGlob = present(params.glob);

	if (hasQuery && (hasPattern || hasGlob)) {
		throw new ToolError(
			"`query` cannot be combined with `pattern` or `glob`: `query` is a judged search that can miss, while `pattern` and `glob` are exact and unjudged, so mixing them would give an answer of unknown completeness. " +
				"Use `query` (+ `grep_keywords`) to locate code by description, or `pattern`/`glob` to match text or names exactly.",
		);
	}
	const mode = inferFindMode(params);
	if (mode === "semantic" && !hasQuery) {
		throw new ToolError(
			"`find` needs something to search for. " +
				Object.values(MODE_PURPOSE)
					.map(line => `- ${line}`)
					.join("\n"),
		);
	}
	const allowed = MODE_ARGUMENTS[mode];
	const stray = (Object.keys(params) as Array<keyof FindToolInput>).filter(
		key => params[key] !== undefined && !(key in allowed),
	);
	if (stray.length > 0) {
		throw new ToolError(
			`${stray.map(key => `\`${key}\``).join(", ")} do${stray.length === 1 ? "es" : ""} not apply to ${mode} mode and would be ignored, ` +
				`which would hide that the search ran differently than asked. This call is ${mode} mode: ${MODE_PURPOSE[mode]}.`,
		);
	}
	return mode;
}

/**
 * Join `path` roots and `glob` patterns into the single scope the engines read:
 * every root x every glob, `;`-delimited. A `!exclusion` root passes through.
 */
export function scopeWithGlob(path: string | undefined, glob: string | undefined): string | undefined {
	if (!present(glob)) return path;
	const globs = glob!
		.split(";")
		.map(entry => entry.trim())
		.filter(Boolean);
	if (!present(path)) return globs.join(";");
	const roots = path!
		.split(";")
		.map(entry => entry.trim())
		.filter(Boolean);
	const joined: string[] = [];
	for (const root of roots) {
		if (root.startsWith("!")) {
			joined.push(root);
			continue;
		}
		if (hasGlobPathChars(root)) {
			throw new ToolError(
				`\`path\` "${root}" already contains a glob, so \`glob\` cannot also be applied to it. Put the whole pattern in \`glob\`, or make \`path\` a plain directory.`,
			);
		}
		const base = root.replace(/\/+$/, "");
		for (const pattern of globs) joined.push(`${base}/${pattern}`);
	}
	return joined.join(";");
}

/** `value` as a one-key object, or nothing: the engines' validators reject a key that is present but `undefined`. */
function only<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** The content engine's input for a content-mode call. */
export function contentParams(params: FindToolInput): GrepToolInput {
	return {
		pattern: params.pattern ?? "",
		...only("path", scopeWithGlob(params.path, params.glob)),
		...only("case", params.case),
		...only("gitignore", params.gitignore),
		...only("skip", params.skip),
	};
}

/** The names engine's input for a names-mode call. */
export function nameParams(params: FindToolInput): GlobToolInput {
	return {
		...only("path", scopeWithGlob(params.path, params.glob)),
		...only("hidden", params.hidden),
		...only("gitignore", params.gitignore),
		...only("limit", params.limit),
	};
}
