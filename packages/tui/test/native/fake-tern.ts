/**
 * A scripted Tern terminal for native-backend tests: a {@link TerminalDriver}
 * that decodes every APC message the program writes (joining chunks itself),
 * answers `hello` and `blobs` queries, keeps a model document per surface
 * that frames are applied to (rejecting invalid ops), acknowledges frames,
 * stores uploaded blobs by content address and sends events back. Inbound
 * messages queue until {@link FakeTern.pump}, as a real terminal answers
 * asynchronously; a {@link ManualClock} drives timers.
 */
import type { InputEvent, TerminalCapabilities, TerminalDriver } from "@oh-my-pi/pi-tui/driver/contract";
import type { NativeClock } from "@oh-my-pi/pi-tui/native/connection";
import { TSP_KINDS, type TspEvent, type TspFrame, type TspNode, type TspOp } from "@oh-my-pi/pi-wire";

export interface FakeTernOptions {
	cols?: number;
	/** Protocol version replied; default 1. */
	version?: number;
	features?: readonly string[];
	kinds?: readonly string[];
	apc?: number;
	credits?: number;
	/** Answer `hello` (default true). */
	reply?: boolean;
	/** Acknowledge frames as they arrive (default true). */
	autoAck?: boolean;
	/** Answer `blobs` queries (default true). */
	answerBlobs?: boolean;
	heldBlobs?: readonly Uint8Array[];
}

/** One message as the program wrote it, chunks joined. */
export interface Received {
	readonly verb: string;
	readonly params: Readonly<Record<string, string>>;
	readonly body: string;
	/** APC strings it took. */
	readonly chunks: number;
}

interface ModelNode {
	id: string;
	k: string;
	p: Record<string, unknown>;
	c: string[];
	parent: string | null;
}

export const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/**
 * A surface's document as the terminal holds it: only the surface's root
 * (its id) until the program adds the `main`, `dock` and `layer` regions.
 */
export class ModelDocument {
	readonly nodes = new Map<string, ModelNode>();
	readonly settled = new Set<string>();
	readonly reveals: [string, string][] = [];
	readonly scrolls: [string, string][] = [];
	focus: string | null = null;
	closed = false;
	readonly root: string;

	constructor(root: string) {
		this.root = root;
		this.nodes.set(root, { id: root, k: "col", p: {}, c: [], parent: null });
	}

	/** `x keep:true`: the live-only regions (`dock`, `layer`) and the focus go; `main` stays. */
	close(): void {
		const root = this.nodes.get(this.root)!;
		for (const region of ["dock", "layer"]) {
			if (this.nodes.get(region)?.parent !== this.root) continue;
			this.#remove(region);
			root.c = root.c.filter(id => id !== region);
		}
		this.focus = null;
		this.closed = true;
	}

	/** Apply `ops` in order; returns one message per rejected op. */
	apply(ops: readonly TspOp[]): string[] {
		const errors: string[] = [];
		for (const op of ops) {
			const error = this.#apply(op);
			if (error) errors.push(`${JSON.stringify(op).slice(0, 120)}: ${error}`);
		}
		return errors;
	}

