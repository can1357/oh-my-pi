/**
 * The panel's reading of a session snapshot: user cards, replies, and Claude-style step groups. Tool calls between
 * two pieces of prose form one group (“4 steps”) instead of a stack of cards.
 */
import type { ActiveTool } from "@oh-my-pi/collab-web/src/lib/client";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import {
	type AssistantMessage,
	COLLAB_PROMPT_MESSAGE_TYPE,
	type ImageContent,
	type SessionEntry,
	type TextContent,
	type ToolResultMessage,
} from "@oh-my-pi/pi-wire";
import { describeStep, type StepDescription } from "./describe";
import type { PanelSnapshot } from "./session";
import { parsePrompt, type TabRef } from "./tab-context";

/** One tool call in a step group. */
export interface Step {
	id: string;
	name: string;
	args: unknown;
	intent: string | undefined;
	result: ToolResultMessage | undefined;
	running: boolean;
	partialResult: unknown;
	description: StepDescription;
}

/** A thought the model had between two tool calls, shown as a quiet row inside the group. */
export interface Thought {
	id: string;
	thought: string;
	redacted: boolean;
}

/** One thing the transcript renders. */
export type TimelineItem =
	| {
			kind: "user";
			key: string;
			/** What the user typed, without the tab context block. */
			text: string;
			tabs: TabRef[];
			images: ImageContent[];
			/** Guest name for prompts sent through a collab room. */
			from: string | null;
	  }
	| { kind: "reply"; key: string; text: string; streaming: boolean }
	| { kind: "thinking"; key: string; text: string; redacted: boolean }
	| { kind: "steps"; key: string; rows: (Step | Thought)[]; stepCount: number; running: boolean }
	| { kind: "stopped"; key: string; reason: "error" | "aborted"; message: string | undefined }
	| { kind: "divider"; key: string; label: string; detail: string | undefined }
	| { kind: "marker"; key: string; label: string }
	| { kind: "custom"; key: string; customType: string; text: string };

/** Narrow a group row to a tool step. */
export function isStep(row: Step | Thought): row is Step {
	return "name" in row;
}

function splitContent(content: string | readonly (TextContent | ImageContent)[]): {
	text: string;
	images: ImageContent[];
} {
	if (typeof content === "string") return { text: content, images: [] };
	const texts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of content) {
		if (block.type === "text") texts.push(block.text);
		else if (block.type === "image") images.push(block);
	}
	return { text: texts.join("\n"), images };
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(Math.round(tokens));
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens >= 100_000 ? 0 : 1)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

type StepGroup = Extract<TimelineItem, { kind: "steps" }>;

class Builder {
	items: TimelineItem[] = [];
	#group: StepGroup | null = null;

	constructor(
		readonly results: ReadonlyMap<string, ToolResultMessage>,
		readonly active: ReadonlyMap<string, ActiveTool>,
	) {}

	/** A copy that can take more items without touching this one; the open group is the only object both would mutate. */
	fork(): Builder {
		const copy = new Builder(this.results, this.active);
		copy.items = [...this.items];
		const open = this.#group;
		if (open !== null) {
			const group: StepGroup = { ...open, rows: [...open.rows] };
			copy.items[copy.items.indexOf(open)] = group;
			copy.#group = group;
		}
		return copy;
	}

	closeGroup(): void {
		this.#group = null;
	}

	push(item: TimelineItem): void {
		this.closeGroup();
		this.items.push(item);
	}

