import { type } from "@oh-my-pi/omptype";
import { shortenPath } from "../utils/render-utils";
import { ToolError } from "../tools/tool-errors";
import type { HostEvalPreludeDefinition } from "../eval/preludes";
import archiveDocumentation from "../prompts/tools/archive.md" with { type: "text" };
import type { TimeWindow } from "../session/time-window";
import type { ToolSession } from "../tools";
import { resolveToCwd } from "../tools/path-utils";
import { cfgArchiveEnabled } from "../tools/settings";
import {
	type ActivityCallFilter,
	type ActivityFlags,
	type ActivityScope,
	archiveCalls,
	archiveGrep,
	archiveMessages,
	archiveStats,
} from "./activity";
import {
	type ArchiveScope,
	type ArchiveView,
	archiveProjects,
	archivePrompts,
	archiveRecaps,
	archiveSearch,
	archiveSession,
	archiveSessions,
} from "./archive";
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import archiveJavascript from "./prelude.js" with { type: "text" };
import archivePython from "./prelude.py" with { type: "text" };

/** Listing size when a call omits `limit`. */
const DEFAULT_LIMIT = 20;
/** Milliseconds per unit of a relative `since`/`until` age. */
const AGE_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

const limit = "1 <= number.integer <= 500";
/** Records an activity view may return: they are built for analysis, so far more than a listing shows. */
const recordLimit = "1 <= number.integer <= 10000";
const project = "string > 0";
const pattern = "string > 0";
const tools = "string > 0 | (string > 0)[]";
const window = { "since?": "string > 0", "until?": "string > 0" } as const;
const grepSources = type("'user' | 'assistant' | 'thinking' | 'args' | 'result'").array().atLeastLength(1);
const messageKinds = type("'user' | 'assistant' | 'thinking' | 'call' | 'result'").array().atLeastLength(1);
const callFilter = {
	"tool?": tools,
	"match?": pattern,
	"result?": pattern,
	"error?": "boolean",
	"flags?": "string",
	"project?": project,
	"subagents?": "boolean",
} as const;

const paramsSchema = type({ action: "'projects'", "limit?": limit, ...window, "+": "reject" })
	.or({ action: "'sessions' | 'recaps'", "project?": project, "limit?": limit, ...window, "+": "reject" })
	.or({ action: "'session'", id: "string > 0", "limit?": limit, "+": "reject" })
	.or({ action: "'prompts'", "query?": "string > 0", "project?": project, "limit?": limit, ...window, "+": "reject" })
	.or({ action: "'search'", query: "string > 0", "project?": project, "limit?": limit, ...window, "+": "reject" })
	.or({ action: "'calls'", ...callFilter, "limit?": recordLimit, ...window, "+": "reject" })
	.or({
		action: "'grep'",
		pattern,
		"sources?": grepSources,
		"tool?": tools,
		"flags?": "string",
		"project?": project,
		"subagents?": "boolean",
		"limit?": recordLimit,
		...window,
		"+": "reject",
	})
	.or({
		action: "'stats'",
		"by?": "'tool' | 'day' | 'model' | 'version' | 'project' | 'session'",
		...callFilter,
		"limit?": limit,
		...window,
		"+": "reject",
	})
	.or({
		action: "'messages'",
		id: "string > 0",
		"kinds?": messageKinds,
		"limit?": recordLimit,
		...window,
		"+": "reject",
	});

type ArchiveParams = typeof paramsSchema.infer;

/**
 * Absolute project directory for a `project` argument; `undefined` spans every
 * project. Omitted means the session's own working directory, `"*"` every
 * project, anything else a path (`~` expanded, relative to the session cwd).
 */
function resolveProject(project: string | undefined, cwd: string): string | undefined {
	if (project === "*") return undefined;
	return project === undefined ? cwd : resolveToCwd(project, cwd);
}

/**
 * Unix milliseconds of a `since`/`until` argument: an age before now (`90m`,
 * `36h`, `8d`, `2w`), an ISO date (local midnight), or an ISO date-time (local
 * unless it names a zone).
 *
 * @throws {ToolError} when the value is none of these.
 */
function parseInstant(value: string, name: "since" | "until", now: number): number {
	const text = value.trim();
	const age = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(text);
	if (age) return now - Number(age[1]) * AGE_UNIT_MS[age[2].toLowerCase()];
	const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
	// Date.parse reads a bare date as UTC midnight; a user means their own.
	if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
	const at = Date.parse(text);
	if (Number.isNaN(at)) {
		throw new ToolError(`archive ${name} must be an age like "8d", an ISO date, or an ISO date-time; got "${value}"`);
	}
	return at;
}

/**
 * The window of `since`/`until` arguments; `undefined` when neither is given.
 *
 * @throws {ToolError} when a bound is unreadable or `since` is not before `until`.
 */
function resolveWindow(params: { since?: string; until?: string }): TimeWindow | undefined {
	if (params.since === undefined && params.until === undefined) return undefined;
	const now = Date.now();
	const span: TimeWindow = {
		since: params.since === undefined ? undefined : parseInstant(params.since, "since", now),
		until: params.until === undefined ? undefined : parseInstant(params.until, "until", now),
	};
	if (span.since !== undefined && span.until !== undefined && span.since >= span.until) {
		throw new ToolError("archive since must be before until");
	}
	return span;
}

