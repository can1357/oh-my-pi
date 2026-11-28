/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `startHost` in a Tern pane (`TERM_PROGRAM=tern`): the surface opens natively
 * right after the driver starts, before the `hello` reply (a loaded machine
 * reads it late), adopts the reply when it comes, and falls back to rows when
 * the terminal never confirms it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createSurface, type Host, nativeRendering, signal, startHost, type UiNode } from "@oh-my-pi/pi-tui";
import { encodeTspJson } from "@oh-my-pi/pi-tui/native/apc";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

type Listener = (...args: never[]) => void;

class Emitter {
	readonly #listeners = new Map<string, Set<Listener>>();
	on(event: string, listener: Listener): this {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(listener);
		return this;
	}
	off(event: string, listener: Listener): this {
		this.#listeners.get(event)?.delete(listener);
		return this;
	}
	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.#listeners.get(event) ?? []) (listener as (...values: unknown[]) => void)(...args);
	}
}

class Stdin extends Emitter {
	readonly isTTY = true;
	isRaw = false;
	setRawMode(mode: boolean): this {
		this.isRaw = mode;
		return this;
	}
	resume(): this {
		return this;
	}
	pause(): this {
		return this;
	}
}

class Stdout extends Emitter {
	columns = 40;
	rows = 10;
}

const DA1 = "\x1b[?62c";
const HELLO_REPLY = encodeTspJson("r", { r: "hello", v: 1, term: "tern", kinds: ["col", "text"], hour12: true });

/** `output` without its APC strings (TSP messages): what the terminal shows as rows. */
const rows = (output: string) => output.replace(/\x1b_[\s\S]*?\x1b\\/g, "");

const running: { host: Host; dispose(): void }[] = [];
afterEach(async () => {
	for (const entry of running.splice(0)) {
		await entry.host.stop();
		entry.dispose();
	}
});

/** A host on in-memory streams whose terminal answers nothing until the test feeds it. */
async function start(env: Record<string, string>, screen?: () => "inline" | "fullscreen") {
	const stdin = new Stdin();
	const writes: string[] = [];
	const surface = createSurface(() => ({ main: <text>hello there</text> }));
	const host = await startHost({
		surface,
		...(screen ? { screen } : {}),
		theme: () => loadThemeSync("dark"),
		driver: {
			env,
			platform: "darwin",
			conpty: false,
			tmux: () => null,
			probeTimeoutMs: 1,
			sink: { write: data => void writes.push(data), flush: () => Promise.resolve() },
			stdin,
			stdout: new Stdout(),
			events: new Emitter(),
		},
	});
	running.push({ host, dispose: () => surface.dispose() });
	let changes = 0;
	host.onChange(() => changes++);
	const out = () => writes.join("");
	return {
		host,
		out,
		/** TSP messages of `verb` written so far. */
		sent: (verb: string) => out().split(`\x1b_tsp;${verb};`).length - 1,
		feed: (data: string) => stdin.emit("data", Buffer.from(data)),
		raw: () => stdin.isRaw,
		changes: () => changes,
	};
}