	/** Whether the conversation has its first user turn yet. */
	#started(): boolean {
		return this.items.some(item => item.kind === "user");
	}

	#openGroup(key: string): StepGroup {
		if (this.#group === null) {
			this.#group = { kind: "steps", key: `steps-${key}`, rows: [], stepCount: 0, running: false };
			this.items.push(this.#group);
		}
		return this.#group;
	}

	step(id: string, name: string, args: unknown, intent: string | undefined, pending: boolean): void {
		const act = this.active.get(id);
		const result = this.results.get(id);
		const running = result === undefined && (act !== undefined || pending);
		const group = this.#openGroup(id);
		const effectiveArgs = act?.args ?? args;
		const effectiveIntent = intent ?? act?.intent;
		group.rows.push({
			id,
			name,
			args: effectiveArgs,
			intent: effectiveIntent,
			result,
			running,
			partialResult: act?.partialResult,
			description: describeStep(name, effectiveArgs, effectiveIntent),
		});
		group.stepCount++;
		if (running) group.running = true;
	}

	assistant(message: AssistantMessage, key: string, pending: boolean): void {
		message.content.forEach((block, index) => {
			switch (block.type) {
				case "thinking":
				case "redactedThinking": {
					const text = block.type === "thinking" ? block.thinking : "";
					const redacted = block.type === "redactedThinking";
					if (!redacted && text.trim() === "") break;
					// A thought between tool calls stays in the group; breaking the group there would cut one chapter in two.
					if (this.#group !== null) this.#group.rows.push({ id: `${key}-t${index}`, thought: text, redacted });
					else this.items.push({ kind: "thinking", key: `${key}-t${index}`, text, redacted });
					break;
				}
				case "text":
					if (block.text.trim() === "") break;
					this.push({ kind: "reply", key: `${key}-r${index}`, text: block.text, streaming: pending });
					break;
				case "toolCall":
					this.step(block.id, block.name, block.arguments, block.intent, pending);
					break;
				default:
					break;
			}
		});
		const stop = message.stopReason;
		if (!pending && (stop === "error" || stop === "aborted"))
			this.push({ kind: "stopped", key: `${key}-stop`, reason: stop, message: message.errorMessage });
	}

	entry(entry: SessionEntry): void {
		switch (entry.type) {
			case "message": {
				const message = entry.message;
				if (message.role === "user") {
					const { text, images } = splitContent(message.content);
					const parsed = parsePrompt(text);
					this.push({ kind: "user", key: entry.id, text: parsed.text, tabs: parsed.tabs, images, from: null });
				} else if (message.role === "assistant") {
					this.assistant(message, entry.id, false);
				}
				break;
			}
			case "custom_message": {
				const { text, images } = splitContent(entry.content);
				if (entry.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
					const parsed = parsePrompt(text);
					const from =
						isRecord(entry.details) && typeof entry.details.from === "string" ? entry.details.from : null;
					this.push({ kind: "user", key: entry.id, text: parsed.text, tabs: parsed.tabs, images, from });
				} else if (entry.display) {
					this.push({ kind: "custom", key: entry.id, customType: entry.customType, text });
				}
				break;
			}
			case "compaction":
				this.push({
					kind: "divider",
					key: entry.id,
					label: `context compacted · ${formatTokens(entry.tokensBefore)} tokens`,
					detail: entry.shortSummary ?? entry.summary,
				});
				break;
			case "branch_summary":
				this.push({ kind: "divider", key: entry.id, label: "branch summary", detail: entry.summary });
				break;
			// A session opens by recording its model and thinking level; only later switches are news.
			case "model_change":
				if (this.#started()) this.items.push({ kind: "marker", key: entry.id, label: `model → ${entry.model}` });
				break;
			case "thinking_level_change":
				if (this.#started()) {
					this.items.push({ kind: "marker", key: entry.id, label: `thinking → ${entry.thinkingLevel ?? "off"}` });
				}
				break;
			default:
				// Entry types from a newer host: skip.
				break;
		}
	}
}

/** The committed part of a transcript; rebuilt only when entries or running tools change, not per streamed token. */
export interface TimelineBase {
	readonly builder: Builder;
	/** Tool call ids that already have a committed call block. */
	readonly committed: ReadonlySet<string>;
}

/** Items for every committed entry of the session. */
export function buildCommitted(snapshot: Pick<PanelSnapshot, "entries" | "activeTools">): TimelineBase {
	const results = new Map<string, ToolResultMessage>();
	const committed = new Set<string>();
	for (const entry of snapshot.entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "toolResult") results.set(entry.message.toolCallId, entry.message);
		else if (entry.message.role === "assistant") {
			for (const block of entry.message.content) if (block.type === "toolCall") committed.add(block.id);
		}
	}
	const builder = new Builder(results, snapshot.activeTools);
	for (const entry of snapshot.entries) builder.entry(entry);
	return { builder, committed };
}

