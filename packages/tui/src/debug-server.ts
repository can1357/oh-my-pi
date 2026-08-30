import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { type Component, isFocusable, type OverlayOptions, type TUI } from "./tui";
import { replaceTabs } from "./utils";

export interface TuiDebugTreeNode {
	kind: string;
	id?: string;
	rect?: [x: number, y: number, w: number, h: number];
	focused?: boolean;
	focusable?: boolean;
	hidden?: boolean;
	children?: TuiDebugTreeNode[];
}

export interface TuiDebugOverlayNode {
	overlay: number;
	band?: unknown;
	hidden?: boolean;
	root: TuiDebugTreeNode;
}

export interface TuiDebugTree {
	root: TuiDebugTreeNode;
	overlays: TuiDebugOverlayNode[];
}

type DebugRequest = Record<string, unknown> & { op?: unknown };
type DebugResponse = { ok: boolean; [key: string]: unknown };

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

function plainLine(line: string): string {
	return replaceTabs(Bun.stripANSI(line)).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function errorMessage(error: unknown): string {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return "debug operation failed";
	}
}

function componentChildren(component: Component): readonly Component[] {
	if (component.debugChildren !== undefined) return component.debugChildren;
	if (!("children" in component)) return [];
	const children = (component as Component & { children?: unknown }).children;
	if (!Array.isArray(children)) return [];
	return children.filter((child): child is Component => {
		return typeof child === "object" && child !== null && "render" in child && typeof child.render === "function";
	});
}

function componentKind(component: Component): string {
	return component.debugKind ?? component.constructor.name;
}

function serializableBand(options: OverlayOptions | undefined): unknown {
	if (options === undefined) return undefined;
	const { visible: _visible, ...band } = options;
	return band;
}

function modifiedSpecial(sequence: string, modifier: number): string {
	if (modifier === 1) return sequence;
	if (sequence === "\t" && (modifier & 1) === 0) {
		return modifier === 2 ? "\x1b[Z" : `\x1b[1;${modifier}Z`;
	}
	const csiFinal = sequence.match(/^\x1b\[([ABCDHF])$/);
	if (csiFinal) return `\x1b[1;${modifier}${csiFinal[1]}`;
	const ss3Final = sequence.match(/^\x1bO([PQRS])$/);
	if (ss3Final) return `\x1b[1;${modifier}${ss3Final[1]}`;
	const tilde = sequence.match(/^\x1b\[(\d+)~$/);
	if (tilde) return `\x1b[${tilde[1]};${modifier}~`;
	return sequence;
}

function ctrlCharacter(character: string): string {
	const code = character.toUpperCase().charCodeAt(0);
	if ((code >= 64 && code <= 95) || code === 63) return String.fromCharCode(code === 63 ? 127 : code & 31);
	throw new Error(`cannot encode ctrl chord ${character}`);
}

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
	if (Array.from(rest).length !== 1) throw new Error(`unknown key ${rest}`);
	let character = rest;
	if (shift && /^[a-z]$/i.test(character)) character = character.toUpperCase();
	if (ctrl) character = ctrlCharacter(character);
	return alt ? `\x1b${character}` : character;
}

function parseKeyTokens(source: string): { sequences: string[]; events: number } {
	let offset = 0;
	const sequences: string[] = [];
	let events = 0;
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
			events += Array.from(literal).length;
			continue;
		}
		const start = offset;
		while (offset < source.length && !/\s/.test(source[offset] ?? "")) offset++;
		sequences.push(encodeChord(source.slice(start, offset)));
		events++;
	}
	return { sequences, events };
}

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

/** NDJSON debug and input server enabled by the `OMP_TUI_DEBUG` socket path. */
export class TuiDebugServer {
	readonly #tui: TUI;
	readonly #path: string;
	#server: Server | undefined;
	#sockets = new Set<Socket>();

	constructor(tui: TUI, path: string) {
		this.#tui = tui;
		this.#path = path;
	}

	start(): void {
		if (this.#server !== undefined) return;
		try {
			if (existsSync(this.#path)) unlinkSync(this.#path);
		} catch {
			// The listen error below is isolated from the host application.
		}
		const server = createServer(socket => this.#accept(socket));
		this.#server = server;
		server.on("error", error => {
			void error;
		});
		try {
			server.listen(this.#path);
		} catch {
			this.#server = undefined;
			server.close();
		}
	}

	stop(): void {
		const server = this.#server;
		this.#server = undefined;
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		try {
			server?.close();
		} catch {
			// A failed or already-closed listener still needs its stale path removed.
		}
		try {
			if (existsSync(this.#path)) unlinkSync(this.#path);
		} catch {
			// Teardown must not affect the host application.
		}
	}

	#accept(socket: Socket): void {
		this.#sockets.add(socket);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (line.length > 0) this.#handleLine(socket, line);
				newline = buffer.indexOf("\n");
			}
		});
		socket.on("error", error => {
			void error;
		});
		socket.on("close", () => this.#sockets.delete(socket));
	}

	#handleLine(socket: Socket, line: string): void {
		let request: DebugRequest;
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
				throw new Error("request must be an object");
			request = parsed as DebugRequest;
		} catch (error) {
			this.#write(socket, { ok: false, error: `malformed JSON: ${errorMessage(error)}` });
			return;
		}
		try {
			const response = this.#dispatch(request);
			if (request.op === "quit" && response.ok) {
				this.#write(socket, response, () => {
					this.#tui.stop();
					process.exit(0);
				});
				return;
			}
			this.#write(socket, response);
		} catch (error) {
			this.#write(socket, { ok: false, error: errorMessage(error) });
		}
	}

