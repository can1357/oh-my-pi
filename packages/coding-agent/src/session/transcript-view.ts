/**
 * Budgeted transcript views: one transcript rendered as text within a
 * character budget, at a detail chosen per kind of record. `archive.transcript`
 * renders the native scanner's records of a session file
 * ({@link renderTranscriptRecords}); `history://<id>` renders a session's
 * message array, live or loaded ({@link renderTranscriptMessages}), where
 * events outside the user–assistant exchange show as one-line notes.
 *
 * Records group into turns, each opened by a user message; records before the
 * first one form turn 0. Every kind (user, assistant, thinking, call, result)
 * renders at a {@link TranscriptDetail}; back-to-back lookups (`read`, `glob`,
 * `grep`, `find`) group per tool, their paths merged into one tree of shared
 * prefixes. Kinds left to `auto` walk
 * {@link AUTO_LADDER} from whole text toward one-line summaries until the
 * rendering fits; when the tersest rung still overflows, blocks drop from the
 * middle of the conversation outward, agent work before user prompts, and
 * each dropped run leaves a marker counting what it held.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type TranscriptRecord, TranscriptRecordKind } from "@oh-my-pi/pi-natives";
import { formatCount, formatNumber, isRecord } from "@oh-my-pi/pi-utils";
import { cleanTinyMessage, stripAnsi, truncateTinyMessage } from "../tiny/message-preproc";
import { flattenLine } from "@oh-my-pi/pi-tui/text/sanitize";
import { previewLine } from "../utils/render-utils";
import { contentToText, formatHistoryEventLine, formatToolCallPrimaryArg } from "./session-history-format";
import { localMinute, overlapsWindow, type TimeWindow } from "./time-window";

/** A kind of transcript record. */
export type TranscriptKind = "user" | "assistant" | "thinking" | "call" | "result";

/**
 * How much of one kind of record a transcript shows:
 * - `omit`: nothing; a user turn keeps its `#N · time` header.
 * - `brief`: one line. Text loses fenced code and paired tags to placeholders
 *   and is cut from the middle to 200 characters; a call shows its tool,
 *   outcome, and result size, and a run of calls shares one line, counted
 *   per tool.
 * - `normal`: text cleaned the same way and cut to 1,000 characters; a call
 *   adds its main argument, and back-to-back lookups take one line per tool.
 * - `full`: text whole; a call adds its whole JSON arguments.
 */
export type TranscriptDetail = "omit" | "brief" | "normal" | "full";

/** The detail of every kind of record. */
export type TranscriptDetails = Record<TranscriptKind, TranscriptDetail>;

/** Requested detail: one level for every kind, or one per kind; `auto` and absent kinds let the budget choose. */
export type TranscriptDetailRequest =
	| TranscriptDetail
	| "auto"
	| Partial<Record<TranscriptKind, TranscriptDetail | "auto">>;

/** A rendered transcript. */
export interface TranscriptView {
	/** User turns in the whole transcript. */
	turns: number;
	/** Records of the rendered turns. */
	records: number;
	/** Records dropped from the middle to fit the budget. */
	omitted: number;
	/** Detail each kind rendered at. */
	detail: TranscriptDetails;
	/** The rendering, as printed. */
	text: string;
}

/** What a transcript view shows. */
export interface TranscriptViewOptions {
	/** Most characters of the rendering; `Infinity` renders whole at the requested detail. */
	budget: number;
	detail: TranscriptDetailRequest;
	/** One turn or an inclusive range; negative turns count back from the last (`-1`). Every turn when omitted. */
	turns: number | readonly [number, number] | undefined;
	/** Keeps the turns active in it. */
	window: TimeWindow | undefined;
	/** Leads the heading: `<title> · 3 turns · …`. */
	title: string;
}

/** Every kind, in the order details print. */
export const TRANSCRIPT_KINDS: readonly TranscriptKind[] = ["user", "assistant", "thinking", "call", "result"];

/** Every level a request may name, `auto` first. */
export const TRANSCRIPT_LEVELS: readonly (TranscriptDetail | "auto")[] = ["auto", "omit", "brief", "normal", "full"];

