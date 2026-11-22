/**
 * The steps of a traced bash run as output sources. A step is a command of
 * the run, named by the execution node the shell visualization draws it
 * under; its output is the stream it writes (a tapped pipe it feeds, a file
 * it redirects into) or, without one, its slice of the run's own output.
 * {@link ShellSteps} picks the source a view shows: the step the user
 * clicked, else whatever the run writes right now. The jobs sheet and the
 * transcript's bash card share it.
 */
import type { PipeStreamInfo, PipeStreams } from "@oh-my-pi/pi-natives";
import { formatBytes, sanitizeText, truncate } from "@oh-my-pi/pi-utils";
import type { ShellTrace, ShellVizPresentation } from "@oh-my-pi/pi-wire";
import { collapseCommand } from "../apps/ps-data";
import { shortenEmbeddedPaths, shortenPath } from "../render/render-utils";

/** Id of the run's own output among its sources; streams keep their {@link ShellStream.id}. */
export const OWN_OUTPUT = "out";

/** How long after its last write a source still counts as flowing: following stays on it that long. */
export const FLOW_WINDOW_MS = 1500;

/** Bytes off a stream's end a view reads: screens of text, not the megabyte a stream keeps. */
const STREAM_TAIL_BYTES = 64 * 1024;

/** Longest step label: the command text a pinned step without a stream is named by. */
const STEP_LABEL_CHARS = 48;

/**
 * A place a run's command writes that is not its own output: a pipe between
 * two of its stages, or a file it redirects into.
 */
export interface ShellStream {
	/** Stable within the run (`pipe:1`, `file:2`, see {@link shellStreamId}). */
	readonly id: string;
	readonly kind: "pipe" | "file";
	/** Source text of the stage writing a pipe, or of the command whose redirection opened a file. */
	readonly producer: string;
	/** Source text of the stage reading a pipe; a file's absolute path. */
	readonly consumer: string;
	/** Node key (`unit:0:node`) of the command writing it, in the run trace's key space; absent when unknown. */
	readonly node?: string;
	/** Bytes written so far; a file's size. */
	readonly bytes: number;
	/** Whether more may arrive. */
	readonly open: boolean;
	/** Milliseconds since the UNIX epoch of its last write (a pipe's open time before any; 0 when unknown). */
	readonly modified: number;
	/** Its newest text, from a whole line on; undefined when it carries binary data. Read for the shown stream only. */
	tail(): string | undefined;
}

/** A stream's id among its run's sources: `pipe:<n>`, or `file:<n>` for a redirected file. */
export function shellStreamId(info: PipeStreamInfo): string {
	return `${info.file ? "file" : "pipe"}:${info.id}`;
}

/** The newest text of stream `id` from its first whole line on; undefined for binary data. */
function streamTail(streams: PipeStreams, id: number, total: number): string | undefined {
	const chunk = streams.read(id, Math.max(0, total - STREAM_TAIL_BYTES));
	if (!chunk) return "";
	if (chunk.data.indexOf(0) !== -1) return undefined;
	const text = new TextDecoder().decode(chunk.data);
	// A read that starts past the stream's head starts mid-line, maybe mid-character.
	return chunk.start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
}

/** A run's tapped pipes and redirected files as {@link ShellStream}s, oldest first. */
export function nativeShellStreams(streams: PipeStreams): ShellStream[] {
	return streams.list().map(info => ({
		id: shellStreamId(info),
		kind: info.file ? "file" : "pipe",
		producer: info.producer,
		consumer: info.consumer,
		...(info.node !== undefined ? { node: info.node } : {}),
		bytes: info.total,
		open: info.open,
		modified: info.modified,
		tail: () => streamTail(streams, info.id, info.total),
	}));
}

/** What a run offers a {@link ShellSteps} view, read anew every frame. */
export interface ShellStepInput {
	/** The run's trace: the node tree steps resolve through, and the history their output slices come from. */
	readonly trace?: ShellTrace;
	/** The command as drawn: focus names its execution nodes. Without it, nothing is focused. */
	readonly presentation?: ShellVizPresentation;
	/** The run's streams, oldest first. */
	readonly streams: readonly ShellStream[];
	/** The run's own output. */
	readonly output: string;
	/** Milliseconds since the UNIX epoch the own output last changed; undefined when unknown. */
	readonly outputModified?: number;
	/** The run ended: nothing flows any more. */
	readonly settled: boolean;
	/** Wall clock (ms since the UNIX epoch); defaults to now. */
	readonly now?: number;
}

/** One entry of a view's source menu: the run's own output, or one stream. */
export interface ShellStepSource {
	/** {@link OWN_OUTPUT} or a stream id. */
	readonly id: string;
	/** Short name: `Output`, a file's name (with its directory when names collide), a pipe's two programs. */
	readonly label: string;
	/** What it is on one line: a file's path or a pipe's two stages, and its size. */
	readonly detail?: string;
}

