/**
 * Promote grok-4.5-high style JSON-as-text "tool calls" into real toolCallParts.
 *
 * sand-automation often routes to `cursor-grok-4.5-high`, which understands the
 * advertised Shell/Read/Write schema but emits a fenced JSON object instead of
 * a protobuf `toolCallPart`. The agent (and the catalog matrix) only execute
 * `type: "toolCall"` blocks — so a text dump is a failed tool turn.
 */
import { toOmpToolName, toSandField2Name } from "./product-wire";

export type JsonTextToolCall = {
	name: string;
	arguments: Record<string, unknown>;
};

function stripMarkdownFence(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const fenced = /^```(?:json|jsonc|javascript|js|tool_code)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(trimmed);
	if (fenced?.[1] !== undefined) return fenced[1].trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
	return undefined;
}

function unwrapFunctionCall(obj: Record<string, unknown>): Record<string, unknown> {
	const inner = obj.functionCall ?? obj.function_call;
	if (inner && typeof inner === "object" && !Array.isArray(inner)) {
		return inner as Record<string, unknown>;
	}
	return obj;
}

/** Join visible text and thinking so JSON-as-text dumps in thought-only turns promote. */
export function assistantTextForJsonPromotion(
	content: ReadonlyArray<{ type: string; text?: string; thinking?: string }>,
): string {
	return content
		.map(block => {
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function resolveAdvertisedName(raw: string, advertised: ReadonlySet<string>): string | undefined {
	if (advertised.has(raw)) return raw;
	const lower = raw.toLowerCase();
	for (const name of advertised) {
		if (name.toLowerCase() === lower) return name;
	}
	const sand = toSandField2Name(raw);
	if (advertised.has(sand)) return sand;
	const omp = toOmpToolName(raw);
	if (advertised.has(omp)) return omp;
	return undefined;
}

function asArgsObject(value: unknown): Record<string, unknown> | undefined {
	if (value == null) return {};
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return {};
		if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
			try {
				const parsed = JSON.parse(trimmed) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					return parsed as Record<string, unknown>;
				}
			} catch {
				return undefined;
			}
			return undefined;
		}
		return undefined;
	}
	if (typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

/** Collect advertised field-2 names plus omp aliases (bash↔Shell). */
export function advertisedNamesForJsonTextToolCall(
	wireTools: unknown,
	ompTools?: Array<{ name?: string }> | readonly { name?: string }[] | undefined,
): Set<string> {
	const names = new Set<string>();
	if (Array.isArray(wireTools)) {
		for (const tool of wireTools) {
			if (!tool || typeof tool !== "object") continue;
			const name = (tool as { name?: unknown }).name;
			if (typeof name === "string" && name.trim()) names.add(name.trim());
		}
	}
	if (Array.isArray(ompTools)) {
		for (const tool of ompTools) {
			const name = typeof tool?.name === "string" ? tool.name.trim() : "";
			if (!name) continue;
			names.add(name);
			names.add(toSandField2Name(name));
			names.add(toOmpToolName(name));
		}
	}
	return names;
}

/**
 * Parse assistant text that is solely a (optionally fenced) JSON tool invocation
 * matching an advertised tool. Returns undefined when the text is prose, mixed
 * content, or names a tool that was not offered.
 */
export function parseJsonTextToolCall(text: string, advertisedNames: Iterable<string>): JsonTextToolCall | undefined {
	const advertised = advertisedNames instanceof Set ? advertisedNames : new Set(advertisedNames);
	if (advertised.size === 0) return undefined;
	const candidate = stripMarkdownFence(text);
	if (!candidate || !candidate.startsWith("{") || !candidate.endsWith("}")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const obj = unwrapFunctionCall(parsed as Record<string, unknown>);
	const rawName = obj.name ?? obj.tool ?? obj.toolName ?? obj.tool_name;
	if (typeof rawName !== "string" || !rawName.trim()) return undefined;
	const name = resolveAdvertisedName(rawName.trim(), advertised);
	if (!name) return undefined;
	const args = asArgsObject(obj.arguments ?? obj.args ?? obj.parameters);
	if (!args) return undefined;
	return { name, arguments: args };
}
