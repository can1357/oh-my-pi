/**
 * The `OMP_TUI_DEBUG` server: an NDJSON request/response socket (a Unix
 * socket, or a named pipe on Windows) through which the repository's `tui`
 * debug tool (`.omp/tools/tui.ts`) queries a running host and injects input.
 *
 * {@link startHost} loads this module only when `OMP_TUI_DEBUG` names an
 * endpoint. Queries read what the host last rendered: the terminal
 * renderer's presented frames (`text`, `frame`), the surface tree (`tree`,
 * `values`, `doc`), and the TSP frames a native surface sent (`tsp`).
 * Injected input is encoded as terminal bytes, decoded by the driver's
 * {@link InputDecoder}, and delivered to the driver's input listeners, so it
 * takes the path real input takes (interceptors, focus routing, `onKey`).
 */
import { type IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import type { TspFrame } from "@oh-my-pi/pi-wire";
import { keypathOf, pathTo } from "../dispatch";
import type { FramePlan, TerminalDriver } from "../driver/contract";
import type { ProcessTerminalDriver } from "../driver/index";
import { InputDecoder } from "../driver/input/decoder";
import type { UiNode } from "../node";
import { type Accessor, untrack } from "../reactive";
import type { Surface } from "../surface";
import { type PaintEnvironment, staticEnvironment } from "../term/paint";
import { widgetFor, widgetState } from "../term/widgets";
import { describeTree } from "../testing/corpus";
import type { Theme } from "../theme/contract";

/** One node of a `tree` response. */
export interface DebugTreeNode {
	kind: string;
	id?: string;
	focused?: boolean;
	focusable?: boolean;
	hidden?: boolean;
	children?: DebugTreeNode[];
}

/** A `layer` node of a `tree` response. */
export interface DebugOverlayNode {
	overlay: number;
	band?: unknown;
	hidden?: boolean;
	root: DebugTreeNode;
}

/** A `tree` response: the `main` and `dock` regions under one root, `layer` nodes as overlays. */
export interface DebugTree {
	root: DebugTreeNode;
	overlays: DebugOverlayNode[];
}

/** What the server inspects and drives. */
export interface DebugTarget {
	readonly surface: Surface;
	readonly driver: ProcessTerminalDriver;
	/** The surface renders natively (Tern): no terminal frames, TSP frames instead. */
	readonly native: boolean;
	readonly theme: Accessor<Theme>;
	/** The terminal renderer's paint environment (canvas nodes describe through its caches). */
	readonly environment?: PaintEnvironment;
	/** Stop the host (the `quit` op). */
	stop(): Promise<void>;
}

type DebugRequest = Record<string, unknown> & { op?: unknown };
type DebugResponse = { ok: boolean; [key: string]: unknown };

/** TSP frames kept for the `tsp` op. */
const TSP_LOG = 64;

const SPECIAL_KEYS: Readonly<Record<string, string>> = {
	enter: "\r",
	return: "\r",
	tab: "\t",
	esc: "\x1b",
	escape: "\x1b",
	space: " ",
	backspace: "\x7f",
	delete: "\x1b[3~",
	del: "\x1b[3~",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	home: "\x1b[H",
	end: "\x1b[F",
	pgup: "\x1b[5~",
	pageup: "\x1b[5~",
	pgdn: "\x1b[6~",
	pagedown: "\x1b[6~",
	insert: "\x1b[2~",
	f1: "\x1bOP",
	f2: "\x1bOQ",
	f3: "\x1bOR",
	f4: "\x1bOS",
	f5: "\x1b[15~",
	f6: "\x1b[17~",
	f7: "\x1b[18~",
	f8: "\x1b[19~",
	f9: "\x1b[20~",
	f10: "\x1b[21~",
	f11: "\x1b[23~",
	f12: "\x1b[24~",
};

function errorMessage(error: unknown): string {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return "debug operation failed";
	}
}