	#insert(parent: ModelNode, id: string, before: string | null): string | undefined {
		if (before === null) parent.c.push(id);
		else {
			const at = parent.c.indexOf(before);
			if (at === -1) return `before ${before} is not a child of ${parent.id}`;
			parent.c.splice(at, 0, id);
		}
		return undefined;
	}

	#mount(node: TspNode, parent: string): string | undefined {
		if (this.nodes.has(node.id)) return `duplicate id ${node.id}`;
		this.nodes.set(node.id, { id: node.id, k: node.k, p: { ...node.p }, c: [], parent });
		for (const child of node.c ?? []) {
			const error = this.#mount(child, node.id);
			if (error) return error;
			this.nodes.get(node.id)!.c.push(child.id);
		}
		return undefined;
	}

	#remove(id: string): void {
		const node = this.nodes.get(id);
		if (!node) return;
		for (const child of node.c) this.#remove(child);
		this.nodes.delete(id);
		this.settled.delete(id);
	}

	#apply(op: TspOp): string | undefined {
		switch (op[0]) {
			case "add": {
				const [, id, parentId, before, node] = op;
				const parent = this.nodes.get(parentId);
				if (!parent) return "no parent";
				if (node.id !== id) return "id mismatch";
				const error = this.#mount(node, parentId);
				if (error) return error;
				return this.#insert(parent, id, before);
			}
			case "set": {
				const node = this.nodes.get(op[1]);
				if (!node) return "no node";
				for (const name in op[2]) {
					const value = op[2][name];
					if (value === null) delete node.p[name];
					else node.p[name] = value;
				}
				return undefined;
			}
			case "text": {
				const node = this.nodes.get(op[1]);
				if (!node) return "no node";
				node.p.text = op[2] === "append" ? `${(node.p.text as string | undefined) ?? ""}${op[3]}` : op[3];
				return undefined;
			}
			case "splice": {
				const node = this.nodes.get(op[1]);
				if (!node) return "no node";
				const text = (node.p.text as string | undefined) ?? "";
				node.p.text = text.slice(0, op[2]) + op[4] + text.slice(op[2] + op[3]);
				return undefined;
			}
			case "move": {
				const [, id, parentId, before] = op;
				const node = this.nodes.get(id);
				const parent = this.nodes.get(parentId);
				if (!node || !parent || node.parent === null) return "no node or parent";
				for (let p: ModelNode | undefined = parent; p; p = p.parent ? this.nodes.get(p.parent) : undefined)
					if (p.id === id) return "move into own subtree";
				if (before === id) return "before itself";
				const old = this.nodes.get(node.parent)!;
				old.c.splice(old.c.indexOf(id), 1);
				node.parent = parentId;
				return this.#insert(parent, id, before);
			}
			case "del": {
				const node = this.nodes.get(op[1]);
				if (!node || node.parent === null) return "no node";
				const parent = this.nodes.get(node.parent)!;
				parent.c.splice(parent.c.indexOf(op[1]), 1);
				this.#remove(op[1]);
				return undefined;
			}
			case "settle":
				if (!this.nodes.has(op[1])) return "no node";
				this.settled.add(op[1]);
				return undefined;
			case "focus":
				if (op[1] !== null && !this.nodes.has(op[1])) return "no node";
				this.focus = op[1];
				return undefined;
			case "reveal":
				if (!this.nodes.has(op[1])) return "no node";
				this.reveals.push([op[1], op[2]]);
				return undefined;
			case "scroll":
				if (!this.nodes.has(op[1])) return "no node";
				this.scrolls.push([op[1], op[2]]);
				return undefined;
			default:
				return undefined;
		}
	}

	/** The node `id` and its subtree, as on the wire (`p` omitted when empty). */
	tree(id: string): TspNode {
		const node = this.nodes.get(id);
		if (!node) throw new Error(`no node ${id}`);
		const out: Record<string, unknown> = { id, k: node.k };
		if (Object.keys(node.p).length > 0) out.p = node.p;
		if (node.c.length > 0) out.c = node.c.map(child => this.tree(child));
		return out as TspNode;
	}

	/** The tree below `id` without ids: what a fresh description must match. */
	shape(id: string): unknown {
		const strip = (node: TspNode): unknown => ({
			k: node.k,
			...(node.p ? { p: node.p } : {}),
			...(node.c ? { c: node.c.map(strip) } : {}),
		});
		return (this.tree(id).c ?? []).map(strip);
	}
}

interface Timer {
	readonly due: number;
	readonly fn: () => void;
	cancelled: boolean;
}

/** Deterministic timers: nothing runs until {@link ManualClock.advance}. */
export class ManualClock implements NativeClock {
	#now = 0;
	#timers: Timer[] = [];

	now(): number {
		return this.#now;
	}