/**
 * Rungs `auto` kinds walk, most detailed first: everything whole; text cut to
 * 1,000 characters, calls by main argument, results to one line; results down
 * to outcome and size, thinking to one line; replies to one line, calls folded
 * into runs of names; prompts to one line, thinking gone.
 */
const AUTO_LADDER: readonly TranscriptDetails[] = [
	{ user: "full", assistant: "full", thinking: "full", call: "full", result: "full" },
	{ user: "normal", assistant: "normal", thinking: "normal", call: "normal", result: "brief" },
	{ user: "normal", assistant: "normal", thinking: "brief", call: "normal", result: "omit" },
	{ user: "normal", assistant: "brief", thinking: "brief", call: "brief", result: "omit" },
	{ user: "brief", assistant: "brief", thinking: "omit", call: "brief", result: "omit" },
];

/** Characters a `brief` text keeps. */
const BRIEF_CHARS = 200;
/** Characters a `normal` text keeps. */
const NORMAL_CHARS = 1000;
/**
 * Read-only lookup tools whose back-to-back calls group per tool, by the
 * argument naming what each looked up; path arguments merge into one tree.
 */
const LOOKUPS = new Map<string, { arg: string; paths: boolean }>([
	["read", { arg: "path", paths: true }],
	["glob", { arg: "path", paths: true }],
	["grep", { arg: "pattern", paths: false }],
	["find", { arg: "query", paths: false }],
]);
/** Characters of one grep pattern or find query in a lookup line. */
const LOOKUP_TERM_CHARS = 60;
/** Read selectors ending a path (`:50-80`, `:raw`, `:5-16,960-973`); a lookup line names files, not ranges. */
const PATH_SELECTORS = /(?::(?:raw|[-+\d,]+))+$/;
/**
 * Extra distance from the middle a user prompt counts while dropping: prompts
 * outlast agent work, except work in the outer eighth at either end.
 */
const PROMPT_KEEP_BIAS = 0.25;

/** A user, assistant, or thinking text. */
interface TextItem {
	kind: "user" | "assistant" | "thinking";
	at: number;
	text: string;
	/** {@link text} with code and tags replaced, once a rung needs it. */
	cleaned?: string;
}

/** A tool call with its result; either may be missing from the transcript. */
interface CallItem {
	kind: "call";
	at: number;
	tool: string;
	/** The scanner's JSON until first parsed, or the message's object; `undefined` when only the result is in view. */
	args: string | Record<string, unknown> | undefined;
	result: CallResult | undefined;
}

interface CallResult {
	at: number;
	text: string;
	isError: boolean;
}

/** An event outside the user–assistant exchange, already one line: `[irc] A → B: …`. */
interface NoteItem {
	kind: "note";
	at: number;
	text: string;
}

type Item = TextItem | CallItem | NoteItem;

/** Records from one user message up to the next. */
interface Turn {
	/** 1-based user turn; 0 for records before the first user message. */
	number: number;
	items: Item[];
}

/** A path segment in {@link pathTree}; `leaf` marks a path ending here. */
interface PathNode {
	leaf: boolean;
	children: Map<string, PathNode>;
}

/** One rendered piece of a transcript: the unit the budget keeps or drops. */
interface Block {
	text: string;
	/** Records it renders. */
	records: number;
	/** Turn a user block opens; `undefined` for agent work. */
	prompt: number | undefined;
}

/** Detail of a shown record. */
type ShownDetail = Exclude<TranscriptDetail, "omit">;

/** ` · HH:MM` (with the month and day when the rendering spans days) of a record time; nothing when undated. */
type Clock = (at: number) => string;

/** One transcript's records from the native scanner, oldest first, rendered per `options`. */
export function renderTranscriptRecords(
	records: readonly TranscriptRecord[],
	options: TranscriptViewOptions,
): TranscriptView {
	const builder = new TurnBuilder();
	for (const record of records) {
		const text = record.text ?? "";
		switch (record.kind) {
			case TranscriptRecordKind.User:
				builder.prompt(record.at, text);
				break;
			case TranscriptRecordKind.Assistant:
				builder.text("assistant", record.at, text);
				break;
			case TranscriptRecordKind.Thinking:
				builder.text("thinking", record.at, text);
				break;
			case TranscriptRecordKind.Call:
				builder.call(record.at, record.tool ?? "tool", record.callId, record.args ?? "{}");
				break;
			case TranscriptRecordKind.Result:
				builder.result(record.at, record.tool, record.callId, text, record.isError === true);
				break;
		}
	}
	return renderTurns(builder.turns, options);
}

