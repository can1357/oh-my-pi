/**
 * What a tool call of a Spotlight experiment session asked for, read from its arguments: the target recovery detection
 * compares ({@link callTarget}) and the token set of the generic rerun rule ({@link argumentTokens}). The parser
 * (`spotlight-ingest.ts`) stores both on each `spotlight_calls` row.
 */

import { ContainerPath, isRecord, type NestedWalk, runNested, stringifyDeepJson } from "@oh-my-pi/pi-utils";

/** Longest stored call target. */
export const SPOTLIGHT_TARGET_CHARS = 500;

/**
 * What a call asked for, as recovery detection compares it: a read's path with its selector, a bash command, a
 * search pattern with its path, eval code. Clipped to {@link SPOTLIGHT_TARGET_CHARS}.
 */
export function callTarget(toolName: string, args: unknown): string {
	const a: Record<string, unknown> = isRecord(args) ? args : {};
	const str = (key: string): string => {
		const value = a[key];
		return typeof value === "string" ? value : "";
	};
	let target: string;
	if (toolName === "read") target = str("path");
	else if (toolName === "bash") target = str("command");
	else if (toolName === "eval") target = str("code");
	else if (typeof a.pattern === "string") target = [str("pattern"), str("path")].filter(Boolean).join(" ");
	else if (typeof a.query === "string") target = [str("query"), str("path")].filter(Boolean).join(" ");
	else if (typeof a.path === "string") target = str("path");
	else {
		try {
			target = stringifyDeepJson(args ?? {}) ?? "";
		} catch {
			target = "";
		}
	}
	return target.slice(0, SPOTLIGHT_TARGET_CHARS);
}

/** Top-level arguments that say why, not what: the intent note every omp tool takes. */
const NOTE_ARGUMENTS = new Set(["i"]);
/** Argument keys whose string values are paths (or URLs), kept as one token even with spaces. */
const PATH_ARGUMENT = /(?:^|_)(?:path|file|dir|cwd|url)s?$/i;
/** Most tokens kept per call (the first distinct ones), and the longest token. */
const ARGUMENT_TOKEN_LIMIT = 256;
const ARGUMENT_TOKEN_CHARS = 200;

/**
 * A call's arguments as a token set for the generic rerun rule (two calls of the same tool rerun when their sets'
 * Jaccard similarity is high): every JSON leaf as `key=value`, the key being the nearest object key; strings split
 * on whitespace except under path keys (`path`, `paths`, `file`, `cwd`, `url`, …), which stay whole; nulls dropped;
 * the top-level intent note `i` left out. Distinct tokens in first-seen order, at most
 * {@link ARGUMENT_TOKEN_LIMIT}, each clipped to {@link ARGUMENT_TOKEN_CHARS} chars. The walk keeps its own stack
 * ({@link runNested}), so it reads arguments as deep as a transcript line holds.
 */
export function argumentTokens(args: unknown): string[] {
	const walk: ArgumentTokenWalk = { tokens: new Set(), path: new ContainerPath() };
	if (typeof args === "object" && args !== null) runNested(argumentTokensIn(args, "", true, walk));
	else addArgumentTokens(args, "", walk);
	return [...walk.tokens];
}

/** An {@link argumentTokens} walk: the tokens so far, and the containers it is inside, so a cycle fails. */
interface ArgumentTokenWalk {
	readonly tokens: Set<string>;
	readonly path: ContainerPath;
}

/** {@link argumentTokens} of `container`, under `key` (an array's elements under the array's), the arguments when `top`. */
function* argumentTokensIn(container: object, key: string, top: boolean, walk: ArgumentTokenWalk): NestedWalk<void> {
	walk.path.enter(container);
	if (Array.isArray(container)) {
		for (const item of container) {
			if (walk.tokens.size >= ARGUMENT_TOKEN_LIMIT) break;
			if (typeof item === "object" && item !== null) yield argumentTokensIn(item, key, false, walk);
			else addArgumentTokens(item, key, walk);
		}
	} else {
		const holder = container as Record<string, unknown>;
		for (const childKey in holder) {
			if (walk.tokens.size >= ARGUMENT_TOKEN_LIMIT) break;
			if (top && NOTE_ARGUMENTS.has(childKey)) continue;
			const child = holder[childKey];
			if (typeof child === "object" && child !== null) yield argumentTokensIn(child, childKey, false, walk);
			else addArgumentTokens(child, childKey, walk);
		}
	}
	walk.path.leave(container);
}

/** The tokens of `value`, a leaf under `key`: a string's words (a path's whole text), a number or a boolean itself. */
function addArgumentTokens(value: unknown, key: string, walk: ArgumentTokenWalk): void {
	const add = (token: string): void => {
		if (walk.tokens.size < ARGUMENT_TOKEN_LIMIT) walk.tokens.add(`${key}=${token}`.slice(0, ARGUMENT_TOKEN_CHARS));
	};
	if (typeof value === "string") {
		if (PATH_ARGUMENT.test(key)) {
			const whole = value.trim();
			if (whole) add(whole);
		} else {
			for (const part of value.split(/\s+/)) if (part) add(part);
		}
	} else if (typeof value === "number" || typeof value === "boolean") {
		add(String(value));
	}
}
