import type { ToolTier } from "@oh-my-pi/pi-agent-core";

export type AssignmentToolTrust = "core" | "core-readonly" | "external";

export type AssignmentToolClassification =
	| { readonly kind: "read" }
	| { readonly kind: "mutation"; readonly family: "write" | "edit" | "ast_edit" | "lsp" }
	| { readonly kind: "completion" }
	| { readonly kind: "denied" };

const CORE_READ_TOOLS: Record<string, true> = {
	read: true,
	glob: true,
	grep: true,
	web_search: true,
	ast_grep: true,
	inspect_image: true,
};
const CORE_TIERED_READ_TOOLS: Record<string, true> = {
	github: true,
	debug: true,
	computer: true,
	lsp: true,
};
const PASSIVE_HUB_OPS: Record<string, true> = {
	jobs: true,
	inbox: true,
	list: true,
	ps: true,
	logs: true,
	describe: true,
	wait: true,
};
const MUTATION_FAMILIES: Record<string, true> = { write: true, edit: true, ast_edit: true, lsp: true };
const XDEV_PREFIX = "xd://";

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function xdevTarget(args: unknown): string | undefined {
	const raw = record(args)?.path;
	if (typeof raw !== "string" || !raw.startsWith(XDEV_PREFIX)) return undefined;
	const target = raw.slice(XDEV_PREFIX.length).split(/[/:?#]/, 1)[0];
	return target || undefined;
}

/** Core registration and exact final arguments jointly determine whether a call is read-only. */
export function classifyAssignmentTool(
	toolName: string,
	trust: AssignmentToolTrust,
	tier: ToolTier,
	args: unknown,
): AssignmentToolClassification {
	if (trust !== "core" && trust !== "core-readonly") return { kind: "denied" };
	const xdTarget = toolName === "write" ? xdevTarget(args) : undefined;
	if (xdTarget) {
		// The discussion Session may not turn an admitted outer `write` transport
		// into nested authority. Call the core tool directly; hidden workers also
		// reject nested xd dispatch.
		return { kind: "denied" };
	}

	if (tier === "read") {
		if (CORE_READ_TOOLS[toolName] || CORE_TIERED_READ_TOOLS[toolName]) return { kind: "read" };
		if (toolName === "hub" && PASSIVE_HUB_OPS[String(record(args)?.op ?? "")]) return { kind: "read" };
		return { kind: "denied" };
	}
	if (tier !== "write") return { kind: "denied" };
	if (trust === "core-readonly") return { kind: "denied" };
	if (toolName === "assignment_complete") return { kind: "completion" };
	return MUTATION_FAMILIES[toolName]
		? { kind: "mutation", family: toolName as "write" | "edit" | "ast_edit" | "lsp" }
		: { kind: "denied" };
}