/**
 * A session's message array, live or loaded read-only, rendered per
 * `options`: user and assistant messages as with the scanner's records, other
 * events (user `!` executions, custom messages, summaries) as one-line notes.
 */
export function renderTranscriptMessages(
	messages: readonly AgentMessage[],
	options: TranscriptViewOptions,
): TranscriptView {
	const builder = new TurnBuilder();
	for (const message of messages) {
		const at = message.timestamp;
		switch (message.role) {
			case "user": {
				const text = contentToText(message.content).trim();
				if (text) builder.prompt(at, text);
				break;
			}
			case "developer": {
				const text = contentToText(message.content).trim();
				if (text) builder.note(at, `[developer] ${text}`);
				break;
			}
			case "assistant": {
				// The scanner's order: thinking, then the reply, then the calls.
				const thinking: string[] = [];
				const replies: string[] = [];
				for (const block of message.content) {
					if (block.type === "thinking") thinking.push(block.thinking);
					else if (block.type === "text") replies.push(block.text);
				}
				const thought = thinking.join("\n\n").trim();
				if (thought) builder.text("thinking", at, thought);
				const reply = replies.join("\n").trim();
				if (reply) builder.text("assistant", at, reply);
				for (const block of message.content) {
					if (block.type === "toolCall") builder.call(at, block.name, block.id, block.arguments);
				}
				break;
			}
			case "toolResult":
				builder.result(at, message.toolName, message.toolCallId, contentToText(message.content), message.isError);
				break;
			default: {
				const line = formatHistoryEventLine(message);
				if (line !== undefined) builder.note(at, line);
			}
		}
	}
	return renderTurns(builder.turns, options);
}