/** Everything the transcript shows: the committed items plus the streaming ghost and early-started tools. */
export function buildTimeline(
	base: TimelineBase,
	snapshot: Pick<PanelSnapshot, "stream" | "streamDone" | "activeTools">,
): TimelineItem[] {
	const stream = snapshot.stream;
	const calls = stream === null ? [] : stream.content.filter(block => block.type === "toolCall");
	// The ghost is held until its entry lands; skip it once every tool call it carries is committed.
	const ghost =
		stream !== null && !(snapshot.streamDone && calls.length > 0 && calls.every(call => base.committed.has(call.id)));
	const known = new Set(base.committed);
	if (ghost) for (const call of calls) known.add(call.id);
	const early = [...snapshot.activeTools.values()].filter(tool => !known.has(tool.toolCallId));
	if (!ghost && early.length === 0) return base.builder.items;
	const builder = base.builder.fork();
	if (ghost && stream !== null) builder.assistant(stream, "stream", !snapshot.streamDone);
	// Tools that started before their call block reached us.
	for (const tool of early) builder.step(tool.toolCallId, tool.toolName, tool.args, tool.intent, true);
	return builder.items;
}

/** The live verb for the working row and the page tag: the newest running tool, else what the model is doing. */
export function liveVerb(snapshot: Pick<PanelSnapshot, "activeTools" | "stream" | "streamDone" | "uiRequest">): string {
	if (snapshot.uiRequest !== null) return "Waiting for your answer";
	let newest: ActiveTool | null = null;
	for (const tool of snapshot.activeTools.values()) {
		if (newest === null || tool.startedAt >= newest.startedAt) newest = tool;
	}
	if (newest !== null) return describeStep(newest.toolName, newest.args, newest.intent).live;
	const stream = snapshot.stream;
	if (stream !== null && !snapshot.streamDone) {
		const last = stream.content[stream.content.length - 1];
		if (last?.type === "toolCall") return describeStep(last.name, last.arguments, last.intent).live;
		if (last?.type === "text") return "Writing";
	}
	return "Thinking";
}

/** What the user last typed in this conversation (without the tab context block), from any participant. */
export function lastUserPrompt(entries: readonly SessionEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const content =
			entry.type === "message" && entry.message.role === "user"
				? entry.message.content
				: entry.type === "custom_message" && entry.customType === COLLAB_PROMPT_MESSAGE_TYPE
					? entry.content
					: null;
		if (content === null) continue;
		const text = parsePrompt(splitContent(content).text).text;
		if (text !== "") return text;
	}
	return null;
}

/** Images of a tool result, in order. */
export function resultImages(result: ToolResultMessage | undefined): ImageContent[] {
	return result === undefined ? [] : result.content.filter(block => block.type === "image");
}

/** First 60 characters of a failed step's error text. */
export function resultError(result: ToolResultMessage | undefined): string | null {
	if (result === undefined || !result.isError) return null;
	const text = result.content
		.map(block => (block.type === "text" ? block.text : ""))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** `data:` URL for a wire image. */
export function imageSrc(image: ImageContent): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

/** The conversation as Markdown: prompts, replies, and one line per step. */
export function transcriptMarkdown(items: readonly TimelineItem[]): string {
	const out: string[] = [];
	for (const item of items) {
		switch (item.kind) {
			case "user": {
				const tabs = item.tabs.map(tab => `> Tab: [${tab.title || tab.url}](${tab.url})`);
				out.push(["## You", ...tabs, item.text].filter(part => part !== "").join("\n\n"));
				break;
			}
			case "reply":
				out.push(item.text.trim());
				break;
			case "steps":
				out.push(
					item.rows
						.filter(isStep)
						.map(step => `- ${step.result?.isError ? "✗" : "✓"} ${step.description.done}`)
						.join("\n"),
				);
				break;
			case "stopped":
				out.push(`_${item.reason}${item.message ? `: ${item.message}` : ""}_`);
				break;
			case "divider":
				out.push(`---\n\n_${item.label}_`);
				break;
			default:
				break;
		}
	}
	return `${out.filter(part => part !== "").join("\n\n")}\n`;
}
