/**
 * End-to-end harness for the native (Tern Surface Protocol) renderer: a fake
 * terminal that answers the `hello` probe, decodes every TSP message the TUI
 * writes, applies frames to reference documents (`native/apply.ts`) and
 * acknowledges them, with a manual render scheduler so tests are
 * deterministic.
 *
 * @example
 * const h = await TspHarness.start(tui => tui.addChild(new Text("hi")));
 * expect(h.region("main")?.c?.[0]?.k).toBe("text");
 * h.stop();
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type TspApplyError, TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import { splitTspMessage, type TspHello } from "@oh-my-pi/pi-tui/native/encode";
import { Terminal, type TerminalIo, type TerminalIoSink } from "@oh-my-pi/pi-tui/terminal";
import { type RenderScheduler, type RenderTimer, TUI } from "@oh-my-pi/pi-tui/tui";
import { TSP_KINDS, type TspEvent, type TspFrame, type TspNode } from "@oh-my-pi/pi-wire";

export interface TspHarnessOptions {
	cols?: number;
	rows?: number;
	/** Kinds the terminal advertises (default: the whole vocabulary). */
	kinds?: readonly string[];
	/** Features the terminal advertises (default: blobs, settle, adopt, dock). */
	features?: readonly string[];
	credits?: number;
	/** APC body limit before chunking. */
	apc?: number;
	/** Answer the hello probe (false: the terminal doesn't speak TSP). */
	reply?: boolean;
	/** Acknowledge every frame automatically (default true). */
	autoAck?: boolean;
	reduceMotion?: boolean;
	/** The clock the terminal reports (`hour12`; default: none). */
	hour12?: boolean;
	/** The environment names Tern (`TERM_PROGRAM=tern`): the terminal reports `tspExpected`. */
	expected?: boolean;
	/** Never answer the probe on flush; the test calls {@link TspTestTerminal.answerProbe}. */
	manualProbe?: boolean;
	/** Start the TUI the way the startup prepaint does. */
	deferInput?: boolean;
	/** Blobs the terminal already holds (from an earlier connection). */
	heldBlobs?: readonly Uint8Array[];
	/**
	 * The terminal's blob cache folder: `blobs` queries also find blobs saved
	 * there. {@link TspHarness.start} exports it as `TERN_BLOB_DIR` (and
	 * unsets that variable without it) until {@link TspHarness.stop}.
	 */
	blobDir?: string;
	/** Answer `blobs` queries (default true). */
	answerBlobs?: boolean;
	/** Reject a blob whose `id` isn't the sha256 of its bytes, as Tern 0.5.3 and earlier do. */
	requireBlobId?: boolean;
}