/** The source a {@link ShellSteps} view shows now. */
export interface ShellStepView {
	/** {@link OWN_OUTPUT}, a stream id, or `step:<node>` for a step's slice of the own output. */
	readonly id: string;
	/** Its name: a source's {@link ShellStepSource.label}, or a step's command text. */
	readonly label: string;
	/** What it is: a stream's {@link ShellStepSource.detail}; for a step's slice, that it is the step's own output. */
	readonly note?: string;
	/** The shown stream. */
	readonly stream?: ShellStream;
	/** Its text; undefined for a stream of binary data. */
	readonly text: string | undefined;
	/** More may arrive. */
	readonly open: boolean;
	/** It was written within {@link FLOW_WINDOW_MS}. */
	readonly flowing: boolean;
	/** The user chose it (a step or a menu entry); otherwise the view follows the run. */
	readonly pinned: boolean;
	/** Execution nodes of the presentation that write it: the step the command highlights. */
	readonly focus: readonly string[];
	/** The run's own output, then each stream, labelled. */
	readonly sources: readonly ShellStepSource[];
}

/** What the user chose: a clicked step (its execution node), or a menu entry (a source id). */
type ShellStepPin = { readonly step: string } | { readonly source: string };

/** A parsed node key; only source 0 (the engine's syntax) resolves through the trace. */
interface NodeRef {
	readonly u: number;
	readonly s: number;
	readonly n: number;
}

function parseNode(key: string): NodeRef | undefined {
	const match = /^(\d+):(\d+):(\d+)$/.exec(key);
	return match ? { u: Number(match[1]), s: Number(match[2]), n: Number(match[3]) } : undefined;
}

/** Whether node `n` of unit `u` is `ancestor` or below it. */
function within(trace: ShellTrace | undefined, u: number, n: number, ancestor: number): boolean {
	const nodes = trace?.units[u]?.nodes;
	for (let id: number | undefined = n, hops = 0; id !== undefined && hops <= (nodes?.length ?? 0); hops++) {
		if (id === ancestor) return true;
		id = nodes?.[id]?.p;
	}
	return false;
}

/** Whether execution node `key` is `target` or one of its descendants. */
function under(trace: ShellTrace | undefined, key: string, target: string): boolean {
	if (key === target) return true;
	const node = parseNode(key);
	const root = parseNode(target);
	return (
		node !== undefined &&
		root !== undefined &&
		node.s === 0 &&
		root.s === 0 &&
		node.u === root.u &&
		within(trace, node.u, node.n, root.n)
	);
}

/** Execution nodes of the drawn command at or below `target`; `target` itself when none are drawn. */
function focusUnder(input: ShellStepInput, target: string | undefined): string[] {
	if (target === undefined) return [];
	const focus = new Set<string>();
	const presentation = input.presentation;
	for (const row of [...(presentation?.rows ?? []), ...(presentation?.original ?? [])]) {
		for (const segment of row.segments) {
			const key = segment.executionNode ?? segment.node ?? row.node;
			if (key !== undefined && under(input.trace, key, target)) focus.add(key);
		}
	}
	return focus.size > 0 ? [...focus] : [target];
}

/** The command text drawn for the execution nodes in `focus`, on one line. */
function focusText(presentation: ShellVizPresentation | undefined, focus: readonly string[]): string | undefined {
	const keys = new Set(focus);
	for (const row of presentation?.rows ?? []) {
		const text = row.segments
			.filter(segment => {
				const key = segment.executionNode ?? segment.node ?? row.node;
				return key !== undefined && keys.has(key);
			})
			.map(segment => segment.text)
			.join("");
		const line = collapseCommand(sanitizeText(text)).trim();
		if (line) return truncate(line, STEP_LABEL_CHARS);
	}
	return undefined;
}

/** The producer (`unit:0:node`) of the newest attributed output entry of the run. */
function newestProducer(trace: ShellTrace | undefined): string | undefined {
	const history = trace?.history ?? [];
	for (let i = history.length - 1; i >= 0; i--) {
		const entry = history[i]!;
		if (entry.kind === "Output" && entry.u !== undefined && entry.n !== undefined) return `${entry.u}:0:${entry.n}`;
	}
	return undefined;
}

/** The output entries of the trace's history written by `node` or a command below it, concatenated. */
function stepSlice(trace: ShellTrace | undefined, node: string): string {
	const root = parseNode(node);
	if (!root || root.s !== 0) return "";
	let text = "";
	for (const entry of trace?.history ?? []) {
		if (entry.kind !== "Output" || entry.u !== root.u || entry.n === undefined || typeof entry.text !== "string") {
			continue;
		}
		if (within(trace, entry.u, entry.n, root.n)) text += entry.text;
	}
	return text;
}