/** Call arguments from the scanner's JSON; unparseable JSON or a non-object reads as none. */
export function parseCallArgs(json: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(json);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** Groups records into turns as a source feeds them, pairing each call with its result. */
class TurnBuilder {
	readonly turns: Turn[] = [];
	#calls = new Map<string, CallItem>();
	#prompts = 0;

	/** A user message, opening the next turn. */
	prompt(at: number, text: string): void {
		this.turns.push({ number: ++this.#prompts, items: [] });
		this.#add({ kind: "user", at, text });
	}

	text(kind: "assistant" | "thinking", at: number, text: string): void {
		this.#add({ kind, at, text });
	}

	note(at: number, text: string): void {
		this.#add({ kind: "note", at, text });
	}

	call(at: number, tool: string, callId: string | undefined, args: string | Record<string, unknown>): void {
		const item: CallItem = { kind: "call", at, tool, args, result: undefined };
		if (callId) this.#calls.set(callId, item);
		this.#add(item);
	}

	/** A call's result, joined to its call; a result whose call is not in view stands alone. */
	result(at: number, tool: string | undefined, callId: string | undefined, text: string, isError: boolean): void {
		const result = { at, text, isError };
		const item = callId ? this.#calls.get(callId) : undefined;
		if (item && !item.result) item.result = result;
		else this.#add({ kind: "call", at, tool: tool ?? "tool", args: undefined, result });
	}

	#add(item: Item): void {
		let turn = this.turns.at(-1);
		if (!turn) {
			turn = { number: 0, items: [] };
			this.turns.push(turn);
		}
		turn.items.push(item);
	}
}

/** `all` rendered per `options`: the most detailed rung that fits, else the tersest with the middle dropped. */
function renderTurns(all: readonly Turn[], options: TranscriptViewOptions): TranscriptView {
	const prompts = all.at(-1)?.number ?? 0;
	const turns = selectTurns(all, prompts, options);
	const ladder = ladderOf(options.detail);
	let records = 0;
	for (const turn of turns) for (const item of turn.items) records += itemRecords(item);
	const view: TranscriptView = { turns: prompts, records, omitted: 0, detail: ladder[0], text: "" };
	if (turns.length === 0) {
		view.text =
			all.length === 0
				? `${options.title}: no messages.`
				: `${options.title}: no turn selected of ${formatCount("turn", prompts)}.`;
		return view;
	}

	const span = spanOf(turns);
	const clock = clockOf(span);
	const heading = headingOf(options.title, turns, all.length, prompts, records, span);
	const markerChars = gapMarker(records, prompts, prompts + 1).length + 1;
	for (const [index, detail] of ladder.entries()) {
		// Room left after the heading and the longest caption this rung can print.
		const room = options.budget - heading.length - captionOf(detail, records, options.budget).length - 2;
		const final = index === ladder.length - 1;
		const blocks = renderBlocks(turns, detail, clock, final ? Number.POSITIVE_INFINITY : room);
		if (!blocks) continue;
		const { lines, omitted } = dropToFit(blocks, room, markerChars);
		view.detail = detail;
		view.omitted = omitted;
		view.text = [heading, captionOf(detail, omitted, options.budget), ...lines].join("\n");
		break;
	}
	return view;
}

/** The turns `options.turns` names, of those active in `options.window`. */
function selectTurns(turns: readonly Turn[], prompts: number, options: TranscriptViewOptions): Turn[] {
	const pick = options.turns;
	const [from, to] = pick === undefined ? [0, prompts] : typeof pick === "number" ? [pick, pick] : pick;
	const resolve = (turn: number) => (turn < 0 ? prompts + 1 + turn : turn);
	const first = resolve(from);
	const last = resolve(to);
	return turns.filter(turn => {
		if (turn.number < first || turn.number > last) return false;
		if (!options.window) return true;
		const span = spanOf([turn]);
		return span !== undefined && overlapsWindow(span[0], span[1], options.window);
	});
}

/** Rungs to try, most detailed first: {@link AUTO_LADDER} under the pinned kinds, repeats dropped. */
function ladderOf(request: TranscriptDetailRequest): TranscriptDetails[] {
	const pinned: Partial<TranscriptDetails> = {};
	for (const kind of TRANSCRIPT_KINDS) {
		const level = typeof request === "string" ? request : request[kind];
		if (level !== undefined && level !== "auto") pinned[kind] = level;
	}
	const ladder: TranscriptDetails[] = [];
	for (const rung of AUTO_LADDER) {
		const detail = { ...rung, ...pinned };
		const previous = ladder.at(-1);
		if (!previous || TRANSCRIPT_KINDS.some(kind => previous[kind] !== detail[kind])) ladder.push(detail);
	}
	return ladder;
}

/** The blocks of `turns` at `detail`; `undefined` once they outgrow `room`, so an oversized rung stops early. */
function renderBlocks(
	turns: readonly Turn[],
	detail: TranscriptDetails,
	clock: Clock,
	room: number,
): Block[] | undefined {
	const blocks: Block[] = [];
	let size = 0;
	for (const block of blocksOf(turns, detail, clock)) {
		size += block.text.length + 1;
		if (size > room) return undefined;
		blocks.push(block);
	}
	return blocks;
}

function* blocksOf(turns: readonly Turn[], detail: TranscriptDetails, clock: Clock): Generator<Block> {
	// Calls without results gather into runs: `brief` folds a run into one
	// line, `normal` groups the lookups in it.
	const gather = detail.result === "omit" && (detail.call === "brief" || detail.call === "normal");
	const hidden = detail.call === "omit" && detail.result === "omit";
	for (const turn of turns) {
		let run: CallItem[] = [];
		for (const item of turn.items) {
			if (item.kind === "call") {
				if (gather) run.push(item);
				else if (!hidden) yield callBlock(item, detail);
				continue;
			}
			const level = item.kind === "assistant" || item.kind === "thinking" ? detail[item.kind] : undefined;
			// Omitted text leaves a run whole.
			if (level === "omit") continue;
			if (run.length > 0) {
				yield* runBlocks(run, detail.call);
				run = [];
			}
			if (item.kind === "note") yield { text: cut(item.text, "brief"), records: 1, prompt: undefined };
			else if (item.kind === "user") yield promptBlock(turn, item, detail.user, clock);
			else if (level !== undefined)
				yield { text: `${item.kind}: ${textBody(item, level)}`, records: 1, prompt: undefined };
		}
		if (run.length > 0) yield* runBlocks(run, detail.call);
	}
}

/** `#3 · 10:31 · user: …`; the header alone when prompts are omitted. */
function promptBlock(turn: Turn, item: TextItem, level: TranscriptDetail, clock: Clock): Block {
	const head = `#${turn.number}${clock(item.at)}`;
	return {
		text: level === "omit" ? head : `${head} · user: ${textBody(item, level)}`,
		records: 1,
		prompt: turn.number,
	};
}

function callBlock(item: CallItem, detail: TranscriptDetails): Block {
	let text = `call ${callLine(item, detail.call)}`;
	if (item.result && detail.result !== "omit") {
		const output = item.result.text;
		// Tool output keeps its code: it is what the tool returned, not prose around it.
		text += `\nresult: ${detail.result === "full" ? indent(output) : cut(stripAnsi(output), detail.result)}`;
	}
	return { text, records: itemRecords(item), prompt: undefined };
}

/**
 * A run of calls without results. `brief` folds it into one line counted per
 * tool (`calls: read ×9 ✓96K, bash ×3 ✓4K (1 failed), edit ✗80`); `normal`
 * gives each other call its line and back-to-back lookups one line per tool.
 */
function* runBlocks(run: readonly CallItem[], level: TranscriptDetail): Generator<Block> {
	if (level === "brief") {
		const tokens: string[] = [];
		for (const [tool, calls] of Map.groupBy(run, call => call.tool)) {
			tokens.push(calls.length === 1 ? callLine(calls[0], "brief") : `${tool} ×${calls.length} ${outcomeOf(calls)}`);
		}
		yield { text: `calls: ${tokens.join(", ")}`, records: recordsOf(run), prompt: undefined };
		return;
	}
	for (const stretch of stretchesOf(run)) {
		yield stretch.length === 1
			? { text: `call ${callLine(stretch[0], "normal")}`, records: recordsOf(stretch), prompt: undefined }
			: lookupBlock(stretch);
	}
}

/** `run` cut into stretches of back-to-back lookups and single other calls. */
function* stretchesOf(run: readonly CallItem[]): Generator<CallItem[]> {
	let lookups: CallItem[] = [];
	for (const item of run) {
		if (LOOKUPS.has(item.tool)) {
			lookups.push(item);
			continue;
		}
		if (lookups.length > 0) {
			yield lookups;
			lookups = [];
		}
		yield [item];
	}
	if (lookups.length > 0) yield lookups;
}

/** `call read ×9: src/{a.ts, b/c.ts} · ✓96K`, one line per tool of a stretch of lookups. */
function lookupBlock(stretch: readonly CallItem[]): Block {
	const lines: string[] = [];
	for (const [tool, calls] of Map.groupBy(stretch, call => call.tool)) {
		const count = calls.length === 1 ? "" : ` ×${calls.length}`;
		const targets = lookupTargets(tool, calls);
		lines.push(`call ${tool}${count}${targets ? `: ${targets}` : ""} · ${outcomeOf(calls)}`);
	}
	return { text: lines.join("\n"), records: recordsOf(stretch), prompt: undefined };
}

/** What `calls` of one lookup tool looked up, each once: a tree of paths, or quoted patterns and queries. */
function lookupTargets(tool: string, calls: readonly CallItem[]): string {
	const lookup = LOOKUPS.get(tool);
	if (!lookup) return "";
	const targets = new Set<string>();
	for (const item of calls) {
		if (item.args === undefined) continue;
		const args = argsOf(item);
		const value = args[lookup.arg];
		const target = typeof value === "string" && value ? value : formatToolCallPrimaryArg(tool, args);
		if (!lookup.paths) targets.add(`\`${previewLine(target, LOOKUP_TERM_CHARS)}\``);
		else {
			for (const path of target.split(";")) {
				const file = path.trim().replace(PATH_SELECTORS, "");
				if (file) targets.add(file);
			}
		}
	}
	const text = lookup.paths ? pathTree(targets) : [...targets].join(", ");
	return flattenLine(truncateTinyMessage(text, NORMAL_CHARS));
}

/**
 * Paths as one tree of shared prefixes, in first-seen order:
 * `src/a.ts`, `src/b/c.ts`, `test/d.ts` → `src/{a.ts, b/c.ts}, test/d.ts`.
 * A path that also prefixes others shows as `.` among them.
 */
function pathTree(paths: Iterable<string>): string {
	const root: PathNode = { leaf: false, children: new Map() };
	for (const path of paths) {
		let node = root;
		for (const segment of path.split("/")) {
			let child = node.children.get(segment);
			if (!child) {
				child = { leaf: false, children: new Map() };
				node.children.set(segment, child);
			}
			node = child;
		}
		node.leaf = true;
	}
	return branchesOf(root).join(", ");
}

/** The subtrees under `node`, written out. */
function branchesOf(node: PathNode): string[] {
	const branches = node.leaf ? ["."] : [];
	for (const [segment, child] of node.children) {
		if (child.children.size === 0) {
			branches.push(segment);
			continue;
		}
		const below = branchesOf(child);
		branches.push(below.length === 1 ? `${segment}/${below[0]}` : `${segment}/{${below.join(", ")}}`);
	}
	return branches;
}

/**
 * `✓1.2K`: the result size in characters of one call, `✗80` when it failed;
 * of several, their total with failures counted (`✓96K (2 failed)`). `…`
 * while no result is in.
 */
function outcomeOf(calls: readonly CallItem[]): string {
	let chars = 0;
	let failed = 0;
	let returned = 0;
	for (const call of calls) {
		if (!call.result) continue;
		returned++;
		chars += call.result.text.length;
		if (call.result.isError) failed++;
	}
	if (returned === 0) return "…";
	if (calls.length === 1) return `${failed > 0 ? "✗" : "✓"}${formatNumber(chars)}`;
	return failed > 0 ? `✓${formatNumber(chars)} (${failed} failed)` : `✓${formatNumber(chars)}`;
}

/**
 * `bash ✓1.2K`: the tool and its {@link outcomeOf}; `normal` adds the main
 * argument, `full` the whole JSON arguments.
 */
function callLine(item: CallItem, level: TranscriptDetail): string {
	const outcome = outcomeOf([item]);
	if (item.args === undefined || level === "omit" || level === "brief") return `${item.tool} ${outcome}`;
	if (level === "normal") return `${item.tool}: ${formatToolCallPrimaryArg(item.tool, argsOf(item))} · ${outcome}`;
	return `${item.tool} ${outcome}: ${typeof item.args === "string" ? item.args : JSON.stringify(item.args)}`;
}

/** A call's arguments as an object, parsing the scanner's JSON once. */
function argsOf(item: CallItem): Record<string, unknown> {
	if (typeof item.args === "string") item.args = parseCallArgs(item.args);
	return item.args ?? {};
}

function textBody(item: TextItem, level: ShownDetail): string {
	if (level === "full") return indent(item.text);
	item.cleaned ??= cleanTinyMessage(item.text, { placeholders: true });
	return cut(item.cleaned, level);
}

/** `text` cut from the middle: one line for `brief`, indented lines for `normal`. */
function cut(text: string, level: "brief" | "normal"): string {
	if (level === "brief") return flattenLine(truncateTinyMessage(text, BRIEF_CHARS));
	return indent(truncateTinyMessage(text, NORMAL_CHARS));
}

/** Continuation lines indented under their label. */
function indent(text: string): string {
	return text.replaceAll("\n", "\n  ");
}

/**
 * The lines of `blocks` within `room` characters, with how many records were
 * dropped: blocks nearest the middle go first, prompts after agent work, and
 * each dropped run becomes one marker of at most `markerChars`.
 */
function dropToFit(blocks: readonly Block[], room: number, markerChars: number): { lines: string[]; omitted: number } {
	const count = blocks.length;
	let size = 0;
	for (const block of blocks) size += block.text.length + 1;
	const dropped = new Uint8Array(count);
	let omitted = 0;
	if (size > room) {
		const middle = (count - 1) / 2;
		const distance = (index: number) =>
			Math.abs(index - middle) / count + (blocks[index].prompt === undefined ? 0 : PROMPT_KEEP_BIAS);
		const order = Array.from(blocks.keys()).sort((a, b) => distance(a) - distance(b));
		let gaps = 0;
		for (const index of order) {
			if (size + gaps * markerChars <= room) break;
			dropped[index] = 1;
			size -= blocks[index].text.length + 1;
			omitted += blocks[index].records;
			// A drop opens a gap, widens one, or joins two.
			gaps += 1 - Number(dropped[index - 1] === 1) - Number(dropped[index + 1] === 1);
		}
	}
	const lines: string[] = [];
	for (let index = 0; index < count;) {
		if (dropped[index] === 0) {
			lines.push(blocks[index].text);
			index++;
			continue;
		}
		let records = 0;
		let first: number | undefined;
		let last: number | undefined;
		for (; index < count && dropped[index] === 1; index++) {
			records += blocks[index].records;
			const prompt = blocks[index].prompt;
			if (prompt !== undefined) {
				first ??= prompt;
				last = prompt;
			}
		}
		lines.push(gapMarker(records, first, last));
	}
	return { lines, omitted };
}

/** `[… 23 records dropped, turns 4–9]`; the turns are those whose prompts went too. */
function gapMarker(records: number, first: number | undefined, last: number | undefined): string {
	const turns = first === undefined ? "" : first === last ? `, turn ${first}` : `, turns ${first}–${last}`;
	return `[… ${formatCount("record", records)} dropped${turns}]`;
}

/** `<title> · turns 3–5 of 14 · 2024-06-01 10:00–10:42 · 96 records`. */
function headingOf(
	title: string,
	turns: readonly Turn[],
	total: number,
	prompts: number,
	records: number,
	span: [number, number] | undefined,
): string {
	const facts = [title];
	if (turns.length === total) facts.push(formatCount("turn", prompts));
	else {
		const first = turns[0].number;
		const last = turns[turns.length - 1].number;
		facts.push(first === last ? `turn ${first} of ${prompts}` : `turns ${first}–${last} of ${prompts}`);
	}
	if (span) {
		const [start, end] = [localMinute(span[0]), localMinute(span[1])];
		facts.push(start.slice(0, 10) === end.slice(0, 10) ? `${start}–${end.slice(11)}` : `${start} – ${end}`);
	}
	facts.push(formatCount("record", records));
	return facts.join(" · ");
}

/** `Detail: user brief, …`, then how much the budget dropped. */
function captionOf(detail: TranscriptDetails, omitted: number, budget: number): string {
	const levels = TRANSCRIPT_KINDS.map(kind => `${kind} ${detail[kind]}`).join(", ");
	if (omitted === 0) return `Detail: ${levels}`;
	return `Detail: ${levels} · ${formatCount("record", omitted)} dropped from the middle to fit ${budget} chars`;
}

/** First and last record times of `turns`; `undefined` when none is dated. */
function spanOf(turns: readonly Turn[]): [number, number] | undefined {
	let first = Number.POSITIVE_INFINITY;
	let last = 0;
	const see = (at: number) => {
		if (at <= 0) return;
		first = Math.min(first, at);
		last = Math.max(last, at);
	};
	for (const turn of turns) {
		for (const item of turn.items) {
			see(item.at);
			if (item.kind === "call" && item.result) see(item.result.at);
		}
	}
	return last > 0 ? [first, last] : undefined;
}

function clockOf(span: [number, number] | undefined): Clock {
	const oneDay = !span || localMinute(span[0]).slice(0, 10) === localMinute(span[1]).slice(0, 10);
	return at => (at > 0 ? ` · ${localMinute(at).slice(oneDay ? 11 : 5)}` : "");
}

function itemRecords(item: Item): number {
	return item.kind === "call" ? Number(item.args !== undefined) + Number(item.result !== undefined) : 1;
}

function recordsOf(calls: readonly CallItem[]): number {
	let records = 0;
	for (const call of calls) records += itemRecords(call);
	return records;
}