/** The id Tern names a blob by. */
function blobId(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

interface Task {
	run: () => void;
	due: number;
	cancelled: boolean;
}

/** Deterministic scheduler: nothing runs until {@link ManualScheduler.flush}. */
export class ManualScheduler implements RenderScheduler {
	#tasks: Task[] = [];
	#now = 0;

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void): void {
		this.#tasks.push({ run: callback, due: this.#now, cancelled: false });
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const task: Task = { run: callback, due: this.#now + Math.max(0, delayMs), cancelled: false };
		this.#tasks.push(task);
		return {
			cancel: () => {
				task.cancelled = true;
			},
		};
	}

	/** Let `ms` pass without running anything (a blocked event loop). */
	advance(ms: number): void {
		this.#now += ms;
	}

	/** Run every task due now (and the ones they schedule), then those due within `advanceMs`. */
	flush(advanceMs = 0, extra?: () => boolean): void {
		const until = this.#now + advanceMs;
		for (let guard = 0; guard < 10_000; guard++) {
			if (extra?.()) continue;
			this.#tasks = this.#tasks.filter(task => !task.cancelled);
			let next: Task | undefined;
			for (const task of this.#tasks) if (task.due <= until && (!next || task.due < next.due)) next = task;
			if (!next) return;
			this.#tasks.splice(this.#tasks.indexOf(next), 1);
			this.#now = Math.max(this.#now, next.due);
			next.run();
		}
		throw new Error("scheduler did not settle");
	}
}

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

/** Primary device attributes query (the engine's probe sentinel) and a plain VT answer to it. */
const DA1_QUERY = /\x1b\[0?c/g;
const DA1_REPLY = "\x1b[?62;22c";

/** IO port of a {@link TspTestTerminal}: captured engine output in, queued terminal bytes out. */
class TspIo implements TerminalIo {
	readonly interactive = true;
	readonly backlog = 0;
	readonly columns: number;
	readonly rows: number;
	sink: TerminalIoSink | undefined;
	consume: (data: string) => void = () => {};

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
	}

	open(sink: TerminalIoSink): void {
		this.sink = sink;
	}

	write(chunks: readonly Uint8Array[]): void {
		for (const chunk of chunks) this.consume(utf8Decoder.decode(chunk, { stream: true }));
	}

	close(): void {
		this.sink = undefined;
	}
}

/**
 * A terminal that speaks TSP (or not) and keeps the documents it was sent.
 *
 * The production {@link Terminal} glue and native engine run unchanged: the
 * engine sends the `hello` probe and its DA1 sentinels as bytes, and this fake
 * answers them as bytes on stdin. DA1 queries are answered at once, except
 * those behind an unanswered `hello` query: a terminal answers in order, so
 * they wait for {@link TspTestTerminal.answerProbe}.
 */
export class TspTestTerminal extends Terminal {
	readonly #io: TspIo;
	readonly docs = new Map<string, TspDocument>();
	readonly frames: TspFrame[] = [];
	/** Every program → terminal message in order (chunks joined), with its JSON body (base64 text for `b`). */
	readonly log: { verb: string; body: unknown }[] = [];
	readonly errors: TspApplyError[] = [];
	readonly blobs = new Map<string, Uint8Array>();
	/** Non-TSP bytes written (capability probes, row painting, cursor control). */
	rowBytes = "";
	/** Id of the most recently opened surface still open. */
	surface: string | undefined;
	#options: TspHarnessOptions;
	/** A `hello` query arrived that {@link answerProbe} has not answered. */
	#pending = false;
	/** DA1 queries received behind the pending `hello` query. */
	#heldSentinels = 0;
	#inbox: string[] = [];
	#chunks = new Map<string, string>();
	#open: string[] = [];

	constructor(options: TspHarnessOptions) {
		const io = new TspIo(options.cols ?? 100, options.rows ?? 30);
		super(io, {
			tspExpected: options.expected === true,
			// The test runtime skips the probe; this terminal is there to answer it.
			// PI_TUI_NATIVE=1 forces it everywhere but tmux, whose marker is dropped.
			env: { ...Bun.env, TMUX: undefined, PI_TUI_NATIVE: "1" },
		});
		this.#io = io;
		this.#options = options;
		io.consume = data => this.#consume(data);
		for (const bytes of options.heldBlobs ?? []) this.blobs.set(blobId(bytes), bytes);
	}

	/** Whether the terminal holds blob `id`, loading it from the blob cache (verified) when it has it there. */
	#holdsBlob(id: string): boolean {
		if (this.blobs.has(id)) return true;
		const dir = this.#options.blobDir;
		if (!dir || !/^[0-9a-f]{64}$/.test(id)) return false;
		let bytes: Uint8Array;
		try {
			bytes = fs.readFileSync(path.join(dir, id));
		} catch {
			return false;
		}
		if (blobId(bytes) !== id) return false;
		this.blobs.set(id, bytes);
		return true;
	}

	/** Whether flushes answer the probe by themselves. */
	get answersProbe(): boolean {
		return this.#options.manualProbe !== true;
	}

	override async drainInput(): Promise<void> {}

	/**
	 * Resolve the probe the way a terminal answering (or ignoring) `hello` would;
	 * `reply` overrides fields of the reply built from the options.
	 */
	answerProbe(reply: Partial<TspHello> = {}): boolean {
		if (!this.#pending) return false;
		this.#pending = false;
		const hello: TspHello | null =
			this.#options.reply === false
				? null
				: {
						r: "hello",
						v: 1,
						term: "tern-test",
						kinds: this.#options.kinds ?? TSP_KINDS,
						features: this.#options.features ?? ["blobs", "settle", "adopt", "dock"],
						apc: this.#options.apc,
						credits: this.#options.credits,
						cols: this.#io.columns,
						dark: true,
						reduceMotion: this.#options.reduceMotion === true,
						hour12: this.#options.hour12,
						...reply,
					};
		// A terminal answers in order: the reply (if it speaks TSP), then the
		// sentinels queried behind it.
		if (hello !== null) this.send(`\x1b_tsp;r;${JSON.stringify(hello)}\x1b\\`);
		this.send(DA1_REPLY.repeat(Math.max(1, this.#heldSentinels)));
		this.#heldSentinels = 0;
		return true;
	}

	/** Queue terminal → program bytes (delivered on the next flush). */
	send(data: string): void {
		this.#inbox.push(data);
	}

	/** Deliver one queued input; false when the inbox is empty. */
	deliver(): boolean {
		const data = this.#inbox.shift();
		if (data === undefined) return false;
		this.#io.sink?.input(utf8Encoder.encode(data));
		return true;
	}

	/** Acknowledge every frame received so far. */
	ackAll(): void {
		const last = new Map<string, number>();
		for (const frame of this.frames) last.set(frame.sf, frame.s);
		for (const [sf, s] of last) this.send(tspEvent({ ev: "ack", sf, s }));
	}

	#consume(data: string): void {
		let at = 0;
		for (;;) {
			const start = data.indexOf("\x1b_tsp;", at);
			if (start === -1) break;
			const end = data.indexOf("\x1b\\", start);
			if (end === -1) throw new Error("unterminated TSP message in one write");
			this.#receiveRows(data.slice(at, start));
			this.#receive(data.slice(start, end + 2));
			at = end + 2;
		}
		this.#receiveRows(data.slice(at));
	}

	#receiveRows(data: string): void {
		if (data.length === 0) return;
		this.rowBytes += data;
		const sentinels = data.match(DA1_QUERY)?.length ?? 0;
		if (sentinels === 0) return;
		if (this.#pending) this.#heldSentinels += sentinels;
		else this.send(DA1_REPLY.repeat(sentinels));
	}

	#receive(sequence: string): void {
		const raw = splitTspMessage(sequence);
		if (!raw) throw new Error(`malformed TSP message: ${JSON.stringify(sequence.slice(0, 80))}`);
		let body = raw.body;
		const chunk = raw.params.c;
		if (chunk !== undefined) {
			const joined = (this.#chunks.get(chunk) ?? "") + body;
			if (raw.params.m === "1") {
				this.#chunks.set(chunk, joined);
				return;
			}
			this.#chunks.delete(chunk);
			body = joined;
		}
		const parsed: unknown = raw.verb === "b" ? body : JSON.parse(body);
		// The `hello` probe belongs to the terminal session, not the renderer:
		// it stays out of the log, which records what the surface backend sends.
		if (raw.verb === "q" && typeof parsed === "object" && parsed !== null && "q" in parsed && parsed.q === "hello") {
			this.#pending = true;
			return;
		}
		this.log.push({ verb: raw.verb, body: parsed });
		switch (raw.verb) {
			case "q": {
				const query = parsed as { q: string; ids?: string[] };
				if (query.q !== "blobs" || this.#options.answerBlobs === false) return;
				const have = (query.ids ?? []).filter(id => this.#holdsBlob(id));
				this.send(`\x1b_tsp;r;${JSON.stringify({ r: "blobs", have })}\x1b\\`);
				return;
			}
			case "o": {
				const open = JSON.parse(body) as { id: string; adopt?: boolean };
				if (open.adopt && !this.docs.has(open.id)) {
					this.send(tspEvent({ ev: "gone", ids: [open.id] }));
					return;
				}
				if (!open.adopt) this.docs.set(open.id, new TspDocument(open.id));
				this.#open.push(open.id);
				this.surface = open.id;
				return;
			}
			case "x": {
				const close = JSON.parse(body) as { id: string; keep: boolean };
				if (close.keep) this.docs.get(close.id)?.close();
				else this.docs.delete(close.id);
				this.#open = this.#open.filter(id => id !== close.id);
				this.surface = this.#open.at(-1);
				return;
			}
			case "f": {
				const frame = JSON.parse(body) as TspFrame;
				this.frames.push(frame);
				const doc = this.docs.get(frame.sf);
				if (!doc) throw new Error(`frame for unopened surface ${frame.sf}`);
				this.errors.push(...doc.applyFrame(frame));
				if (this.#options.autoAck !== false) this.send(tspEvent({ ev: "ack", sf: frame.sf, s: frame.s }));
				return;
			}
			case "b": {
				// Named by the sha256 of its bytes, as Tern names it.
				const bytes = Buffer.from(body, "base64");
				const id = blobId(bytes);
				if (this.#options.requireBlobId && raw.params.id !== id) return;
				this.blobs.set(id, bytes);
				return;
			}
			default:
				return;
		}
	}
}

/** Encode a terminal → program event. */
export function tspEvent(event: TspEvent): string {
	return `\x1b_tsp;e;${JSON.stringify(event)}\x1b\\`;
}

/** A TUI over {@link TspTestTerminal}. */
export class TspHarness {
	readonly tui: TUI;
	readonly terminal: TspTestTerminal;
	#scheduler: ManualScheduler;
	/** `TERN_BLOB_DIR` before {@link start} set it, restored by {@link stop}. */
	#blobDirBefore: { value: string | undefined } | undefined;

	constructor(terminal: TspTestTerminal, scheduler: ManualScheduler) {
		this.terminal = terminal;
		this.#scheduler = scheduler;
		this.tui = new TUI(terminal, false, { renderScheduler: scheduler });
	}

	/** Build the TUI, let `setup` populate it, start it and settle the handshake and first frame. */
	static async start(setup?: (tui: TUI) => void, options: TspHarnessOptions = {}): Promise<TspHarness> {
		const scheduler = new ManualScheduler();
		const harness = new TspHarness(new TspTestTerminal(options), scheduler);
		// The terminal's blob cache is the fake one, never the cache of a Tern running the tests.
		harness.#blobDirBefore = { value: Bun.env.TERN_BLOB_DIR };
		if (options.blobDir) Bun.env.TERN_BLOB_DIR = options.blobDir;
		else delete Bun.env.TERN_BLOB_DIR;
		setup?.(harness.tui);
		harness.tui.start({ deferInput: options.deferInput });
		harness.flush();
		return harness;
	}

	get frames(): readonly TspFrame[] {
		return this.terminal.frames;
	}

	get errors(): readonly TspApplyError[] {
		return this.terminal.errors;
	}

	/** Run queued renders, probe answers and terminal input until quiet. */
	flush(advanceMs = 0): void {
		const terminal = this.terminal;
		this.#scheduler.flush(advanceMs, () => (terminal.answersProbe && terminal.answerProbe()) || terminal.deliver());
	}

	/** Flush until `done()` holds, letting real async work (blob cache writes) run in between. */
	async until(done: () => boolean, timeoutMs = 2000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			this.flush();
			if (done()) return;
			if (Date.now() > deadline) throw new Error("condition not met in time");
			await Bun.sleep(1);
		}
	}

	/** The event loop was blocked for `ms`: when it resumes, due timers run before any queued input. */
	stall(ms: number): void {
		this.#scheduler.advance(ms);
		this.#scheduler.flush();
	}

	/** Request a render and settle. */
	async render(): Promise<void> {
		this.tui.requestRender();
		this.flush();
	}

	/** Deliver a terminal event and settle. */
	event(event: TspEvent): void {
		this.terminal.send(tspEvent(event));
		this.flush();
	}

	/** The live surface's document. */
	doc(): TspNode {
		const id = this.terminal.surface;
		const doc = id === undefined ? undefined : this.terminal.docs.get(id);
		if (!doc) throw new Error("no surface open");
		return doc.snapshot();
	}

	region(name: "main" | "dock" | "layer"): TspNode | undefined {
		return this.doc().c?.find(node => node.id === name);
	}

	byId(id: string): TspNode | undefined {
		return this.find(node => node.id === id);
	}

	find(predicate: (node: TspNode) => boolean): TspNode | undefined {
		return this.findAll(predicate)[0];
	}

	findAll(predicate: (node: TspNode) => boolean): TspNode[] {
		const out: TspNode[] = [];
		const visit = (node: TspNode): void => {
			if (predicate(node)) out.push(node);
			if (node.c) for (const child of node.c) visit(child);
		};
		visit(this.doc());
		return out;
	}

	stop(): void {
		this.tui.stop();
		this.flush();
		const before = this.#blobDirBefore;
		this.#blobDirBefore = undefined;
		if (!before) return;
		if (before.value === undefined) delete Bun.env.TERN_BLOB_DIR;
		else Bun.env.TERN_BLOB_DIR = before.value;
	}
}
