/**
 * An {@link AppFrame} on an in-memory terminal for tests that construct the real
 * `InteractiveMode`: `new InteractiveMode(session, "test", …, term.frame)` starts its
 * shell on these streams instead of the process terminal. The bytes the renderer
 * writes feed kitty's VT engine, so assertions read the screen and scrollback a
 * user would see.
 */
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { memoryTerminal, type MemoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { Key, type KeyModifiers, KittyTerminal, loadModuleSync, type MouseEventSpec } from "kitty-vt-wasm";
import { AppFrame } from "../../src/modes/interactive/frame";
import type { Shell } from "../../src/ui/shell";
import { cfgComposerShape, cfgStartupQuiet } from "../../src/modes/settings";

const kittyModule = loadModuleSync(Bun.resolveSync("kitty-vt-wasm/kitty-vt.wasm", import.meta.dir));

/** How long the output must hold still before {@link ModeTerminal.settle} returns. */
const STABLE_MS = 40;

export interface ModeTerminalOptions {
	readonly columns?: number;
	readonly rows?: number;
	/** Composer shape and `startup.quiet` come from these settings (default: box, quiet). */
	readonly settings?: Settings;
	readonly version?: string;
}

export interface ModeTerminal {
	/** Hand to `new InteractiveMode(…, frame)`. */
	readonly frame: AppFrame;
	readonly memory: MemoryTerminal;
	readonly engine: KittyTerminal;
	/** Viewport rows as plain text, trailing blank rows trimmed. */
	screen(): string[];
	/** Rows scrolled into terminal history, plain text. */
	scrollback(): string[];
	/** Scrollback then viewport, one string. */
	text(): string;
	/**
	 * Start the frame's shell on the memory terminal, for a test that drives the mode without
	 * `InteractiveMode.init` (which starts it itself). Call before constructing the mode.
	 */
	start(): Promise<void>;
	/** Deliver raw terminal input. */
	feed(data: string): void;
	/** Press a key the way kitty encodes it under the modes the app set: `enter`, `ctrl+c`, `shift+tab`, `x`. */
	press(id: string): void;
	/** Type text one key per character. */
	type(text: string): void;
	/** A bracketed paste (as the terminal sends it). */
	paste(text: string): void;
	/** A mouse event at a viewport cell (0-based). */
	mouse(event: MouseEventSpec): void;
	resize(columns: number, rows: number): void;
	/** Resolves once the renderer has stopped writing for a short real-time window. */
	settle(): Promise<void>;
	/** Resolves once `ready` holds for the viewport rows (polled as frames arrive); throws with the screen after `timeoutMs`. */
	waitFor(ready: (screen: string[]) => boolean, timeoutMs?: number): Promise<void>;
	dispose(): void;
}

export function createModeTerminal(options: ModeTerminalOptions = {}): ModeTerminal {
	const columns = options.columns ?? 100;
	const rows = options.rows ?? 30;
	const engine = KittyTerminal.createSync({ columns, rows, scrollback: 2000, wasm: kittyModule, onEvent: () => {} });
	let disposed = false;
	// A shell still stopping may write after the test disposed the engine.
	const memory = memoryTerminal({ columns, rows, onWrite: data => disposed || engine.write(data) });
	const frame = new AppFrame({
		version: options.version ?? "test",
		shape: options.settings ? cfgComposerShape.get(options.settings) : "box",
		quiet: options.settings ? cfgStartupQuiet.get(options.settings) : true,
		terminal: { driver: memory.options, native: false },
	});
	const screen = (): string[] => {
		const lines: string[] = [];
		for (let y = 0; y < engine.rows; y++) lines.push(engine.line(y).trimEnd());
		while (lines.length > 0 && lines.at(-1) === "") lines.pop();
		return lines;
	};
	const scrollback = (): string[] => {
		const lines: string[] = [];
		for (let i = 0; i < engine.scrollbackLength; i++) lines.push((engine.scrollbackLine(i) ?? "").trimEnd());
		return lines;
	};
	return {
		frame,
		memory,
		engine,
		screen,
		scrollback,
		text: () => [...scrollback(), ...screen()].join("\n"),
		start: () => frame.start({ resizeScrollback: "rebuild" }),
		feed: data => memory.feed(data),
		press: id => memory.feed(encodeKey(engine, id)),
		type(text) {
			for (const char of text) memory.feed(engine.encodeKey(char));
		},
		paste: text => memory.feed(engine.paste(text)),
		mouse: event => memory.feed(engine.encodeMouse(event)),
		resize(nextColumns, nextRows) {
			engine.resize(nextColumns, nextRows);
			memory.resize(nextColumns, nextRows);
		},
		async settle() {
			let bytes = -1;
			let stableSince = Bun.nanoseconds() / 1e6;
			for (let round = 0; round < 200; round++) {
				await Bun.sleep(5);
				const now = Bun.nanoseconds() / 1e6;
				if (memory.bytes() !== bytes) {
					bytes = memory.bytes();
					stableSince = now;
				} else if (now - stableSince >= STABLE_MS) {
					return;
				}
			}
		},
		async waitFor(ready, timeoutMs = 5000) {
			const deadline = Bun.nanoseconds() / 1e6 + timeoutMs;
			while (!ready(screen())) {
				if (Bun.nanoseconds() / 1e6 > deadline)
					throw new Error(`screen never matched; viewport:\n${screen().join("\n")}`);
				await Bun.sleep(5);
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			engine.dispose();
		},
	};
}

const NAMED_KEYS: Record<string, Key | string> = {
	escape: Key.Escape,
	esc: Key.Escape,
	enter: Key.Enter,
	tab: Key.Tab,
	backspace: Key.Backspace,
	insert: Key.Insert,
	delete: Key.Delete,
	left: Key.ArrowLeft,
	right: Key.ArrowRight,
	up: Key.ArrowUp,
	down: Key.ArrowDown,
	pageup: Key.PageUp,
	pagedown: Key.PageDown,
	home: Key.Home,
	end: Key.End,
	space: " ",
};

function encodeKey(engine: KittyTerminal, id: string): string {
	const parts = id.split("+");
	const name = parts.pop()!;
	const mods: KeyModifiers = {};
	for (const part of parts) {
		if (part === "shift" || part === "alt" || part === "ctrl" || part === "super") mods[part] = true;
		else throw new Error(`unknown modifier ${part} in ${id}`);
	}
	const key = NAMED_KEYS[name] ?? name;
	return engine.encodeKey(key, mods);
}

/** `content` painted as plain terminal rows (`columns` wide, trailing blank rows trimmed). */
export function renderRows(content: () => JSXNode, columns = 120): string[] {
	const term = createTestTerminal(() => ({ main: content() }), { columns, rows: 2000 });
	try {
		const rows = term.screen();
		while (rows.length > 0 && rows.at(-1) === "") rows.pop();
		return rows;
	} finally {
		term.dispose();
	}
}

/** The whole transcript (retired blocks included) as plain text. */
export function transcriptText(shell: Shell, columns = 120): string {
	return renderRows(() => shell.transcript.nodes, columns).join("\n");
}

/**
 * Route key `id` (`enter`, `ctrl+e`, `j`) through `shell` synchronously, as the host routes a
 * decoded key: input interceptors first, then the focused node. Use it where a test must act
 * inside the current call (the terminal's byte stream decodes later).
 */
export function pressKey(shell: Shell, id: string): void {
	const text = [...id].length === 1 ? id : id === "space" ? " " : undefined;
	shell.input({ type: "key", key: { id, kind: "press", raw: text ?? "", ...(text ? { text } : {}) } });
}
