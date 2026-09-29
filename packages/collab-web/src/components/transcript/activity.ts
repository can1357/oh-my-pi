/**
 * Agent activity folding: consecutive tool calls between two chat messages (or
 * reasoning blocks) collapse into one summary line ("Read 3 files, 2 searches").
 */
import type { ToolResultMessage } from "@oh-my-pi/pi-wire";

export interface ActivityItem {
	id: string;
	name: string;
	args: unknown;
	intent?: string;
	result?: ToolResultMessage;
	running: boolean;
	partialResult?: unknown;
}

type ActivityCategory = "skill" | "read" | "search" | "edit" | "run" | "web" | "agent" | "todo" | "other";

/** Most tool calls one activity group holds; the next call starts a new group. */
export const MAX_GROUP_STEPS = 3;

/** Summary buckets for omp's built-in tool names; anything else is "other". */
const CATEGORY: Record<string, ActivityCategory> = {
	read: "read",
	grep: "search",
	search: "search",
	glob: "search",
	find: "search",
	ast_grep: "search",
	lsp: "search",
	recall: "search",
	edit: "edit",
	apply_patch: "edit",
	write: "edit",
	ast_edit: "edit",
	bash: "run",
	eval: "run",
	js: "run",
	python: "run",
	notebook: "run",
	web_search: "web",
	fetch: "web",
	browser: "web",
	puppeteer: "web",
	task: "agent",
	todo: "todo",
};

/** Summary phrase order: what was learned, then what was changed, then the rest. */
const ORDER: readonly ActivityCategory[] = ["skill", "read", "search", "edit", "run", "web", "agent", "todo", "other"];

function argPath(args: unknown): string | undefined {
	if (args === null || typeof args !== "object") return undefined;
	const path = (args as Record<string, unknown>).path;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

/**
 * Summary bucket and counting key for one tool call: reads/edits count distinct
 * paths, skills distinct names, tools without a bucket are named as-is.
 */
function classifyTool(item: { id: string; name: string; args: unknown }): {
	category: ActivityCategory;
	target: string;
} {
	const path = argPath(item.args);
	if (item.name === "read" && path?.startsWith("skill://")) {
		return { category: "skill", target: path.slice("skill://".length).split("/")[0] ?? path };
	}
	// tool-device dispatch: name the dispatched tool, not "write"
	if (item.name === "write" && path?.startsWith("xd://")) {
		return { category: "other", target: path.slice("xd://".length).split("/")[0] ?? path };
	}
	const category = CATEGORY[item.name] ?? "other";
	if (category === "other") return { category, target: item.name };
	return { category, target: (category === "read" || category === "edit") && path ? path : item.id };
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

export interface ActivitySummary {
	/** Human summary, e.g. "Read 3 files, 2 searches". */
	text: string;
	/** Tool calls in the group. */
	steps: number;
	/** Distinct targets the summary counts; below `steps` when calls repeat a file. */
	distinct: number;
	failed: number;
	running: number;
}

export function summarizeActivity(items: readonly ActivityItem[]): ActivitySummary {
	// Distinct targets per bucket: re-reading or re-editing one file counts once.
	const buckets = new Map<ActivityCategory, Set<string>>();
	// Unbucketed tools are listed by name, with a count per name.
	const others = new Map<string, number>();
	let failed = 0;
	let running = 0;
	for (const item of items) {
		if (item.running) running++;
		if (item.result?.isError === true) failed++;
		const { category, target } = classifyTool(item);
		if (category === "other") {
			others.set(target, (others.get(target) ?? 0) + 1);
			continue;
		}
		let set = buckets.get(category);
		if (!set) {
			set = new Set();
			buckets.set(category, set);
		}
		set.add(target);
	}

	const phrases: string[] = [];
	let distinct = 0;
	for (const category of ORDER) {
		if (category === "other") {
			for (const [name, n] of others) {
				phrases.push(n === 1 ? `used ${name}` : `used ${name} ×${n}`);
				distinct += n;
			}
			continue;
		}
		const set = buckets.get(category);
		if (!set) continue;
		const n = set.size;
		distinct += n;
		switch (category) {
			case "skill":
				phrases.push(n === 1 ? `used skill ${[...set][0]}` : `used ${n} skills`);
				break;
			case "read":
				phrases.push(`read ${plural(n, "file", "files")}`);
				break;
			case "search":
				phrases.push(plural(n, "search", "searches"));
				break;
			case "edit":
				phrases.push(`edited ${plural(n, "file", "files")}`);
				break;
			case "run":
				phrases.push(`ran ${plural(n, "command", "commands")}`);
				break;
			case "web":
				phrases.push(plural(n, "web lookup", "web lookups"));
				break;
			case "agent":
				phrases.push(plural(n, "subagent", "subagents"));
				break;
			case "todo":
				phrases.push("updated todos");
				break;
		}
	}
	const joined = phrases.join(", ");
	return { text: joined.charAt(0).toUpperCase() + joined.slice(1), steps: items.length, distinct, failed, running };
}