/**
 * Regex flags of the grep tool's dialect: `i` ignores case, `s` lets `.` and
 * matches cross newlines; `m` is always on (`^`/`$` anchor at lines).
 *
 * @throws {ToolError} when the flags hold any other letter.
 */
function regexFlags(flags: string | undefined): ActivityFlags {
	const letters = flags ?? "";
	if (!/^[ims]*$/.test(letters)) throw new ToolError(`archive flags may hold only i, m, and s; got "${letters}"`);
	return { ignoreCase: letters.includes("i"), dotAll: letters.includes("s") };
}

function scopeOf(
	params: { project?: string; since?: string; until?: string },
	cwd: string,
	count: number,
): ArchiveScope {
	return { cwd: resolveProject(params.project, cwd), window: resolveWindow(params), limit: count };
}

function activityScopeOf(
	params: { project?: string; since?: string; until?: string; subagents?: boolean },
	cwd: string,
	count: number,
): ActivityScope {
	return { ...scopeOf(params, cwd, count), subagents: params.subagents === true };
}

function callFilterOf(params: {
	tool?: string | string[];
	match?: string;
	result?: string;
	error?: boolean;
}): ActivityCallFilter {
	return { tools: toolList(params.tool), args: params.match, result: params.result, error: params.error };
}

function toolList(tool: string | string[] | undefined): string[] | undefined {
	return typeof tool === "string" ? [tool] : tool;
}

async function archiveView(params: ArchiveParams, cwd: string, signal?: AbortSignal): Promise<ArchiveView<unknown>> {
	const count = params.limit ?? DEFAULT_LIMIT;
	switch (params.action) {
		case "projects":
			return archiveProjects(count, resolveWindow(params));
		case "sessions":
			return archiveSessions(scopeOf(params, cwd, count));
		case "session":
			return archiveSession(params.id.endsWith(".jsonl") ? resolveToCwd(params.id, cwd) : params.id, count);
		case "prompts":
			return archivePrompts(params.query, scopeOf(params, cwd, count));
		case "search":
			return archiveSearch(params.query, scopeOf(params, cwd, count));
		case "recaps":
			return archiveRecaps(scopeOf(params, cwd, count));
		case "calls":
			return archiveCalls(
				callFilterOf(params),
				regexFlags(params.flags),
				activityScopeOf(params, cwd, count),
				signal,
			);
		case "grep":
			return archiveGrep(
				params.pattern,
				regexFlags(params.flags),
				{
					sources: params.sources ?? ["user", "assistant", "thinking", "args", "result"],
					tools: toolList(params.tool),
				},
				activityScopeOf(params, cwd, count),
				signal,
			);
		case "stats":
			return archiveStats(
				params.by ?? "tool",
				callFilterOf(params),
				regexFlags(params.flags),
				activityScopeOf(params, cwd, count),
				signal,
			);
		case "messages":
			return archiveMessages(params.id.endsWith(".jsonl") ? resolveToCwd(params.id, cwd) : params.id, {
				kinds: params.kinds,
				window: resolveWindow(params),
				limit: count,
				signal,
			});
	}
}

/** Status-tree line for a completed archive call: `archive.search("retry")`, `archive.sessions(*)`. */
function describeArchiveCall(parameters: unknown): string | undefined {
	const parsed = paramsSchema(parameters);
	if (parsed instanceof type.errors) return undefined;
	switch (parsed.action) {
		case "projects":
			return "archive.projects()";
		case "session":
		case "messages":
			return `archive.${parsed.action}(${parsed.id})`;
		case "search":
			return `archive.search(${JSON.stringify(parsed.query)})`;
		case "grep":
			return `archive.grep(${JSON.stringify(parsed.pattern)})`;
		case "prompts":
			if (parsed.query) return `archive.prompts(${JSON.stringify(parsed.query)})`;
			return `archive.prompts(${parsed.project ? shortenPath(parsed.project) : ""})`;
		case "stats":
			return `archive.stats(${parsed.by ?? "tool"})`;
		case "calls":
		case "sessions":
		case "recaps":
			return `archive.${parsed.action}(${parsed.project ? shortenPath(parsed.project) : ""})`;
	}
}

/**
 * Create the read-only archive prelude: prompt history, recent projects, past
 * sessions, recaps, session search, and tool-call activity.
 */
export function createArchivePrelude(session: ToolSession): HostEvalPreludeDefinition {
	return {
		name: "archive",
		documentation: archiveDocumentation,
		javascript: archiveJavascript,
		python: archivePython,
		exports: ["archive"],
		approval: "read",
		enabled: () => cfgArchiveEnabled.get(session.settings) === true,
		invoke: async (parameters, context) => {
			const parsed = paramsSchema(parameters);
			if (parsed instanceof type.errors)
				throw new ToolError(`archive received invalid arguments: ${parsed.summary}`);
			const view = await archiveView(parsed, session.cwd, context.signal);
			return { content: [{ type: "text", text: view.text }], details: view.records };
		},
		status: describeArchiveCall,
	};
}
