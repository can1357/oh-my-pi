/**
 * Session-rebuild context maintenance for the compaction benchmark ("fresh start").
 *
 * Instead of summarizing, the session is rebuilt: the task message, one pointer
 * message naming an on-disk markdown transcript of every archived turn (each
 * tool output and every large tool-call argument stored as its own file the
 * transcript links to), then the turns that stay verbatim. The runner applies
 * it whenever a request reaches the threshold, so the archive grows across
 * resets and the transcript always covers everything dropped.
 *
 * Variants (see {@link FreshOptions}):
 * - the recent tail always stays (`tailChars`);
 * - `index` lists every archived turn in one line inside the pointer message;
 * - `keep` scores older turns (e.g. a Jev judge, `jev.ts`) and keeps the most
 *   probable ones verbatim, in session order, within `keep.budgetChars`.
 *
 * Example (not runnable here):
 *   const fresh = new FreshStart({ threshold: 300_000, tailChars: 80_000, index: false });
 *   const build = await fresh.rebuild(await Bun.file(sessionPath).text());
 *   // write build.sessionJsonl + build.files, then `omp --resume <new file>`
 */
import { prompt } from "@oh-my-pi/pi-utils";
import { applyEntryPatches } from "@oh-my-pi/pi-utils/entry-patches";
import pointerPrompt from "./prompts/fresh-pointer.md" with { type: "text" };

/** Where the archive lives inside the task container (outside `/workspace`, so it is never packed). */
export const HISTORY_DIR = "/home/agent/history";
const TRANSCRIPT = "transcript.md";
/** Tool-call arguments up to this size stay inline in the transcript. */
const INLINE_ARGS_CHARS = 1_500;
const INDEX_LINE_CHARS = 100;
/** Tool outputs in scorer-kept turns are clipped to this many characters; the full text stays archived. */
const KEPT_OUTPUT_CHARS = 3_000;
/** Length of {@link TurnCandidate.brief}. */
export const BRIEF_CHARS = 400;

interface ContentBlock {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

interface SessionMessage {
	role: string;
	content: string | ContentBlock[];
	stopReason?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

/** One line of an omp session JSONL file (fields this module reads or rewrites). */
interface SessionEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: SessionMessage;
	content?: unknown;
	customType?: string;
}

/**
 * One older turn offered to a {@link KeepScorer}: an assistant message with the
 * tool results and notices that follow it, rendered compactly for a judge.
 */
export interface TurnCandidate {
	/** Compact text of the turn: assistant text, tool calls, and (truncated) outputs. */
	digest: string;
	/** One- or two-line summary (≤ {@link BRIEF_CHARS}) for rankers that score many turns in one request. */
	brief: string;
	/** Size of the turn once slimmed for keeping, in characters (what keeping it costs). */
	chars: number;
}

/** Probability, per candidate, that the turn should stay verbatim; same order as `candidates`. */
export type KeepScorer = (candidates: TurnCandidate[], context: { task: string; recent: string }) => Promise<number[]>;

/** Rebuild policy. */
export interface FreshOptions {
	/** Request size (tokens) at which the runner rebuilds the session. */
	threshold: number;
	/** Recent tail kept verbatim, in characters of session entries (at least one turn). */
	tailChars: number;
	/** List every archived turn in one line inside the pointer message. */
	index: boolean;
	/**
	 * Keep older turns the scorer rates at or above `minProbability`, most probable first, within
	 * `budgetChars`. Kept turns are slimmed: large tool-call arguments and long tool outputs are
	 * archived and replaced by a clipped copy that names the archive file.
	 */
	keep?: { score: KeepScorer; budgetChars: number; minProbability: number };
}

/** A rebuilt session plus the archive files to place under {@link HISTORY_DIR}. */
export interface FreshBuild {
	sessionFile: string;
	sessionJsonl: string;
	/** Archive files keyed by path relative to {@link HISTORY_DIR}. */
	files: Map<string, string>;
	/** Entries archived so far, across every reset. */
	archivedItems: number;
	/** Older turns kept verbatim by the scorer in this rebuild. */
	selectedTurns: number;
	tailItems: number;
}

/** Stateful rebuilder: archived entries accumulate across successive resets. */
export class FreshStart {
	readonly threshold: number;
	readonly #options: FreshOptions;
	readonly #archived: SessionEntry[] = [];
	readonly #pointerIds = new Set<string>();
	/** Archive file names per entry id (or `entryId:toolCallId`), assigned once so links stay stable. */
	readonly #files = new Map<string, string>();
	readonly #fileContents = new Map<string, string>();