	setTimeout(fn: () => void, ms: number): () => void {
		const timer: Timer = { due: this.#now + Math.max(0, ms), fn, cancelled: false };
		this.#timers.push(timer);
		return () => {
			timer.cancelled = true;
		};
	}

	/** Let `ms` pass, running timers as they come due (and the ones they schedule). */
	advance(ms = 0): void {
		const until = this.#now + ms;
		for (;;) {
			this.#timers = this.#timers.filter(timer => !timer.cancelled);
			let next: Timer | undefined;
			for (const timer of this.#timers) if (timer.due <= until && (!next || timer.due < next.due)) next = timer;
			if (!next) break;
			this.#timers.splice(this.#timers.indexOf(next), 1);
			this.#now = Math.max(this.#now, next.due);
			next.fn();
		}
		this.#now = until;
	}
}

const CAPABILITIES: TerminalCapabilities = {
	truecolor: true,
	colors: 16_777_216,
	synchronizedOutput: true,
	hyperlinks: true,
	images: null,
	kittyKeyboard: false,
	bracketedPaste: true,
	background: null,
	dark: true,
	cell: null,
	multiplexer: null,
	textSizing: false,
	tsp: true,
	emoji: { vs16Wide: false, bareFits: false },
	styledUnderlines: false,
};

/** See the module docs. */
export class FakeTern implements TerminalDriver {
	readonly columns: number;
	readonly rows = 30;
	readonly capabilities = CAPABILITIES;
	readonly options: FakeTernOptions;
	readonly docs = new Map<string, ModelDocument>();
	readonly received: Received[] = [];
	readonly frames: TspFrame[] = [];
	readonly errors: string[] = [];
	readonly blobs = new Map<string, Uint8Array>();
	/** Raw APC strings written. */
	readonly apc: string[] = [];
	#listeners = new Set<(event: InputEvent) => void>();
	#inbox: InputEvent[] = [];
	#chunks = new Map<string, { verb: string; params: Record<string, string>; body: string; count: number }>();

	constructor(options: FakeTernOptions = {}) {
		this.options = options;
		this.columns = options.cols ?? 80;
		for (const bytes of options.heldBlobs ?? []) this.blobs.set(sha256(bytes), bytes);
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	present(): number | undefined {
		return undefined;
	}
	onResize(): () => void {
		return () => {};
	}
	onCapabilities(): () => void {
		return () => {};
	}
	onReplay(): () => void {
		return () => {};
	}
	resetDisplay(): void {}
	setTitle(): void {}

	onInput(listener: (event: InputEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Messages of `verb`, bodies JSON-decoded (base64 text for `b`). */
	sent(verb: string): unknown[] {
		return this.received.filter(m => m.verb === verb).map(m => (verb === "b" ? m.body : JSON.parse(m.body)));
	}

	/** Every op of frames received from index `from` on. */
	opsSince(from: number): TspOp[] {
		return this.frames.slice(from).flatMap(frame => [...frame.ops]);
	}

	doc(id: string): ModelDocument {
		const doc = this.docs.get(id);
		if (!doc) throw new Error(`no surface ${id}`);
		return doc;
	}

	/** Queue terminal → program input (delivered by {@link pump}). */
	input(event: InputEvent): void {
		this.#inbox.push(event);
	}

	/** Queue an event as one APC message. */
	event(event: TspEvent): void {
		this.input({ type: "tsp", verb: "e", params: {}, body: JSON.stringify(event) });
	}

	/** Queue an event body split into chunked APC messages. */
	eventChunks(chunks: readonly string[]): void {
		chunks.forEach((part, i) =>
			this.input({
				type: "tsp",
				verb: "e",
				params: i < chunks.length - 1 ? { c: "z", m: "1" } : { c: "z" },
				body: part,
			}),
		);
	}

	/** Acknowledge every frame received so far. */
	ackAll(): void {
		const last = new Map<string, number>();
		for (const frame of this.frames) last.set(frame.sf, frame.s);
		for (const [sf, s] of last) this.event({ ev: "ack", sf, s });
	}

	/** Deliver queued input until none is left. */
	pump(): void {
		for (let guard = 0; guard < 10_000; guard++) {
			const event = this.#inbox.shift();
			if (!event) return;
			for (const listener of this.#listeners) listener(event);
		}
		throw new Error("input did not settle");
	}

	writeRaw(data: string): void {
		let at = 0;
		for (;;) {
			const start = data.indexOf("\x1b_tsp;", at);
			if (start === -1) break;
			const end = data.indexOf("\x1b\\", start);
			if (end === -1) throw new Error("unterminated APC");
			this.#apc(data.slice(start + 2, end));
			at = end + 2;
		}
	}

	#apc(payload: string): void {
		this.apc.push(payload);
		let rest = payload.slice(4);
		const semi = rest.indexOf(";");
		const verb = rest.slice(0, semi);
		rest = rest.slice(semi + 1);
		const params: Record<string, string> = {};
		for (let match = /^(\w+)=([^;]*);/.exec(rest); match; match = /^(\w+)=([^;]*);/.exec(rest)) {
			params[match[1]!] = match[2]!;
			rest = rest.slice(match[0].length);
		}
		if (params.c !== undefined) {
			const id = params.c;
			const entry = this.#chunks.get(id) ?? { verb, params: {}, body: "", count: 0 };
			if (entry.count === 0) for (const k in params) if (k !== "c" && k !== "m") entry.params[k] = params[k]!;
			entry.body += rest;
			entry.count++;
			if (params.m === "1") {
				this.#chunks.set(id, entry);
				return;
			}
			this.#chunks.delete(id);
			this.#receive({ verb: entry.verb, params: entry.params, body: entry.body, chunks: entry.count });
			return;
		}
		this.#receive({ verb, params, body: rest, chunks: 1 });
	}

	#reply(value: unknown): void {
		this.input({ type: "tsp", verb: "r", params: {}, body: JSON.stringify(value) });
	}

	#receive(message: Received): void {
		this.received.push(message);
		const o = this.options;
		switch (message.verb) {
			case "q": {
				const query = JSON.parse(message.body) as { q: string; ids?: string[] };
				if (query.q === "hello" && o.reply !== false) {
					this.#reply({
						r: "hello",
						v: o.version ?? 1,
						term: "fake-tern",
						kinds: o.kinds ?? TSP_KINDS,
						features: o.features ?? ["blobs", "settle", "adopt", "scroll"],
						apc: o.apc,
						credits: o.credits,
						cols: this.columns,
						dark: true,
					});
				} else if (query.q === "blobs" && o.answerBlobs !== false) {
					this.#reply({ r: "blobs", have: (query.ids ?? []).filter(id => this.blobs.has(id)) });
				}
				return;
			}
			case "o": {
				const open = JSON.parse(message.body) as { id: string; adopt?: boolean };
				const existing = this.docs.get(open.id);
				if (open.adopt) {
					if (!existing) this.event({ ev: "gone", ids: [open.id] });
					else existing.closed = false;
					return;
				}
				this.docs.set(open.id, new ModelDocument(open.id));
				return;
			}
			case "x": {
				const close = JSON.parse(message.body) as { id: string; keep: boolean };
				if (close.keep) this.docs.get(close.id)!.close();
				else this.docs.delete(close.id);
				return;
			}
			case "f": {
				const frame = JSON.parse(message.body) as TspFrame;
				this.frames.push(frame);
				const doc = this.docs.get(frame.sf);
				if (!doc) {
					this.errors.push(`frame for unopened surface ${frame.sf}`);
					return;
				}
				this.errors.push(...doc.apply(frame.ops));
				if (o.autoAck !== false) this.event({ ev: "ack", sf: frame.sf, s: frame.s });
				return;
			}
			case "b": {
				const bytes = Buffer.from(message.body, "base64");
				const id = sha256(bytes);
				if (message.params.id !== id) {
					this.errors.push(`blob id ${message.params.id} is not the sha256 of its bytes`);
					return;
				}
				this.blobs.set(id, bytes);
				return;
			}
		}
	}
}
