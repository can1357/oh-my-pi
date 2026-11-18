/**
 * How TTSR rules see assistant output: tool-call match contexts (candidate file
 * paths, stream keys), the tools' reconstructed source digests, and completed
 * outputs. Shared by the live {@link TtsrCoordinator} and `/omfg`, which
 * validates generated rules against conversation history the same way.
 */
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { TtsrMatchContext, TtsrOutput } from "../export/ttsr";

/** Tool surface TTSR reads: identity plus the optional matcher hooks. */
export type TtsrTool = Pick<AgentTool, "name" | "customWireName" | "matcherPaths" | "matcherDigest" | "matcherEntries">;

type MatcherEntries = readonly { path: string; digest: string }[];

/** Hook results and context for one arguments object; each `{ value }` is set once computed. */
interface ArgumentsInspection {
	tool: TtsrTool | undefined;
	/**
	 * {@link argumentsLeaves} when inspected. Arguments objects are mutated in
	 * place (streams append, reused calls are rewritten), so reuse requires every
	 * key and value to be unchanged, not just the same object.
	 */
	leaves: readonly unknown[];
	digest?: { value: string | undefined };
	entries?: { value: MatcherEntries | undefined };
	context?: { id: string; name: string; contentIndex: number; cwd: string; value: TtsrMatchContext };
}

/** Past this depth the snapshot stops descending; parsed tool arguments are never this deep. */
const LEAVES_MAX_DEPTH = 32;
const OPEN_OBJECT = Symbol("{");
const OPEN_ARRAY = Symbol("[");
const CLOSE = Symbol("}");
const TRUNCATED = Symbol("…");

/**
 * Every key and primitive value of the arguments tree in walk order, with
 * container markers. Comparing two snapshots value by value catches any change
 * a matcher hook could observe — nested, same-length, or appended — at a cost
 * per value, not per byte: strings compare in constant time unless they are
 * distinct strings of equal length, where a content change still shows up.
 */
function argumentsLeaves(value: unknown, out: unknown[] = [], depth = 0): unknown[] {
	if (value === null || typeof value !== "object") {
		out.push(value);
		return out;
	}
	if (depth >= LEAVES_MAX_DEPTH) {
		out.push(TRUNCATED);
		return out;
	}
	out.push(Array.isArray(value) ? OPEN_ARRAY : OPEN_OBJECT);
	for (const [key, child] of Object.entries(value)) {
		out.push(key);
		argumentsLeaves(child, out, depth + 1);
	}
	out.push(CLOSE);
	return out;
}

function sameLeaves(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) if (!Object.is(a[index], b[index])) return false;
	return true;
}

/** Resolves tool calls against live tool definitions and the session cwd. */
export class TtsrToolInspector {
	readonly #tools: () => readonly TtsrTool[];
	readonly #cwd: () => string;
	/**
	 * Streaming providers re-parse a call's arguments only as its JSON grows, so one
	 * arguments object spans many deltas; hooks are pure in their arguments, so
	 * per-delta lookups reuse the results computed for that object until it changes.
	 */
	readonly #inspections = new WeakMap<object, ArgumentsInspection>();
	/** Per-file contexts derived from one (immutable) base context. */
	readonly #perFileContexts = new WeakMap<TtsrMatchContext, { cwd: string; byPath: Map<string, TtsrMatchContext> }>();

	constructor(tools: () => readonly TtsrTool[], cwd: () => string) {
		this.#tools = tools;
		this.#cwd = cwd;
	}

	/** Match context for a (possibly still streaming) tool call. */
	matchContext(toolCall: ToolCall | undefined, contentIndex: number): TtsrMatchContext {
		if (!toolCall) return { source: "tool" };
		const inspection = this.#inspect(toolCall);
		const { id, name } = toolCall;
		const cwd = this.#cwd();
		const cached = inspection.context;
		if (cached?.id === id && cached.name === name && cached.contentIndex === contentIndex && cached.cwd === cwd) {
			return cached.value;
		}
		const context: TtsrMatchContext = {
			source: "tool",
			toolName: name,
			streamKey: id ? `toolcall:${id}` : `tool:${name}:${contentIndex}`,
			filePaths: this.#filePaths(toolCall, inspection.tool),
		};
		inspection.context = { id, name, contentIndex, cwd, value: context };
		return context;
	}

	/** Combined reconstructed source snapshot, for tools exposing `matcherDigest`. */
	digest(toolCall: ToolCall | undefined): string | undefined {
		if (!toolCall) return undefined;
		const inspection = this.#inspect(toolCall);
		inspection.digest ??= { value: inspection.tool?.matcherDigest?.(toolCall.arguments ?? {}) };
		return inspection.digest.value;
	}

	/** Per-file source snapshots, for tools exposing `matcherEntries`. */
	entries(toolCall: ToolCall | undefined): MatcherEntries | undefined {
		if (!toolCall) return undefined;
		const inspection = this.#inspect(toolCall);
		if (!inspection.entries) {
			const entries = inspection.tool?.matcherEntries?.(toolCall.arguments ?? {});
			inspection.entries = { value: entries && entries.length > 0 ? entries : undefined };
		}
		return inspection.entries.value;
	}