/** `sequence` with xterm modifier parameter `modifier` (1 = none). */
function modifiedSpecial(sequence: string, modifier: number): string {
	if (modifier === 1) return sequence;
	if (sequence === "\t" && (modifier & 1) === 0) {
		return modifier === 2 ? "\x1b[Z" : `\x1b[1;${modifier}Z`;
	}
	const csiFinal = /^\x1b\[([ABCDHF])$/.exec(sequence);
	if (csiFinal) return `\x1b[1;${modifier}${csiFinal[1]}`;
	const ss3Final = /^\x1bO([PQRS])$/.exec(sequence);
	if (ss3Final) return `\x1b[1;${modifier}${ss3Final[1]}`;
	const tilde = /^\x1b\[(\d+)~$/.exec(sequence);
	if (tilde) return `\x1b[${tilde[1]};${modifier}~`;
	// Enter/Space/Backspace/Escape have no legacy modified form: a plain byte
	// would drop the modifier (Shift+Enter would submit), so use Kitty CSI u.
	if (sequence.length === 1) return `\x1b[${sequence.charCodeAt(0)};${modifier}u`;
	return sequence;
}

function ctrlCharacter(character: string): string {
	const code = character.toUpperCase().charCodeAt(0);
	if ((code >= 64 && code <= 95) || code === 63) return String.fromCharCode(code === 63 ? 127 : code & 31);
	throw new Error(`cannot encode ctrl chord ${character}`);
}

/** The bytes a terminal sends for one chord token (`C-c`, `A-S-tab`, `enter`, `x`). */
function encodeChord(token: string): string {
	let rest = token;
	let ctrl = false;
	let alt = false;
	let shift = false;
	if (/^C-/i.test(rest)) {
		ctrl = true;
		rest = rest.slice(2);
	}
	if (/^(?:A|M)-/i.test(rest)) {
		alt = true;
		rest = rest.slice(2);
	}
	if (/^S-/i.test(rest)) {
		shift = true;
		rest = rest.slice(2);
	}
	if (rest.length === 0 || /^(?:C-|A-|M-|S-)/i.test(rest)) throw new Error(`invalid key token ${token}`);

	const name = rest.toLowerCase();
	const special = SPECIAL_KEYS[name];
	if (special !== undefined) {
		if (ctrl && name === "space") return alt ? "\x1b\x00" : "\x00";
		if (ctrl && name === "backspace") return alt ? "\x1b\x08" : "\x08";
		const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
		let encoded = modifiedSpecial(special, modifier);
		if (alt && encoded === special) encoded = `\x1b${encoded}`;
		return encoded;
	}
	if (Array.from(rest).length !== 1) throw new Error(`unknown key ${rest} (quote literal text instead, e.g. ',')`);
	let character = rest;
	if (shift && /^[a-z]$/i.test(character)) character = character.toUpperCase();
	if (ctrl) character = ctrlCharacter(character);
	return alt ? `\x1b${character}` : character;
}

/** A `keys` spec as one byte sequence per event: chord tokens, and quoted literals one per character. */
function parseKeyTokens(source: string): string[] {
	let offset = 0;
	const sequences: string[] = [];
	while (offset < source.length) {
		while (/\s/.test(source[offset] ?? "")) offset++;
		if (offset >= source.length) break;
		const quote = source[offset];
		if (quote === "'" || quote === '"') {
			offset++;
			let literal = "";
			while (offset < source.length && source[offset] !== quote) {
				if (source[offset] === "\\" && offset + 1 < source.length) offset++;
				literal += source[offset++];
			}
			if (source[offset] !== quote) throw new Error("unterminated quoted key literal");
			offset++;
			sequences.push(...Array.from(literal));
			continue;
		}
		const start = offset;
		while (offset < source.length && !/\s/.test(source[offset] ?? "")) offset++;
		sequences.push(encodeChord(source.slice(start, offset)));
	}
	return sequences;
}

/** SGR mouse report(s) for `action` at 0-based cell (`x`, `y`). */
function mouseSequence(x: number, y: number, action: string): string {
	if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0)
		throw new Error("mouse coordinates must be non-negative integers");
	const at = (button: number, release = false): string => `\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;
	switch (action) {
		case "click":
			return at(0) + at(0, true);
		case "right-click":
			return at(2) + at(2, true);
		case "middle-click":
			return at(1) + at(1, true);
		case "move":
			return at(35);
		case "drag":
			return at(32);
		case "release":
			return at(0, true);
		case "wheel-up":
			return at(64);
		case "wheel-down":
			return at(65);
		default:
			throw new Error(`unknown mouse action ${action}`);
	}
}

/** Wire props of `node`: without the terminal-only `term` prop and function values. */
function wireProps(node: UiNode): Record<string, unknown> {
	const props: Record<string, unknown> = { ...node.props() };
	delete props.term;
	for (const name in props) if (typeof props[name] === "function") delete props[name];
	return props;
}

/** See the module docs. */
export class DebugServer {
	readonly #path: string;
	#target: DebugTarget | undefined;
	#server: IpcServer | undefined;
	#listening: Promise<boolean> | undefined;
	#stopped = false;
	readonly #connections = new Set<IpcConnection>();
	/** Decodes injected bytes; holds nothing between requests (flushed after each sequence). */
	readonly #decoder = new InputDecoder({
		input: event => this.#target?.driver.inject(event),
		reply: () => {},
	});
	/** History rows the terminal acknowledged writing, in order (reset by a `replay` batch). */
	#history: string[] = [];
	#plan: FramePlan | undefined;
	readonly #frames: TspFrame[] = [];
	#environment: PaintEnvironment | undefined;

	constructor(path: string) {
		this.#path = path;
	}

	/** Resolves true once the socket accepts connections, false if listen failed or the server stopped first. */
	get ready(): Promise<boolean> {
		return this.#listening ?? Promise.resolve(false);
	}

	/**
	 * `driver` with its frames recorded: the terminal renderer presents
	 * through the result, so `text` and `frame` see what the terminal shows.
	 */
	tap(driver: TerminalDriver): TerminalDriver {
		const present = (plan: FramePlan): number | undefined => {
			const written = driver.present(plan);
			this.#presented(plan, written);
			return written;
		};
		return Object.create(driver, { present: { value: present } }) as TerminalDriver;
	}

	/** Record a TSP frame a native surface sent. */
	sent(frame: TspFrame): void {
		this.#frames.push(frame);
		if (this.#frames.length > TSP_LOG) this.#frames.shift();
	}

	/** Serve `target`: bind the socket (a live peer or unusable path leaves the host unaffected). */
	start(target: DebugTarget): void {
		this.#target = target;
		if (this.#listening !== undefined) return;
		this.#stopped = false;
		this.#listening = IpcServer.listen(this.#path, { framing: "lines" }, connection => this.#accept(connection)).then(
			server => {
				if (this.#stopped) {
					void server.close().catch(() => {});
					return false;
				}
				this.#server = server;
				return true;
			},
			() => false,
		);
	}

	stop(): void {
		this.#stopped = true;
		const server = this.#server;
		this.#server = undefined;
		this.#listening = undefined;
		for (const connection of this.#connections) connection.destroy();
		this.#connections.clear();
		this.#decoder.clear();
		void server?.close().catch(() => {});
	}

	#presented(plan: FramePlan, written: number | undefined): void {
		this.#plan = plan;
		const history = plan.history;
		if (!history || written !== history.id) return;
		const rows = history.rows.map(row => Bun.stripANSI(row));
		if (history.kind === "replay") this.#history = rows;
		else for (const row of rows) this.#history.push(row);
	}

	#accept(connection: IpcConnection): void {
		if (this.#stopped) {
			connection.destroy();
			return;
		}
		this.#connections.add(connection);
		connection.start(
			line => void this.#handleLine(connection, line),
			() => this.#connections.delete(connection),
		);
	}

	async #handleLine(connection: IpcConnection, line: string): Promise<void> {
		let request: DebugRequest;
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
				throw new Error("request must be an object");
			request = parsed as DebugRequest;
		} catch (error) {
			this.#write(connection, { ok: false, error: `malformed JSON: ${errorMessage(error)}` });
			return;
		}
		let response: DebugResponse;
		try {
			response = untrack(() => this.#dispatch(request));
		} catch (error) {
			response = { ok: false, error: errorMessage(error) };
		}
		this.#write(connection, response);
		if (request.op === "quit" && response.ok) {
			await connection.drained();
			await this.#target?.stop().catch(() => {});
			process.exit(0);
		}
	}

	#write(connection: IpcConnection, response: DebugResponse): void {
		let line: string;
		try {
			line = JSON.stringify(response);
		} catch (error) {
			line = JSON.stringify({ ok: false, error: errorMessage(error) });
		}
		connection.send(line);
	}

	/** Feed `data` through the decoder as one terminal read, delivering everything it holds. */
	#inject(data: string): void {
		this.#decoder.process(data);
		this.#decoder.flush();
	}

	#dispatch(request: DebugRequest): DebugResponse {
		const target = this.#target;
		if (!target) return { ok: false, error: "host not started" };
		if (typeof request.op !== "string") return { ok: false, error: `unknown op ${String(request.op)}` };
		switch (request.op) {
			case "text": {
				const plan = this.#plan;
				if (plan === undefined) {
					return {
						ok: false,
						error: target.native ? "native surface: the terminal renders it" : "no frame painted yet",
					};
				}
				const cursor = plan.cursor;
				return {
					ok: true,
					lines: this.#screen(plan),
					window_top: plan.fullscreen ? 0 : this.#history.length,
					alt_screen: plan.fullscreen !== undefined,
					...(cursor === null ? {} : { cursor: { x: cursor.col, y: cursor.row, visible: true } }),
				};
			}
			case "frame": {
				const plan = this.#plan;
				if (plan === undefined) {
					return {
						ok: false,
						error: target.native ? "native surface: the terminal renders it" : "no frame painted yet",
					};
				}
				return { ok: true, lines: [...this.#history, ...this.#screen(plan)] };
			}
			case "doc":
				return { ok: true, native: target.native, doc: this.#doc(target) };
			case "tsp": {
				const count = typeof request.n === "number" && request.n > 0 ? Math.trunc(request.n) : undefined;
				return {
					ok: true,
					native: target.native,
					frames: count === undefined ? [...this.#frames] : this.#frames.slice(-count),
				};
			}
			case "tree":
				return { ok: true, tree: this.#tree(target) };
			case "values":
				return { ok: true, values: this.#values(target) };
			case "info": {
				const focused = target.surface.focused();
				const cursor = this.#plan?.cursor;
				return {
					ok: true,
					columns: target.driver.columns,
					rows: target.driver.rows,
					pid: process.pid,
					native: target.native,
					overlays: target.surface.layer().length,
					focused: focused === null ? null : focused.kind,
					focus: focused === null ? null : this.#keypath(target, focused),
					alt_screen: this.#plan?.fullscreen !== undefined,
					cursor: cursor ? { x: cursor.col, y: cursor.row, visible: true } : { visible: false },
				};
			}
			case "keys": {
				if (typeof request.keys !== "string") throw new Error("keys must be a string");
				const sequences = parseKeyTokens(request.keys);
				for (const sequence of sequences) this.#inject(sequence);
				return { ok: true, injected: sequences.length };
			}
			case "bytes":
				if (typeof request.data !== "string") throw new Error("data must be a string");
				this.#inject(request.data);
				return { ok: true };
			case "paste":
				if (typeof request.text !== "string") throw new Error("text must be a string");
				target.driver.inject({ type: "paste", paste: { text: request.text } });
				return { ok: true };
			case "mouse": {
				if (typeof request.x !== "number" || typeof request.y !== "number")
					throw new Error("mouse x and y must be numbers");
				const action = request.action === undefined ? "click" : request.action;
				if (typeof action !== "string") throw new Error("mouse action must be a string");
				this.#inject(mouseSequence(request.x, request.y, action));
				return { ok: true };
			}
			case "quit":
				return { ok: true };
			default:
				return { ok: false, error: `unknown op ${request.op}` };
		}
	}

	/** The rows on screen in `plan`, as plain text. */
	#screen(plan: FramePlan): string[] {
		return (plan.fullscreen ?? plan.viewport).map(row => Bun.stripANSI(row));
	}

	/** `node`'s region and keypath (`dock:0/editor`), or null when it is not mounted. */
	#keypath(target: DebugTarget, node: UiNode): string | null {
		const { surface } = target;
		for (const [region, roots] of [
			["main", surface.main()],
			["dock", surface.dock()],
			["layer", surface.layer()],
		] as const) {
			const path = pathTo(roots, node);
			if (path.length === 0) continue;
			const top = roots.indexOf(path[0]!);
			const rest = keypathOf(path);
			return `${region}:${path[0]!.key() ?? top}${rest ? `/${rest}` : ""}`;
		}
		return null;
	}

	#node(node: UiNode, focused: UiNode | null): DebugTreeNode {
		const children = node.children();
		return {
			kind: node.kind,
			...(node.key() === undefined ? {} : { id: node.key() }),
			// Focusable: the terminal renderer routes keys to the node while it holds focus.
			...(widgetFor(node)?.key !== undefined
				? { focusable: true, focused: node === focused }
				: node === focused
					? { focused: true }
					: {}),
			...(node.props().hidden === true ? { hidden: true } : {}),
			...(children.length === 0 ? {} : { children: children.map(child => this.#node(child, focused)) }),
		};
	}

	#tree(target: DebugTarget): DebugTree {
		const { surface } = target;
		const focused = surface.focused();
		const region = (kind: string, nodes: readonly UiNode[]): DebugTreeNode => ({
			kind,
			...(nodes.length === 0 ? {} : { children: nodes.map(node => this.#node(node, focused)) }),
		});
		return {
			root: { kind: "surface", children: [region("main", surface.main()), region("dock", surface.dock())] },
			overlays: surface.layer().map((node, overlay) => {
				const props = node.props();
				const band = {
					...("anchor" in props && props.anchor !== undefined ? { anchor: props.anchor } : {}),
					...("size" in props && props.size !== undefined ? { size: props.size } : {}),
				};
				return {
					overlay,
					...(Object.keys(band).length === 0 ? {} : { band }),
					...(props.hidden === true ? { hidden: true } : {}),
					root: this.#node(node, focused),
				};
			}),
		};
	}

	/** Props and widget state of every interactive node (and the focused one), keyed `kind#key` or `kind[region:path]`. */
	#values(target: DebugTarget): Record<string, unknown> {
		const values: Record<string, unknown> = {};
		const focused = target.surface.focused();
		const visit = (node: UiNode, path: string): void => {
			if (node === focused || widgetFor(node) !== undefined) {
				const key = node.key();
				const state: Record<string, unknown> = {};
				for (const [name, value] of widgetState(node)) state[name] = value();
				values[key === undefined ? `${node.kind}[${path}]` : `${node.kind}#${key}`] = {
					...(node === focused ? { focused: true } : {}),
					props: wireProps(node),
					...(Object.keys(state).length === 0 ? {} : { state }),
				};
			}
			node.children().forEach((child, index) => {
				visit(child, `${path}.${index}`);
			});
		};
		const { surface } = target;
		for (const [region, roots] of [
			["main", surface.main()],
			["dock", surface.dock()],
			["layer", surface.layer()],
		] as const) {
			roots.forEach((node, index) => {
				visit(node, `${region}:${index}`);
			});
		}
		return values;
	}

	/** The surface as the native (TSP) trees its regions describe to, plus the focused node's keypath. */
	#doc(target: DebugTarget): Record<string, unknown> {
		const env = (this.#environment ??= target.environment ?? staticEnvironment(target.theme()));
		const cols = target.driver.columns;
		const { surface } = target;
		const focused = surface.focused();
		const describe = (nodes: readonly UiNode[]): unknown[] => nodes.map(node => describeTree(node, env, cols));
		return {
			main: describe(surface.main()),
			dock: describe(surface.dock()),
			layer: describe(surface.layer()),
			focus: focused === null ? null : this.#keypath(target, focused),
		};
	}
}