	constructor(options: FreshOptions) {
		this.threshold = options.threshold;
		this.#options = options;
	}

	/**
	 * Archive all but the recent tail (and any scorer-kept turns) of `jsonl` and
	 * return the rebuilt session.
	 *
	 * Throws when the session has no task message or no complete turn to keep,
	 * or when the scorer fails.
	 */
	async rebuild(jsonl: string): Promise<FreshBuild> {
		const entries = jsonl
			.split("\n")
			.filter(line => line.length > 0)
			.map(line => JSON.parse(line) as SessionEntry);
		// The conversation as the session holds it: an elide pass's placeholders in place of what they shortened.
		applyEntryPatches(entries);
		const modelChange = entries.find(entry => entry.type === "model_change");
		const thinking = entries.find(entry => entry.type === "thinking_level_change");
		const task = entries.find(entry => entry.type === "message" && entry.message?.role === "user");
		if (!task?.id) throw new Error("session has no task message");

		// Conversation after the task, minus earlier pointers and injected reminders.
		const items = closedPrefix(
			entries.filter(
				entry =>
					(entry.type === "message" || entry.type === "custom_message") &&
					entry !== task &&
					!(entry.id && this.#pointerIds.has(entry.id)),
			),
		);
		const tailStart = this.#tailStart(items);
		if (tailStart >= items.length) throw new Error("session has no complete turn to keep");
		const tail = items.slice(tailStart);
		const groups = groupTurns(items.slice(0, tailStart));
		const { selected, slim } = await this.#select(groups, textOf(task.message?.content), tail);

		const kept: SessionEntry[] = [];
		const archivedNow: SessionEntry[] = [];
		for (let index = 0; index < groups.length; index++) {
			const slimmed = slim.get(index);
			if (slimmed) kept.push(...slimmed);
			else archivedNow.push(...groups[index]!);
		}
		this.#archived.push(...archivedNow);
		for (const entry of archivedNow) this.#archiveFiles(entry);

		const files = new Map(this.#fileContents);
		files.set(TRANSCRIPT, this.#renderTranscript());

		const sessionId = Bun.randomUUIDv7();
		const now = new Date();
		const pointerId = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
		this.#pointerIds.add(pointerId);
		const pointer: SessionEntry = {
			type: "message",
			id: pointerId,
			parentId: null,
			timestamp: now.toISOString(),
			message: {
				role: "user",
				content: [
					{
						type: "text",
						text: prompt.render(pointerPrompt, {
							archivedTurns: this.#archived.filter(entry => entry.message?.role === "assistant").length,
							transcript: `${HISTORY_DIR}/${TRANSCRIPT}`,
							dir: HISTORY_DIR,
							selected: selected.size > 0,
							index: this.#options.index ? this.#renderIndex() : "",
						}),
					},
				],
			},
		};
		const chain = [modelChange, thinking, task, pointer, ...kept, ...tail].filter(
			(entry): entry is SessionEntry => entry !== undefined,
		);
		const lines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: now.toISOString(),
				cwd: "/workspace",
			}),
		];
		let parentId: string | null = null;
		for (const entry of chain) {
			lines.push(JSON.stringify({ ...entry, parentId }));
			parentId = entry.id ?? parentId;
		}
		return {
			sessionFile: `${now.toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
			sessionJsonl: `${lines.join("\n")}\n`,
			files,
			archivedItems: this.#archived.length,
			selectedTurns: selected.size,
			tailItems: tail.length,
		};
	}

	/**
	 * Group indices the scorer keeps (probable enough, most probable first, within the budget)
	 * and their slimmed entries.
	 */
	async #select(
		groups: SessionEntry[][],
		task: string,
		tail: SessionEntry[],
	): Promise<{ selected: Set<number>; slim: Map<number, SessionEntry[]> }> {
		const keep = this.#options.keep;
		const selected = new Set<number>();
		const slim = new Map<number, SessionEntry[]>();
		if (!keep) return { selected, slim };
		const candidates: number[] = [];
		for (let index = 0; index < groups.length; index++) {
			if (groups[index]![0]!.message?.role === "assistant") candidates.push(index);
		}
		if (candidates.length === 0) return { selected, slim };
		const slimmed = candidates.map(index => groups[index]!.map(entry => this.#slim(entry)));
		const sizes = slimmed.map(entries => entryChars(entries));
		const probabilities = await keep.score(
			candidates.map((index, position) => ({
				digest: digestTurn(groups[index]!),
				brief: briefTurn(groups[index]!),
				chars: sizes[position]!,
			})),
			{
				task: task.slice(0, 2_000),
				recent: tail
					.map(entry => digestEntry(entry))
					.join("\n")
					.slice(-8_000),
			},
		);
		const order = candidates
			.map((_, position) => position)
			.filter(position => probabilities[position]! >= keep.minProbability)
			.sort((a, b) => probabilities[b]! - probabilities[a]!);
		let budget = keep.budgetChars;
		for (const position of order) {
			if (sizes[position]! > budget) continue;
			budget -= sizes[position]!;
			selected.add(candidates[position]!);
			slim.set(candidates[position]!, slimmed[position]!);
		}
		return { selected, slim };
	}

	/**
	 * A copy of `entry` cheap enough to keep: oversized tool-call arguments become a reference to
	 * their archive file (plus the call's path, if any) and long tool outputs are clipped with a
	 * pointer to the full archived text. Registers those archive files.
	 */
	#slim(entry: SessionEntry): SessionEntry {
		const message = entry.message;
		if (!message || typeof message.content === "string") return entry;
		this.#archiveFiles(entry);
		if (message.role === "toolResult") {
			const text = textOf(message.content);
			const file = this.#files.get(entry.id ?? "");
			if (text.length <= KEPT_OUTPUT_CHARS || !file) return entry;
			return {
				...entry,
				message: {
					...message,
					content: [
						{ type: "text", text: `${clip(text, KEPT_OUTPUT_CHARS)}\n[full output: ${HISTORY_DIR}/${file}]` },
					],
				},
			};
		}
		if (message.role !== "assistant") return entry;
		return {
			...entry,
			message: {
				...message,
				content: message.content.map(block => {
					const file = block.type === "toolCall" ? this.#files.get(`${entry.id}:${block.id}`) : undefined;
					if (!file) return block;
					const target = keyArgument(block.arguments);
					return {
						...block,
						arguments: { archivedArguments: `${HISTORY_DIR}/${file}`, ...(target && { target }) },
					};
				}),
			},
		};
	}

	/** Index where the kept tail starts: the latest assistant message whose suffix fits `tailChars` (at least one). */
	#tailStart(items: SessionEntry[]): number {
		let chars = 0;
		let start = items.length;
		for (let index = items.length - 1; index >= 0; index--) {
			chars += entryChars([items[index]!]);
			if (items[index]!.message?.role !== "assistant") continue;
			if (chars > this.#options.tailChars && start < items.length) break;
			start = index;
		}
		return start;
	}

	/** Assign archive files for an entry's tool output and oversized tool-call arguments. */
	#archiveFiles(entry: SessionEntry): void {
		const message = entry.message;
		if (!message || !entry.id) return;
		if (message.role === "toolResult") {
			if (this.#files.has(entry.id)) return;
			const name = `tool-outputs/${String(this.#files.size + 1).padStart(5, "0")}-${slug(message.toolName ?? "tool")}.txt`;
			this.#files.set(entry.id, name);
			this.#fileContents.set(name, textOf(message.content));
			return;
		}
		if (message.role !== "assistant" || typeof message.content === "string") return;
		for (const block of message.content) {
			if (block.type !== "toolCall" || !block.id || this.#files.has(`${entry.id}:${block.id}`)) continue;
			const args = JSON.stringify(block.arguments ?? {}, null, 2);
			if (args.length <= INLINE_ARGS_CHARS) continue;
			const name = `tool-calls/${String(this.#files.size + 1).padStart(5, "0")}-${slug(block.name ?? "tool")}.json`;
			this.#files.set(`${entry.id}:${block.id}`, name);
			this.#fileContents.set(name, args);
		}
	}

	#renderTranscript(): string {
		const out = [
			"# Session transcript (archived turns)",
			"",
			"Every message moved out of your context, in the order it was archived. Thinking is omitted; tool outputs and large tool-call arguments are separate files linked below.",
			"",
		];
		let turn = 0;
		for (const entry of this.#archived) {
			const message = entry.message;
			if (!message) {
				out.push("## Notice", "", textOf(entry.content), "");
				continue;
			}
			if (message.role === "user") {
				out.push("## User", "", textOf(message.content), "");
			} else if (message.role === "assistant") {
				turn++;
				out.push(`## Assistant · turn ${turn}`, "");
				if (typeof message.content === "string") {
					out.push(message.content, "");
					continue;
				}
				for (const block of message.content) {
					if (block.type === "text" && block.text?.trim()) out.push(block.text, "");
					if (block.type !== "toolCall") continue;
					const file = this.#files.get(`${entry.id}:${block.id}`);
					out.push(
						file
							? `**${block.name}** → arguments: [${file}](${file})`
							: `**${block.name}**\n\`\`\`json\n${JSON.stringify(block.arguments ?? {}, null, 2)}\n\`\`\``,
						"",
					);
				}
			} else if (message.role === "toolResult") {
				const file = this.#files.get(entry.id ?? "");
				const lines = textOf(message.content).split("\n").length;
				out.push(
					`→ ${message.toolName} output${message.isError ? " (error)" : ""}, ${lines} lines: [${file}](${file})`,
					"",
				);
			}
		}
		return out.join("\n");
	}

	/** One line per archived assistant turn, numbered as in the transcript's headings. */
	#renderIndex(): string {
		const lines: string[] = [];
		const errors = new Set<string>();
		for (const entry of this.#archived) {
			if (entry.message?.role === "toolResult" && entry.message.isError && entry.message.toolCallId) {
				errors.add(entry.message.toolCallId);
			}
		}
		let turn = 0;
		for (const entry of this.#archived) {
			const message = entry.message;
			if (message?.role !== "assistant") continue;
			turn++;
			const parts: string[] = [];
			if (typeof message.content === "string") {
				parts.push(oneLine(message.content));
			} else {
				for (const block of message.content) {
					if (block.type === "toolCall") {
						parts.push(
							`${block.name}(${oneLine(keyArgument(block.arguments))})${block.id && errors.has(block.id) ? " ✗" : ""}`,
						);
					}
				}
				if (parts.length === 0) {
					const text = message.content.find(block => block.type === "text")?.text;
					if (text) parts.push(oneLine(text));
				}
			}
			lines.push(`- t${turn}: ${parts.join("; ")}`.slice(0, INDEX_LINE_CHARS));
		}
		return lines.join("\n");
	}
}

/** Split conversation items into turns: each assistant or user message starts a new group. */
function groupTurns(items: SessionEntry[]): SessionEntry[][] {
	const groups: SessionEntry[][] = [];
	for (const entry of items) {
		const role = entry.message?.role;
		if (role === "assistant" || role === "user" || groups.length === 0) groups.push([entry]);
		else groups.at(-1)!.push(entry);
	}
	return groups;
}

/**
 * Drop a trailing incomplete turn: an aborted/errored assistant message, or tool
 * calls without results (the runner interrupts omp between turns, which can cut
 * one off).
 */
function closedPrefix(items: SessionEntry[]): SessionEntry[] {
	const pending = new Set<string>();
	let closed = 0;
	for (let index = 0; index < items.length; index++) {
		const message = items[index]!.message;
		if (message?.role === "assistant") {
			if (message.stopReason === "aborted" || message.stopReason === "error") break;
			if (typeof message.content !== "string") {
				for (const block of message.content) if (block.type === "toolCall" && block.id) pending.add(block.id);
			}
		} else if (message?.role === "toolResult" && message.toolCallId) {
			pending.delete(message.toolCallId);
		}
		if (pending.size === 0) closed = index + 1;
	}
	return items.slice(0, closed);
}

/**
 * Characters the model sees for `entries`: text, thinking, tool-call arguments, and tool output.
 * Stored-only fields (provider payloads, usage, snapshots) do not count.
 */
function entryChars(entries: SessionEntry[]): number {
	let chars = 0;
	for (const entry of entries) {
		const content = entry.message?.content ?? entry.content;
		if (typeof content === "string") {
			chars += content.length;
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content as (ContentBlock & { thinking?: string })[]) {
			if (block.type === "toolCall") chars += JSON.stringify(block.arguments ?? {}).length;
			else chars += (block.text ?? block.thinking ?? "").length;
		}
	}
	return chars;
}

/** Compact text of one turn for a judge: assistant text, tool calls, and truncated outputs. */
function digestTurn(group: SessionEntry[]): string {
	return group
		.map(entry => digestEntry(entry))
		.join("\n")
		.slice(0, 6_000);
}
/** Short summary of a turn: its tool calls (name and key argument), note, and first output line. */
function briefTurn(group: SessionEntry[]): string {
	const parts: string[] = [];
	for (const entry of group) {
		const message = entry.message;
		if (!message) continue;
		if (message.role === "toolResult") {
			const first = textOf(message.content).trim().split("\n", 1)[0] ?? "";
			parts.push(`→ ${message.isError ? "error: " : ""}${oneLine(first)}`);
		} else if (typeof message.content === "string") {
			parts.push(oneLine(message.content));
		} else {
			for (const block of message.content) {
				if (block.type === "text" && block.text?.trim()) parts.push(oneLine(block.text));
				if (block.type === "toolCall") parts.push(`${block.name}(${oneLine(keyArgument(block.arguments))})`);
			}
		}
	}
	return parts.join(" ").slice(0, BRIEF_CHARS);
}

function digestEntry(entry: SessionEntry): string {
	const message = entry.message;
	if (!message) return `[notice] ${clip(textOf(entry.content), 800)}`;
	if (message.role === "toolResult") {
		return `[${message.toolName} output${message.isError ? ", error" : ""}] ${clip(textOf(message.content), 1_500)}`;
	}
	if (message.role === "user") return `[user] ${clip(textOf(message.content), 1_000)}`;
	if (typeof message.content === "string") return `[assistant] ${clip(message.content, 1_500)}`;
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text" && block.text?.trim()) parts.push(`[assistant] ${clip(block.text, 1_500)}`);
		if (block.type === "toolCall")
			parts.push(`[call ${block.name}] ${clip(JSON.stringify(block.arguments ?? {}), 1_500)}`);
	}
	return parts.join("\n");
}

/** Keep the head and tail of long text. */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const half = Math.floor(max / 2);
	return `${text.slice(0, half)} … [${text.length - max} chars] … ${text.slice(-half)}`;
}

/** The argument that identifies a tool call: a path, command, or pattern. */
function keyArgument(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const key of ["path", "command", "pattern", "file", "query"]) {
		if (typeof record[key] === "string") return record[key];
	}
	return "";
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: ContentBlock) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`))
		.join("\n");
}

function slug(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40);
}
