/**
 * Promote grok-4.5-high style JSON-as-text "tool calls" into real toolCallParts.
 *
 * sand-automation often routes to `cursor-grok-4.5-high`, which understands the
 * advertised Shell/Read/Write schema but emits a fenced JSON object instead of
 * a protobuf `toolCallPart`. The agent (and the catalog matrix) only execute
 * `type: "toolCall"` blocks — so a text dump is a failed tool turn.
 */
import { GeminiInbandScanner } from "../../dialect/gemini";
import { shouldClaimSandWireName, toOmpToolName, toSandField2Name } from "./product-wire";

export type JsonTextToolCall = {
	name: string;
	arguments: Record<string, unknown>;
};

/**
 * Gate JSON-as-text promotion to catalog-opted models or product wire profiles
 * that dump Shell JSON instead of toolCallPart. Native models without the
 * catalog fact keep advertised-looking JSON as plain text.
 */
export function shouldPromoteJsonTextToolCall(opts: {
	sandPromoteJsonTextTools?: boolean;
	wireMode?: string;
}): boolean {
	if (opts.sandPromoteJsonTextTools === true) return true;
	const wire = opts.wireMode;
	return wire === "automation" || wire === "parent-chat" || wire === "keep-model";
}

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
	excludeIndexes?: ReadonlySet<number>,
): string {
	return content
		.map((block, index) => {
			if (excludeIndexes?.has(index)) return "";
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

type OmpToolNameSource = {
	name?: string;
	customWireName?: string;
};

/** Prefer the omp tool that owns an advertised sand/wire name (same collision policy as product wire). */
function preferredOmpOwnerForWireName(
	wireName: string,
	ompTools: ReadonlyArray<OmpToolNameSource> | undefined,
): string | undefined {
	if (!Array.isArray(ompTools) || ompTools.length === 0) return undefined;
	let winner: string | undefined;
	for (const tool of ompTools) {
		const ompName = typeof tool?.name === "string" ? tool.name.trim() : "";
		if (!ompName) continue;
		const custom =
			typeof tool.customWireName === "string" && tool.customWireName.trim() ? tool.customWireName.trim() : "";
		const sand = custom || toSandField2Name(ompName);
		if (sand !== wireName && ompName !== wireName) continue;
		if (shouldClaimSandWireName(wireName, ompName, winner)) {
			winner = ompName;
		}
	}
	return winner;
}

/** Collect advertised field-2 names plus preferred omp aliases (bash↔Shell). */
export function advertisedNamesForJsonTextToolCall(
	wireTools: unknown,
	ompTools?: Array<OmpToolNameSource> | readonly OmpToolNameSource[] | undefined,
): Set<string> {
	const names = new Set<string>();
	let hasWire = false;
	if (Array.isArray(wireTools)) {
		for (const tool of wireTools) {
			if (!tool || typeof tool !== "object") continue;
			const name = (tool as { name?: unknown }).name;
			if (typeof name !== "string" || !name.trim()) continue;
			hasWire = true;
			const trimmed = name.trim();
			names.add(trimmed);
			names.add(toSandField2Name(trimmed));
			// Alias only the omp/custom owner that survived wire-name collision —
			// not an unconditional PascalCase→preferred-omp map (that invents bash
			// when an extension owns Shell via customWireName).
			const owner = preferredOmpOwnerForWireName(trimmed, ompTools);
			if (owner) {
				names.add(owner);
				names.add(toSandField2Name(owner));
			} else if (!Array.isArray(ompTools) || ompTools.length === 0) {
				// No omp catalog provided (tests / wire-only): keep built-in alias.
				names.add(toOmpToolName(trimmed));
			}
		}
	}
	// Native / no field-2 rewrite: wire tools absent → alias from omp tools alone.
	if (!hasWire && Array.isArray(ompTools)) {
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

/** Index of the `)` matching `(` at openIndex, skipping Python string contents. */
function matchParen(body: string, openIndex: number): number {
	let depth = 0;
	let i = openIndex;
	const n = body.length;
	while (i < n) {
		const ch = body[i]!;
		if (ch === '"' || ch === "'") {
			const quote = ch;
			const triple = quote + quote + quote;
			if (body.startsWith(triple, i)) {
				const close = body.indexOf(triple, i + 3);
				i = close === -1 ? n : close + 3;
				continue;
			}
			i++;
			while (i < n) {
				const c = body[i]!;
				if (c === "\\") {
					i += 2;
					continue;
				}
				if (c === quote) {
					i++;
					break;
				}
				i++;
			}
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return i;
		i++;
	}
	return -1;
}

/**
 * True when text is solely a Gemini call expression (optional `print(...)`
 * wrapper) — not prose that merely mentions `bash(...)`.
 */
export function isStandaloneGeminiCallExpression(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	let body = trimmed;
	const printHead = /^print\s*\(/i.exec(body);
	if (printHead) {
		const open = printHead[0].length - 1;
		const close = matchParen(body, open);
		if (close === -1) return false;
		if (body.slice(close + 1).trim()) return false;
		body = body.slice(open + 1, close).trim();
	}
	const callHead = /^(?:default_api\.)?[A-Za-z_]\w*\s*\(/.exec(body);
	if (!callHead) return false;
	const openIdx = body.indexOf("(", callHead[0].length - 1);
	const closeIdx = matchParen(body, openIdx);
	if (closeIdx === -1) return false;
	return body.slice(closeIdx + 1).trim().length === 0;
}

/** Body of a sole ```tool_code fence, or undefined when prose surrounds it. */
function stripSoleToolCodeFence(text: string): string | undefined {
	const trimmed = text.trim();
	const fenced = /^```tool_code\s*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(trimmed);
	return fenced?.[1]?.trim();
}

/**
 * True when accumulated assistant text still looks like a JSON / tool_code
 * fallback that end-of-stream promotion may convert into a tool call. Used to
 * keep those deltas buffered so ACP never sees the raw dump before promotion.
 */
export function looksLikePromotableToolText(text: string): boolean {
	const t = text.trim();
	if (!t) return false;
	if (t.startsWith("{")) return true;
	// Labeled fences use a word boundary; unlabeled ```\n{ has no \b between `
	// and newline, but stripMarkdownFence still promotes those at end-of-stream.
	if (/^```(?:json|jsonc|javascript|js|tool_code)\b/i.test(t)) return true;
	if (/^```(?:\s|$|\{)/i.test(t)) return true;
	// Incomplete unfenced call still streaming, or a complete standalone call.
	if (/^(?:print\s*\(\s*)?(?:default_api\.)?[A-Za-z_]\w*\s*\(/.test(t)) return true;
	return false;
}

/**
 * Hold flush for text that is still an undecided promotion candidate: empty /
 * whitespace, an incomplete fence opener (` / `` / ``` / ```json), or a
 * classified promotable dump. Ordinary prose returns false so live text can flush.
 */
export function shouldHoldPromotableToolText(text: string): boolean {
	if (looksLikePromotableToolText(text)) return true;
	const t = text.trim();
	if (!t) return true;
	if (/^`{1,3}(?:json|jsonc|javascript|js|tool_code)?$/i.test(t)) return true;
	return false;
}

/**
 * Promote Gemini ```tool_code / default_api.bash(...) dumps that sand leaves
 * as thinking or text instead of toolCallPart (gemini-3-flash empty-body).
 * Returns every advertised call in the fence (parallel tool_code expressions).
 */
export function parseGeminiInbandToolCalls(text: string, advertisedNames: Iterable<string>): JsonTextToolCall[] {
	const advertised = advertisedNames instanceof Set ? advertisedNames : new Set(advertisedNames);
	if (advertised.size === 0) return [];
	const trimmed = text.trim();
	if (!trimmed) return [];
	const fencedBody = stripSoleToolCodeFence(trimmed);
	const body = fencedBody !== undefined ? fencedBody : isStandaloneGeminiCallExpression(trimmed) ? trimmed : undefined;
	if (body === undefined) return [];
	const scanned = `\`\`\`tool_code\n${body}\n\`\`\``;
	const scanner = new GeminiInbandScanner({ parseThinking: true });
	const events = [...scanner.feed(scanned), ...scanner.flush()];
	const out: JsonTextToolCall[] = [];
	for (const event of events) {
		if (event.type !== "toolEnd") continue;
		const name = resolveAdvertisedName(event.name, advertised);
		if (!name) continue;
		const args = asArgsObject(event.arguments);
		if (!args) continue;
		out.push({ name, arguments: args });
	}
	return out;
}

/** First advertised Gemini in-band call, or undefined when none. */
export function parseGeminiInbandToolCall(
	text: string,
	advertisedNames: Iterable<string>,
): JsonTextToolCall | undefined {
	return parseGeminiInbandToolCalls(text, advertisedNames)[0];
}

function blockTextForJsonPromotion(block: { type: string; text?: string; thinking?: string }): string | undefined {
	if (block.type === "text" && typeof block.text === "string") return block.text;
	if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
	return undefined;
}

function parsePromotableToolCallsFromText(
	text: string,
	advertisedNames: Iterable<string>,
): JsonTextToolCall[] {
	const promotedJson = parseJsonTextToolCall(text, advertisedNames);
	if (promotedJson) return [promotedJson];
	return parseGeminiInbandToolCalls(text, advertisedNames);
}

/**
 * Prefer promoting individual non-excluded text/thinking blocks so ordinary
 * reasoning prose before a JSON dump does not poison the candidate. Accumulate
 * calls across every eligible block (parallel one-call-per-block dumps) before
 * falling back to the joined assistant text for thought-only / split dumps.
 */
export function promoteJsonTextToolCallsFromContent(
	content: ReadonlyArray<{ type: string; text?: string; thinking?: string }>,
	advertisedNames: Iterable<string>,
	excludeIndexes?: ReadonlySet<number>,
): JsonTextToolCall[] {
	const collected: JsonTextToolCall[] = [];
	for (let i = 0; i < content.length; i++) {
		if (excludeIndexes?.has(i)) continue;
		const block = content[i];
		if (!block) continue;
		const text = blockTextForJsonPromotion(block);
		if (!text?.trim()) continue;
		const promoted = parsePromotableToolCallsFromText(text, advertisedNames);
		if (promoted.length > 0) collected.push(...promoted);
	}
	if (collected.length > 0) return collected;
	const combined = assistantTextForJsonPromotion(content, excludeIndexes);
	if (!combined.trim()) return [];
	return parsePromotableToolCallsFromText(combined, advertisedNames);
}
