/**
 * Repair double-encoded JSON string arguments for the task tool.
 *
 * Models occasionally JSON-escape a string value twice when emitting a
 * `task` tool call, so a `task` field that should read
 *
 *     # Role
 *     You are a judge … "describe this" … return —
 *
 * arrives — after the one JSON decode the provider already applied — as the
 * literal text
 *
 *     # Role\nYou are a judge … \"describe this\" … return \u2014
 *
 * i.e. every newline, quote, and unicode character is still backslash-escaped.
 * The subagent then receives that garbled prompt, and the call preview renders
 * one long blob with visible `\n` / `\"` / `\uXXXX`.
 *
 * The *whole-arguments* form of this quirk (the entire `arguments` blob is a
 * JSON string) is already auto-corrected by the validator's JSON-string
 * coercion. This module handles the *per-field* form, where the object parses
 * fine but an individual string value is double-encoded — the validator never
 * fires there because a double-encoded string is still a structurally valid
 * string.
 *
 * This is deliberately scoped to the task tool's natural-language fields
 * (`task`, shared `context`); identifier fields (`name`, `agent`)
 * are never repaired. It is NOT applied to code-bearing
 * tools (write/edit/bash/search), where a backslash or quote is load-bearing
 * and a false-positive unescape would silently corrupt a file or command.
 */
import type { TaskItem, TaskParams } from "./types";

/** A backslash that escapes a structural char — `\"`, `\\`, `\/`, or `\uXXXX`. */
const STRUCTURAL_ESCAPE = /\\(?:["\\/]|u[0-9a-fA-F]{4})/;

/**
 * Whether `value` carries the signature of whole-string double-encoding rather
 * than an incidental escape mention. A lone `\n`/`\t` in an instruction (e.g.
 * "split lines on \n") is far more likely a literal mention than a
 * double-encoded document, so it is left alone; a structural escape (`\"`,
 * `\\`, `\uXXXX`) or two-plus escape sequences indicates a re-escaped payload.
 */
function hasDoubleEncodeSignature(value: string): boolean {
	if (STRUCTURAL_ESCAPE.test(value)) return true;
	let count = 0;
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) === 0x5c /* \ */) {
			count += 1;
			if (count >= 2) return true;
			i += 1; // skip the escaped char so `\\` counts once
		}
	}
	return false;
}

/**
 * Return the once-unescaped string when `value` is uniformly double-encoded
 * JSON (a well-formed JSON string body that decodes to a different string);
 * otherwise return `value` unchanged.
 *
 * The `JSON.parse(\`"${value}"\`)` round-trip is the safety net: it only
 * succeeds when *every* backslash begins a valid JSON escape and no bare
 * double-quote exists — exactly the signature of double-encoding. Genuine
 * prose with a Windows path (`C:\Users`), a regex (`\d+`), an embedded quote,
 * or a real (already-decoded) newline makes the parse throw, so the value is
 * returned untouched.
 */
export function repairDoubleEncodedJsonString(value: string): string {
	// Fast path: no backslash → nothing was escaped → the parse can never differ.
	if (!value.includes("\\")) return value;
	if (!hasDoubleEncodeSignature(value)) return value;
	let decoded: unknown;
	try {
		decoded = JSON.parse(`"${value}"`);
	} catch {
		return value;
	}
	return typeof decoded === "string" && decoded !== value ? decoded : value;
}

function stringProperty(obj: Record<string, unknown>, key: string): string | undefined {
	const val = obj[key];
	return typeof val === "string" && val.trim() !== "" ? val : undefined;
}

/** Repair a single (possibly partial) task item's prose field (`task`). */
function repairTaskItem(item: TaskItem): TaskItem {
	if (item === null || typeof item !== "object") return item;
	const raw = item as Record<string, unknown>;
	let nextItem = item;

	// Cursor/foreign model compatibility: prompt -> task, description -> name, explore -> scout
	if (typeof nextItem.task !== "string" || nextItem.task.trim() === "") {
		const fallbackTask = stringProperty(raw, "prompt") ?? stringProperty(raw, "instruction");
		if (fallbackTask !== undefined) {
			nextItem = { ...nextItem, task: fallbackTask };
		}
	}
	if (typeof nextItem.name !== "string" || nextItem.name.trim() === "") {
		const fallbackName = stringProperty(raw, "description");
		if (fallbackName !== undefined) {
			nextItem = { ...nextItem, name: fallbackName };
		}
	}
	if (
		!nextItem.agent &&
		(raw.subagent_type === "explore" ||
			(raw.subagent_type &&
				typeof raw.subagent_type === "object" &&
				(raw.subagent_type as Record<string, unknown>).explore !== undefined))
	) {
		nextItem = { ...nextItem, agent: "scout" };
	}

	const task = typeof nextItem.task === "string" ? repairDoubleEncodedJsonString(nextItem.task) : nextItem.task;
	if (task === nextItem.task && nextItem === item) return item;
	return { ...nextItem, task };
}

/**
 * Repair double-encoded prose in task-tool params (flat `task`, shared
 * `context`, and each batch task item's `task`). Returns the same reference
 * when nothing changed so callers can cheaply skip work. Defensive against
 * partially-streamed args (missing/undefined fields, partial task arrays) so
 * it is safe on the render path as well as on execution.
 */
export function repairTaskParams(params: TaskParams): TaskParams {
	if (params === null || typeof params !== "object") return params;
	const raw = params as Record<string, unknown>;
	let nextParams = params;

	// Cursor/foreign model single-task compatibility: prompt -> task, description -> name, explore -> scout
	if (typeof nextParams.task !== "string" || nextParams.task.trim() === "") {
		const fallbackTask = stringProperty(raw, "prompt") ?? stringProperty(raw, "instruction");
		if (fallbackTask !== undefined) {
			nextParams = { ...nextParams, task: fallbackTask };
		}
	}
	if (typeof nextParams.name !== "string" || nextParams.name.trim() === "") {
		const fallbackName = stringProperty(raw, "description");
		if (fallbackName !== undefined) {
			nextParams = { ...nextParams, name: fallbackName };
		}
	}
	if (
		!nextParams.agent &&
		(raw.subagent_type === "explore" ||
			(raw.subagent_type &&
				typeof raw.subagent_type === "object" &&
				(raw.subagent_type as Record<string, unknown>).explore !== undefined))
	) {
		nextParams = { ...nextParams, agent: "scout" };
	}

	const task = typeof nextParams.task === "string" ? repairDoubleEncodedJsonString(nextParams.task) : nextParams.task;
	const context =
		typeof nextParams.context === "string" ? repairDoubleEncodedJsonString(nextParams.context) : nextParams.context;

	let effectiveContext = context;
	if (Array.isArray(nextParams.tasks) && (effectiveContext === undefined || effectiveContext.trim() === "")) {
		const fallbackContext = stringProperty(raw, "description");
		if (fallbackContext !== undefined) {
			effectiveContext = fallbackContext;
		}
	}

	let tasks = nextParams.tasks;
	if (Array.isArray(nextParams.tasks)) {
		let changed = false;
		const repaired = nextParams.tasks.map(item => {
			const next = repairTaskItem(item);
			if (next !== item) changed = true;
			return next;
		});
		if (changed) tasks = repaired;
	}

	if (task === params.task && effectiveContext === params.context && tasks === params.tasks && nextParams === params) {
		return params;
	}
	return { ...nextParams, task, context: effectiveContext, tasks };
}
