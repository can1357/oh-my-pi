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

/** Resolves tool calls against live tool definitions and the session cwd. */
export class TtsrToolInspector {
	readonly #tools: () => readonly TtsrTool[];
	readonly #cwd: () => string;

	constructor(tools: () => readonly TtsrTool[], cwd: () => string) {
		this.#tools = tools;
		this.#cwd = cwd;
	}

	/** Match context for a (possibly still streaming) tool call. */
	matchContext(toolCall: ToolCall | undefined, contentIndex: number): TtsrMatchContext {
		const context: TtsrMatchContext = { source: "tool" };
		if (!toolCall) return context;
		context.toolName = toolCall.name;
		context.streamKey = toolCall.id ? `toolcall:${toolCall.id}` : `tool:${toolCall.name}:${contentIndex}`;
		context.filePaths = this.#filePaths(toolCall);
		return context;
	}

	/** Combined reconstructed source snapshot, for tools exposing `matcherDigest`. */
	digest(toolCall: ToolCall | undefined): string | undefined {
		return this.#resolveTool(toolCall)?.matcherDigest?.(toolCall?.arguments ?? {});
	}

	/** Per-file source snapshots, for tools exposing `matcherEntries`. */
	entries(toolCall: ToolCall | undefined): readonly { path: string; digest: string }[] | undefined {
		const entries = this.#resolveTool(toolCall)?.matcherEntries?.(toolCall?.arguments ?? {});
		return entries && entries.length > 0 ? entries : undefined;
	}

	/** Narrows a tool-call context to one touched file with its own stream key. */
	perFileContext(base: TtsrMatchContext, filePath: string): TtsrMatchContext {
		const filePaths = this.#normalizePathCandidates(filePath);
		return {
			...base,
			filePaths: filePaths.length > 0 ? filePaths : [filePath],
			streamKey: base.streamKey ? `${base.streamKey}#${filePath}` : undefined,
		};
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

	#resolveTool(toolCall: ToolCall | undefined): TtsrTool | undefined {
		if (!toolCall) return undefined;
		const tools = this.#tools();
		return (
			tools.find(tool => tool.name === toolCall.name) ??
			tools.find(tool => tool.customWireName !== undefined && tool.customWireName === toolCall.name)
		);
	}

	#filePaths(toolCall: ToolCall): string[] | undefined {
		const args = toolCall.arguments ?? {};
		const toolPaths = this.#resolveTool(toolCall)?.matcherPaths?.(args);
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