	#write(socket: Socket, response: DebugResponse, flushed?: () => void): void {
		let line: string;
		try {
			line = JSON.stringify(response);
		} catch (error) {
			line = JSON.stringify({ ok: false, error: errorMessage(error) });
		}
		try {
			socket.write(`${line}\n`, flushed);
		} catch {
			// Broken clients cannot affect the TUI.
		}
	}

	#dispatch(request: DebugRequest): DebugResponse {
		if (typeof request.op !== "string") return { ok: false, error: `unknown op ${String(request.op)}` };
		switch (request.op) {
			case "text": {
				const paint = this.#tui.getDebugPaint();
				if (paint === undefined) return { ok: false, error: "no frame painted yet" };
				return {
					ok: true,
					lines: paint.lines.map(plainLine),
					window_top: paint.windowTop,
					alt_screen: paint.altScreen,
					...(paint.cursor === undefined ? {} : { cursor: paint.cursor }),
				};
			}
			case "frame":
				return { ok: true, lines: this.#tui.getDebugDocument().map(plainLine) };
			case "tree":
				return { ok: true, tree: this.#tree() };
			case "values":
				return { ok: true, values: this.#values() };
			case "info": {
				const paint = this.#tui.getDebugPaint();
				const focused = this.#tui.getFocused();
				return {
					ok: true,
					columns: this.#tui.terminal.columns,
					rows: this.#tui.terminal.rows,
					pid: process.pid,
					overlays: this.#tui.overlayStack.length,
					focused: focused === null ? null : componentKind(focused),
					alt_screen: paint?.altScreen ?? false,
					cursor: paint?.cursor ?? { visible: false },
				};
			}
			case "keys": {
				if (typeof request.keys !== "string") throw new Error("keys must be a string");
				const parsed = parseKeyTokens(request.keys);
				for (const sequence of parsed.sequences) this.#tui.injectDebugInput(sequence);
				return { ok: true, injected: parsed.events };
			}
			case "bytes":
				if (typeof request.data !== "string") throw new Error("data must be a string");
				this.#tui.injectDebugInput(request.data);
				return { ok: true };
			case "paste":
				if (typeof request.text !== "string") throw new Error("text must be a string");
				this.#tui.injectDebugInput(`\x1b[200~${request.text}\x1b[201~`);
				return { ok: true };
			case "mouse": {
				if (typeof request.x !== "number" || typeof request.y !== "number")
					throw new Error("mouse x and y must be numbers");
				const action = request.action === undefined ? "click" : request.action;
				if (typeof action !== "string") throw new Error("mouse action must be a string");
				this.#tui.injectDebugInput(mouseSequence(request.x, request.y, action));
				return { ok: true };
			}
			case "quit":
				return { ok: true };
			default:
				return { ok: false, error: `unknown op ${request.op}` };
		}
	}

	#node(component: Component): TuiDebugTreeNode {
		const children = componentChildren(component);
		const focusable = isFocusable(component);
		return {
			kind: componentKind(component),
			...(component.debugId === undefined ? {} : { id: component.debugId }),
			...(focusable ? { focusable: true, focused: component === this.#tui.getFocused() } : {}),
			...(children.length === 0 ? {} : { children: children.map(child => this.#node(child)) }),
		};
	}

	#tree(): TuiDebugTree {
		return {
			root: this.#node(this.#tui),
			overlays: this.#tui.overlayStack.map((entry, overlay) => ({
				overlay,
				...(entry.options === undefined ? {} : { band: serializableBand(entry.options) }),
				...(entry.hidden ? { hidden: true } : {}),
				root: this.#node(entry.component),
			})),
		};
	}

	#values(): Record<string, unknown> {
		const values: Record<string, unknown> = {};
		const visit = (component: Component, path: readonly number[]): void => {
			const kind = componentKind(component);
			if (component.debugState !== undefined) {
				const key = component.debugId === undefined ? `${kind}[${path.join(".")}]` : `${kind}#${component.debugId}`;
				values[key] = component.debugState();
			}
			componentChildren(component).forEach((child, index) => {
				visit(child, [...path, index]);
			});
		};
		visit(this.#tui, []);
		this.#tui.overlayStack.forEach((entry, index) => {
			visit(entry.component, [this.#tui.children.length + index]);
		});
		return values;
	}
}
