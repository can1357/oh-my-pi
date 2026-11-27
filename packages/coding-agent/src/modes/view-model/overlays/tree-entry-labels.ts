/**
 * Text for session-tree (`/tree`) rows and their search index: tool results
 * named by the call that produced them, advisor notes tagged with their
 * advisor and severity, custom messages without their model-facing
 * `<system-*>` envelope, bookkeeping entries spelled out with sanitized
 * metadata. Styling belongs to the screen that draws the rows.
 */
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import { shortenPath, toPathList } from "../../../utils/render-utils";

/** Per-message cap on text folded into a row or the search index. */
export const SEARCH_TEXT_LIMIT = 200;

/** An assistant tool call, looked up by a tool result's `toolCallId`. */
export interface TreeToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

/** The shape of a tree node the label helpers walk. */
interface TreeNodeLike {
	entry: { readonly type: string };
	children: readonly TreeNodeLike[];
}

/** Every assistant tool call under `roots`, by call id. */
export function collectToolCalls(roots: readonly TreeNodeLike[]): Map<string, TreeToolCall> {
	const calls = new Map<string, TreeToolCall>();
	const stack = [...roots];
	for (let node = stack.pop(); node; node = stack.pop()) {
		const entry = node.entry as { type: string; message?: unknown };
		const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (isRecord(block) && block.type === "toolCall" && typeof block.id === "string") {
					calls.set(block.id, {
						name: String(block.name),
						arguments: isRecord(block.arguments) ? block.arguments : {},
					});
				}
			}
		}
		stack.push(...node.children);
	}
	return calls;
}

/** Concatenated text blocks of message content, stopping once `limit` characters exist. */
export function joinTextContent(content: unknown, limit = Number.POSITIVE_INFINITY): string {
	if (typeof content === "string") return content.length > limit ? content.slice(0, limit) : content;
	if (!Array.isArray(content)) return "";
	let result = "";
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
			result += block.text;
			if (result.length >= limit) return result.slice(0, limit);
		}
	}
	return result;
}

/**
 * Collapse untrusted session metadata to one safe row field: strip
 * ANSI/control characters, then fold preserved tabs/newlines into spaces.
 */
export function sanitizeTreeField(value: string): string {
	return sanitizeText(value)
		.replace(/[\r\n\t\u2028\u2029]/g, " ")
		.trim();
}

/** Advisor note metadata surfaced on one row. */
export interface AdvisorTreeDisplay {
	/** Non-default advisor names then severities, comma-joined (e.g. `sec, blocker`). */
	qualifier: string;
	/** Note bodies joined into one line. */
	text: string;
}

/**
 * Display metadata from an advisor custom message's `details.notes`, ignoring
 * the model-facing `<advisory>` wrapper stored in `content`: distinct
 * non-default advisor names and severities tag the note the way its
 * transcript card does.
 */
export function advisorTreeDisplay(details: unknown): AdvisorTreeDisplay {
	if (!isRecord(details) || !Array.isArray(details.notes)) return { qualifier: "", text: "" };
	const notes: string[] = [];
	const advisors: string[] = [];
	const severities: string[] = [];
	for (const note of details.notes) {
		if (!isRecord(note)) continue;
		if (typeof note.note === "string") notes.push(note.note);
		if (typeof note.advisor === "string") {
			const name = sanitizeTreeField(note.advisor);
			if (name && name !== "default" && !advisors.includes(name)) advisors.push(name);
		}
		if (typeof note.severity === "string") {
			const severity = sanitizeTreeField(note.severity);
			if (severity && !severities.includes(severity)) severities.push(severity);
		}
	}
	return { qualifier: [...advisors, ...severities].join(", "), text: notes.join(" ") };
}

/** An advisor row's label: `advisor (sec, nit): ` or `advisor: `. */
export function advisorLabel(qualifier: string): string {
	return qualifier ? `advisor (${qualifier}): ` : "advisor: ";
}

/**
 * Strip one model-facing `<system-*>` envelope from custom-message content.
 * Nested system tags belong to the recorded payload and remain visible.
 */
export function stripSystemWrapperTags(content: string): string {
	const trimmed = content.trim();
	const opening = /^<(system-[\w-]+)/i.exec(trimmed);
	if (!opening) return content;

	const attributeStart = opening[0].length;
	const firstAttributeCharacter = trimmed[attributeStart];
	if (firstAttributeCharacter !== ">" && !/\s/.test(firstAttributeCharacter ?? "")) return content;

	let quote: '"' | "'" | undefined;
	let openingEnd = -1;
	for (let index = attributeStart; index < trimmed.length; index++) {
		const character = trimmed[index];
		if (quote) {
			if (character === quote) quote = undefined;
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === "<") {
			return content;
		} else if (character === ">") {
			openingEnd = index;
			break;
		}
	}
	if (openingEnd === -1 || quote) return content;

	const closingTag = `</${opening[1]}>`;
	const closingStart = trimmed.length - closingTag.length;
	if (closingStart <= openingEnd || trimmed.slice(closingStart).toLowerCase() !== closingTag.toLowerCase()) {
		return content;
	}
	return trimmed.slice(openingEnd + 1, closingStart).trim();
}