describe("startHost optimistic native start in a Tern pane", () => {
	it("does not consult terminal fullscreen preferences or emit terminal controls for transcript actions on Tern", async () => {
		const h = await start({ TERM_PROGRAM: "tern" }, () => {
			throw new Error("terminal option read on Tern");
		});
		h.feed(HELLO_REPLY + DA1.repeat(3));
		await Bun.sleep(5);
		const before = h.out();
		expect(h.host.openSearch()).toBe(false);
		expect(h.host.copySelection()).toBe(false);
		expect(h.host.scroll("previous-prompt")).toBe(false);
		expect(h.out()).toBe(before);
		expect(before).not.toContain("\x1b[?1049h");
	});

	it("renders natively before the hello reply and stays native once it arrives", async () => {
		const h = await start({ TERM_PROGRAM: "tern" });
		// Nothing answered yet: the surface is already open and drawn natively.
		expect(h.host.native).toBe(true);
		expect(nativeRendering()).toBe(true);
		expect(h.host.hour12).toBeUndefined();
		expect(h.sent("o")).toBe(1);
		await Bun.sleep(5);
		expect(h.sent("f")).toBeGreaterThanOrEqual(1);
		// Drawn by the terminal from the frame, not painted as rows.
		expect(rows(h.out())).not.toContain("hello there");

		// The reply, then the DA1 sentinels of the startup probes, in order.
		h.feed(HELLO_REPLY);
		h.feed(DA1 + DA1 + DA1);
		expect(h.host.native).toBe(true);
		expect(h.host.hour12).toBe(true);
		expect(h.changes()).toBe(1);
		// Past the confirm deadline: still native, the surface never reopened.
		await Bun.sleep(1100);
		expect(h.host.native).toBe(true);
		expect(h.sent("o")).toBe(1);
		expect(h.sent("x")).toBe(0);
	});

	it("closes before lending the tty to a child, reopens on return, and drains again on normal exit", async () => {
		const h = await start({ TERM_PROGRAM: "tern" });
		h.feed(HELLO_REPLY + DA1.repeat(3));
		const suspended = h.host.suspend(async () => {
			expect(h.sent("x")).toBe(1);
			expect(h.raw()).toBe(false);
		});
		expect(h.sent("x")).toBe(1);
		expect(h.raw()).toBe(true);
		h.feed(DA1);
		await suspended;
		expect(h.sent("o")).toBe(2);
		expect(h.raw()).toBe(true);
		h.feed(HELLO_REPLY + DA1.repeat(3));
		const stopped = h.host.stop();
		expect(h.sent("x")).toBe(2);
		expect(h.out().endsWith("\x1b[c")).toBe(true);
		h.feed(DA1);
		await stopped;
		expect(h.raw()).toBe(false);
	});

	it("falls back to rows when DA1 answers before any hello reply", async () => {
		const h = await start({ TERM_PROGRAM: "tern" });
		expect(h.host.native).toBe(true);
		h.feed(DA1 + DA1 + DA1);
		expect(h.host.native).toBe(false);
		expect(nativeRendering()).toBe(false);
		expect(h.changes()).toBe(1);
		expect(h.out()).toContain('\x1b_tsp;x;{"id"');
		await Bun.sleep(40);
		expect(rows(h.out())).toContain("hello there");
	});

	it("falls back to rows when the terminal answers an unsupported version", async () => {
		const h = await start({ TERM_PROGRAM: "tern" });
		h.feed(encodeTspJson("r", { r: "hello", v: 2, term: "tern", kinds: [] }));
		expect(h.host.native).toBe(false);
	});

	it("falls back to rows when no reply comes within the confirm deadline", async () => {
		const h = await start({ TERM_PROGRAM: "tern" });
		await Bun.sleep(900);
		expect(h.host.native).toBe(true);
		await Bun.sleep(300);
		expect(h.host.native).toBe(false);
	});

	it("renders rows outside Tern when no reply comes", async () => {
		const plain = await start({});
		expect(plain.host.native).toBe(false);
		expect(plain.sent("o")).toBe(0);
	});

	it("renders rows in a Tern pane whose multiplexer swallows the hello", async () => {
		const h = await start({ TERM_PROGRAM: "tern", HERDR_ENV: "1" });
		expect(h.host.native).toBe(false);
		expect(h.sent("o")).toBe(0);
	});
});

describe("startHost in a plain terminal", () => {
	it("keeps keys typed while the terminal is probed for the focused editor", async () => {
		// A user typing as soon as omp starts: the keys arrive before any renderer listens.
		const stdin = new Stdin();
		const text = signal("");
		let field: UiNode | undefined;
		const surface = createSurface(() => ({
			dock: (
				<editor
					ref={node => (field = node)}
					text={text}
					onEdit={edit => {
						if (edit.type === "edit") text.set(text().slice(0, edit.from) + edit.text + text().slice(edit.to));
					}}
				/>
			),
		}));
		surface.focus(field!);
		const starting = startHost({
			surface,
			theme: () => loadThemeSync("dark"),
			driver: {
				env: {},
				platform: "darwin",
				conpty: false,
				tmux: () => null,
				probeTimeoutMs: 50,
				sink: { write: () => {}, flush: () => Promise.resolve() },
				stdin,
				stdout: new Stdout(),
				events: new Emitter(),
			},
		});
		stdin.emit("data", Buffer.from("hi"));
		stdin.emit("data", Buffer.from(DA1 + DA1 + DA1));
		const host = await starting;
		running.push({ host, dispose: () => surface.dispose() });
		expect(host.native).toBe(false);
		expect(text()).toBe("hi");
	});
});