	/** Narrows a tool-call context to one touched file with its own stream key. */
	perFileContext(base: TtsrMatchContext, filePath: string): TtsrMatchContext {
		const cwd = this.#cwd();
		let cache = this.#perFileContexts.get(base);
		if (cache?.cwd !== cwd) {
			cache = { cwd, byPath: new Map() };
			this.#perFileContexts.set(base, cache);
		}
		let context = cache.byPath.get(filePath);
		if (!context) {
			const filePaths = this.#normalizePathCandidates(filePath);
			context = {
				...base,
				filePaths: filePaths.length > 0 ? filePaths : [filePath],
				streamKey: base.streamKey ? `${base.streamKey}#${filePath}` : undefined,
			};
			cache.byPath.set(filePath, context);
		}
		return context;
	}

	/**
	 * Completed outputs of one assistant message: all text as one reply, all
	 * thinking as one reasoning output, and each tool call — split per file when
	 * the tool reports entries, else its digest or serialized arguments.
	 */
	outputs(message: AssistantMessage): TtsrOutput[] {
		const outputs: TtsrOutput[] = [];
		const text: string[] = [];
		const thinking: string[] = [];
		for (const [index, block] of message.content.entries()) {
			if (block.type === "text") text.push(block.text);
			else if (block.type === "thinking") thinking.push(block.thinking);
			else if (block.type === "toolCall") outputs.push(...this.#toolCallOutputs(block, index));
		}
		const reply = text.join("\n\n");
		if (/\S/.test(reply)) outputs.push({ content: reply, context: { source: "text" }, subject: "reply" });
		const reasoning = thinking.join("\n\n");
		if (/\S/.test(reasoning)) {
			outputs.push({ content: reasoning, context: { source: "thinking" }, subject: "reasoning" });
		}
		return outputs;
	}

	#toolCallOutputs(toolCall: ToolCall, contentIndex: number): TtsrOutput[] {
		const context = this.matchContext(toolCall, contentIndex);
		const entries = this.entries(toolCall);
		if (entries) {
			return entries.map(entry => ({
				content: entry.digest,
				context: this.perFileContext(context, entry.path),
				subject: `\`${toolCall.name}\` call on \`${entry.path}\``,
			}));
		}
		const args = toolCall.arguments;
		const content = this.digest(toolCall) ?? (typeof args === "string" ? args : JSON.stringify(args ?? {}));
		const filePath = context.filePaths?.[0];
		const subject = filePath ? `\`${toolCall.name}\` call on \`${filePath}\`` : `\`${toolCall.name}\` call`;
		return [{ content, context, subject }];
	}

	#inspect(toolCall: ToolCall): ArgumentsInspection {
		const tools = this.#tools();
		const tool =
			tools.find(candidate => candidate.name === toolCall.name) ??
			tools.find(candidate => candidate.customWireName !== undefined && candidate.customWireName === toolCall.name);
		const args: unknown = toolCall.arguments;
		if (!isRecord(args)) return { tool, leaves: [] };
		const leaves = argumentsLeaves(args);
		const cached = this.#inspections.get(args);
		if (cached && cached.tool === tool && sameLeaves(cached.leaves, leaves)) return cached;
		const inspection: ArgumentsInspection = { tool, leaves };
		this.#inspections.set(args, inspection);
		return inspection;
	}

	#filePaths(toolCall: ToolCall, tool: TtsrTool | undefined): string[] | undefined {
		const args = toolCall.arguments ?? {};
		const toolPaths = tool?.matcherPaths?.(args);
		if (toolPaths && toolPaths.length > 0) {
			const normalized = toolPaths.flatMap(filePath => this.#normalizePathCandidates(filePath));
			if (normalized.length > 0) return Array.from(new Set(normalized));
		}
		return this.#filePathsFromArgs(args);
	}

	#filePathsFromArgs(args: unknown): string[] | undefined {
		if (!isRecord(args)) return undefined;
		const rawPaths: string[] = [];
		for (const key in args) {
			const value = args[key];
			const normalizedKey = key.toLowerCase();
			if (typeof value === "string" && (normalizedKey === "path" || normalizedKey.endsWith("path"))) {
				rawPaths.push(value);
				continue;
			}
			if (Array.isArray(value) && (normalizedKey === "paths" || normalizedKey.endsWith("paths"))) {
				for (const candidate of value) if (typeof candidate === "string") rawPaths.push(candidate);
			}
		}
		const normalizedPaths = rawPaths.flatMap(filePath => this.#normalizePathCandidates(filePath));
		return normalizedPaths.length === 0 ? undefined : Array.from(new Set(normalizedPaths));
	}

	#normalizePathCandidates(rawPath: string): string[] {
		const trimmed = rawPath.trim();
		if (trimmed.length === 0) return [];
		const normalizedInput = trimmed.replaceAll("\\", "/");
		const candidates = new Set<string>([normalizedInput]);
		if (normalizedInput.startsWith("./")) candidates.add(normalizedInput.slice(2));
		const cwd = this.#cwd();
		const absolutePath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
		candidates.add(absolutePath.replaceAll("\\", "/"));
		const relative = path.relative(cwd, absolutePath).replaceAll("\\", "/");
		if (relative && relative !== "." && !relative.startsWith("../") && relative !== "..") candidates.add(relative);
		return Array.from(candidates);
	}
}