/** A tool result's label from the call that produced it (`[read: src/a.ts:1-20]`, `[grep: /x/ in a, b]`). */
export function formatToolCall(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "read": {
			const path = shortenPath(String(args.path || args.file_path || ""));
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let display = path;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				display += `:${start}${end ? `-${end}` : ""}`;
			}
			return `[read: ${display}]`;
		}
		case "write":
			return `[write: ${shortenPath(String(args.path || args.file_path || ""))}]`;
		case "edit":
			return `[edit: ${shortenPath(String(args.path || args.file_path || ""))}]`;
		case "bash": {
			const rawCmd = String(args.command || "");
			const cmd = rawCmd
				.replace(/[\n\t]/g, " ")
				.trim()
				.slice(0, 50);
			return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
		}
		case "grep": {
			const pattern = String(args.pattern || "");
			const input =
				typeof args.paths === "string" || Array.isArray(args.paths)
					? args.paths
					: typeof args.path === "string"
						? args.path
						: undefined;
			const paths = toPathList(input);
			return `[grep: /${pattern}/ in ${shortenPath(paths.length > 0 ? paths.join(", ") : ".")}]`;
		}
		case "glob": {
			const input =
				typeof args.path === "string"
					? args.path
					: typeof args.paths === "string" || Array.isArray(args.paths)
						? args.paths
						: undefined;
			const paths = toPathList(input);
			return `[glob: ${shortenPath(paths.length > 0 ? paths.join(", ") : ".")}]`;
		}
		case "ls":
			return `[ls: ${shortenPath(String(args.path || "."))}]`;
		default: {
			// Custom tool: its name and truncated JSON arguments.
			const json = JSON.stringify(args);
			return `[${name}: ${json.slice(0, 40)}${json.length > 40 ? "..." : ""}]`;
		}
	}
}

/** A `model_usage` entry's row text: `[model usage: purpose role provider/model]`, every field sanitized. */
export function modelUsageLabel(entry: Record<string, unknown>): string {
	const purpose = sanitizeTreeField(String(entry.purpose ?? ""));
	const role = sanitizeTreeField(typeof entry.role === "string" ? entry.role : "");
	const provider = sanitizeTreeField(String(entry.provider ?? ""));
	const model = sanitizeTreeField(String(entry.model ?? ""));
	return `[model usage: ${purpose} ${role ? `${role} ` : ""}${provider}/${model}]`;
}

/** A `service_tier_change` entry's row text: per-family tiers, or `(default)` when the session went back to it. */
export function serviceTierLabel(serviceTier: unknown): string {
	const tiers = isRecord(serviceTier)
		? Object.entries(serviceTier)
				.map(([family, tier]) => `${family}:${tier}`)
				.join(" ")
		: "(default)";
	return `[service tier: ${tiers}]`;
}

/** The text search matches an entry (and its user label) against. */
export function entrySearchText(entry: { readonly type: string }, label: string | undefined): string {
	const record = entry as Record<string, unknown> & { type: string };
	const parts: string[] = [];
	if (label) parts.push(label);
	switch (record.type) {
		case "message": {
			const message = isRecord(record.message) ? record.message : {};
			parts.push(String(message.role));
			if (message.content) parts.push(joinTextContent(message.content, SEARCH_TEXT_LIMIT));
			if (message.role === "bashExecution" && typeof message.command === "string" && message.command) {
				parts.push(message.command);
			}
			break;
		}
		case "custom_message": {
			parts.push(String(record.customType));
			if (record.customType === "advisor") {
				const { qualifier, text } = advisorTreeDisplay(record.details);
				if (qualifier) parts.push(qualifier);
				if (text) parts.push(text);
			} else {
				const content = stripSystemWrapperTags(joinTextContent(record.content)).slice(0, SEARCH_TEXT_LIMIT);
				if (content) parts.push(content);
			}
			break;
		}
		case "compaction":
			parts.push("compaction");
			break;
		case "branch_summary":
			parts.push("branch summary", String(record.summary));
			break;
		case "model_change":
			parts.push("model", String(record.model));
			break;
		case "model_usage":
			parts.push(
				"model usage",
				sanitizeTreeField(String(record.purpose ?? "")),
				sanitizeTreeField(typeof record.role === "string" ? record.role : ""),
				sanitizeTreeField(String(record.provider ?? "")),
				sanitizeTreeField(String(record.model ?? "")),
			);
			break;
		case "thinking_level_change":
			parts.push("thinking", String(record.thinkingLevel ?? "off"));
			break;
		case "custom":
			parts.push("custom", String(record.customType));
			break;
		case "label":
			parts.push("label", typeof record.label === "string" ? record.label : "");
			break;
		case "service_tier_change":
			parts.push("service tier");
			if (isRecord(record.serviceTier)) {
				const serviceTier = record.serviceTier;
				for (const family in serviceTier) {
					const tier = serviceTier[family];
					if (tier) parts.push(family, String(tier));
				}
			}
			break;
		case "title_change":
			parts.push("title", String(record.title));
			break;
		case "mode_change":
			parts.push("mode", String(record.mode));
			break;
		case "credential_pin":
			parts.push("credential pin", String(record.provider));
			break;
		case "ttsr_injection":
			parts.push("ttsr injection", ...(Array.isArray(record.injectedRules) ? record.injectedRules.map(String) : []));
			break;
		case "reset_boundary":
			parts.push("reset boundary");
			break;
		case "session_init":
			parts.push("session init");
			break;
	}
	return parts.join(" ");
}