/**
 * The step `node` stands for: the nearest of it and its ancestors that writes
 * a stream, with those streams (oldest instance first: a loop body opens one
 * per pass); else `node` itself, which writes into the run's own output.
 */
function resolveStep(
	trace: ShellTrace | undefined,
	streams: readonly ShellStream[],
	node: string,
): { node: string; streams: ShellStream[] } {
	const ref = parseNode(node);
	if (ref?.s === 0) {
		const nodes = trace?.units[ref.u]?.nodes;
		for (let id: number | undefined = ref.n, hops = 0; id !== undefined && hops <= (nodes?.length ?? 0); hops++) {
			const key = `${ref.u}:0:${id}`;
			const written = streams.filter(stream => stream.node === key);
			if (written.length > 0) return { node: key, streams: written };
			id = nodes?.[id]?.p;
		}
	}
	return { node, streams: streams.filter(stream => stream.node === node) };
}

/** The program a stage runs, without its directory: its first word past assignments and grouping. */
function stageName(source: string): string {
	const words = sanitizeText(source).trim().split(/\s+/);
	const word = words.find(word => !/^[A-Za-z_][A-Za-z0-9_]*=|^[({!]+$/.test(word)) ?? words[0] ?? "";
	return word.slice(word.lastIndexOf("/") + 1);
}

/** The last `count` components of `path`, joined. */
function pathTail(path: string, count: number): string {
	return path.split("/").filter(Boolean).slice(-count).join("/");
}

/**
 * Menu labels of `streams`: a file's name, with as many parent directories as
 * it takes to tell different paths apart; a pipe's two programs. Instances of
 * one path or pipe (a loop body writing it again) are numbered in order.
 */
function streamLabels(streams: readonly ShellStream[]): string[] {
	const labels = streams.map(stream => {
		if (stream.kind === "pipe") return `${stageName(stream.producer)} → ${stageName(stream.consumer)}`;
		const path = sanitizeText(stream.consumer);
		const depth = path.split("/").filter(Boolean).length;
		for (let count = 1; count < depth; count++) {
			const label = pathTail(path, count);
			const clash = streams.some(
				other =>
					other.kind === "file" && other.consumer !== stream.consumer && pathTail(other.consumer, count) === label,
			);
			if (!clash) return label;
		}
		return shortenPath(path);
	});
	const totals = new Map<string, number>();
	for (const label of labels) totals.set(label, (totals.get(label) ?? 0) + 1);
	const seen = new Map<string, number>();
	return labels.map(label => {
		if (totals.get(label) === 1) return label;
		const nth = (seen.get(label) ?? 0) + 1;
		seen.set(label, nth);
		return `${label} #${nth}`;
	});
}

/** What a stream is, on one line: a file's path or a pipe's two stages, and its size. */
function shellStreamNote(stream: ShellStream): string {
	const what =
		stream.kind === "file"
			? shortenPath(sanitizeText(stream.consumer))
			: shortenEmbeddedPaths(collapseCommand(sanitizeText(`${stream.producer} → ${stream.consumer}`)));
	return `${what} · ${formatBytes(stream.bytes)}`;
}

/** A source the following logic weighs: whether it carries text and when it was last written. */
interface Candidate {
	readonly id: string;
	readonly carrying: boolean;
	readonly open: boolean;
	readonly modified: number;
}

/**
 * Which source of a traced run a view shows, and why. Without a choice it
 * follows the run: it stays on the source it shows while that one keeps
 * being written (within {@link FLOW_WINDOW_MS}), else moves to the one
 * written most recently; before anything is written, the own output once it
 * has text, else the newest stream that carries bytes. A settled run shows its
 * own output (the newest carrying stream when that is empty). Clicking a
 * step pins it (its newest stream, or its slice of the own output); clicking
 * the pinned, highlighted step again or {@link follow} resumes following. A
 * menu entry pins that source. Stream tails are read for the shown stream
 * only, and again only once it grew.
 */
export class ShellSteps {
	#pin: ShellStepPin | undefined;
	/** The source following last showed. */
	#followed: string | undefined;
	/** Focus of the last view: the highlighted step a repeated click on unpins. */
	#focus: readonly string[] = [];
	/** The shown stream's tail, reread only once the stream grew. */
	#tail: { key: string; text: string | undefined } | undefined;
	/** A pinned step's slice, recomputed only when the trace changed. */
	#slice: { trace: ShellTrace | undefined; node: string; text: string } | undefined;

	/** Whether the user chose what is shown. */
	get pinned(): boolean {
		return this.#pin !== undefined;
	}

	/** A click on the step drawn under execution node `node`: pins it, or resumes following when it is the pinned one. */
	select(node: string): void {
		const pin = this.#pin;
		const again = pin !== undefined && (("step" in pin && pin.step === node) || this.#focus.includes(node));
		this.#pin = again ? undefined : { step: node };
	}

	/** A menu pick: pins source `id` ({@link OWN_OUTPUT} or a stream id). */
	pick(id: string): void {
		this.#pin = { source: id };
	}

	/** Drops the user's choice: the view follows the run again. */
	follow(): void {
		this.#pin = undefined;
	}

	/** The source to show now. */
	show(input: ShellStepInput): ShellStepView {
		const now = input.now ?? Date.now();
		const { streams, trace } = input;
		const labels = streamLabels(streams);
		const sources: ShellStepSource[] = [
			{ id: OWN_OUTPUT, label: "Output" },
			...streams.map((stream, i) => ({
				id: stream.id,
				label: labels[i] ?? stream.id,
				detail: shellStreamNote(stream),
			})),
		];
		const ownModified = input.outputModified ?? 0;
		const ownFlowing = !input.settled && now - ownModified <= FLOW_WINDOW_MS;
		const own = (pinned: boolean): ShellStepView => {
			const producer = input.settled ? undefined : newestProducer(trace);
			return {
				id: OWN_OUTPUT,
				label: "Output",
				text: input.output,
				open: !input.settled,
				flowing: ownFlowing,
				pinned,
				focus: focusUnder(input, producer),
				sources,
			};
		};
		const ofStream = (stream: ShellStream, pinned: boolean, focusNode = stream.node): ShellStepView => {
			const key = `${stream.id}|${stream.bytes}|${stream.open}`;
			if (this.#tail?.key !== key) this.#tail = { key, text: stream.tail() };
			const index = streams.indexOf(stream);
			return {
				id: stream.id,
				label: labels[index] ?? stream.id,
				note: shellStreamNote(stream),
				stream,
				text: this.#tail.text,
				open: stream.open && !input.settled,
				flowing: stream.open && !input.settled && now - stream.modified <= FLOW_WINDOW_MS,
				pinned,
				focus: focusUnder(input, focusNode),
				sources,
			};
		};

		let view: ShellStepView | undefined;
		const pin = this.#pin;
		if (pin && "source" in pin) {
			const stream = streams.find(stream => stream.id === pin.source);
			if (stream) view = ofStream(stream, true);
			else if (pin.source === OWN_OUTPUT) view = own(true);
		} else if (pin) {
			const step = resolveStep(trace, streams, pin.step);
			const newest = step.streams.at(-1);
			if (newest) view = ofStream(newest, true, step.node);
			else {
				let slice = this.#slice;
				if (!slice || slice.trace !== trace || slice.node !== step.node) {
					slice = { trace, node: step.node, text: stepSlice(trace, step.node) };
					this.#slice = slice;
				}
				const focus = focusUnder(input, step.node);
				const producer = newestProducer(trace);
				view = {
					id: `step:${step.node}`,
					label: focusText(input.presentation, focus) ?? "Step output",
					note: "Its own output",
					text: slice.text,
					open: !input.settled,
					flowing: ownFlowing && producer !== undefined && under(trace, producer, step.node),
					pinned: true,
					focus,
					sources,
				};
			}
		}
		if (!view) {
			// A picked source that is gone (another run's stream id) falls back to following.
			this.#pin = undefined;
			const id = this.#follow(input, now);
			const stream = streams.find(stream => stream.id === id);
			view = stream ? ofStream(stream, false) : own(false);
			this.#followed = view.id;
		}
		this.#focus = view.focus;
		return view;
	}

	/** The source following shows now (see {@link ShellSteps}). */
	#follow(input: ShellStepInput, now: number): string {
		const own: Candidate = {
			id: OWN_OUTPUT,
			carrying: input.output.trim() !== "",
			open: !input.settled,
			modified: input.outputModified ?? 0,
		};
		const candidates: Candidate[] = [
			own,
			...input.streams.map(stream => ({
				id: stream.id,
				carrying: stream.bytes > 0,
				open: stream.open,
				modified: stream.modified,
			})),
		];
		const carrying = candidates.filter(candidate => candidate.carrying);
		if (input.settled) return own.carrying ? OWN_OUTPUT : (carrying.at(-1)?.id ?? OWN_OUTPUT);
		const followed = carrying.find(candidate => candidate.id === this.#followed);
		if (followed && now - followed.modified <= FLOW_WINDOW_MS) return followed.id;
		let newest: Candidate | undefined;
		for (const candidate of carrying) {
			if (candidate.modified > 0 && candidate.modified >= (newest?.modified ?? 0)) newest = candidate;
		}
		if (newest) return newest.id;
		if (own.carrying) return OWN_OUTPUT;
		return (carrying.findLast(candidate => candidate.open) ?? carrying.at(-1))?.id ?? OWN_OUTPUT;
	}
}
