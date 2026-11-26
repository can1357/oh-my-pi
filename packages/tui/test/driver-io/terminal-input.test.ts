import { describe, expect, it } from "bun:test";
import type { InputEvent, TerminalCapabilities } from "../../src/driver/contract";
import { type ProcessInputOptions, ProcessTerminalInput } from "../../src/driver/process";
import { FakeClock } from "./fake-clock";

type Listener = (...args: never[]) => void;

class FakeEmitter {
	readonly listeners = new Map<string, Set<Listener>>();
	on(event: string, listener: Listener): this {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
		return this;
	}
	off(event: string, listener: Listener): this {
		this.listeners.get(event)?.delete(listener);
		return this;
	}
	count(event: string): number {
		return this.listeners.get(event)?.size ?? 0;
	}
	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(event) ?? []) (listener as (...values: unknown[]) => void)(...args);
	}
}

class FakeStdin extends FakeEmitter {
	readonly isTTY = true;
	isRaw = false;
	paused = true;
	rawError: NodeJS.ErrnoException | null = null;
	setRawMode(mode: boolean): this {
		if (this.rawError) throw this.rawError;
		this.isRaw = mode;
		return this;
	}
	resume(): this {
		this.paused = false;
		return this;
	}
	pause(): this {
		this.paused = true;
		return this;
	}
}

class FakeStdout extends FakeEmitter {
	columns = 100;
	rows = 30;
}

const DA1 = "\x1b[?62;22c";

function setup(options: Partial<ProcessInputOptions> = {}) {
	const clock = new FakeClock();
	const stdin = new FakeStdin();
	const stdout = new FakeStdout();
	const events = new FakeEmitter();
	const writes: string[] = [];
	const input = new ProcessTerminalInput(
		{ write: data => writes.push(data) },
		{ stdin, stdout, events, clock, env: {}, platform: "darwin", conpty: false, tmux: () => null, ...options },
	);
	const received: InputEvent[] = [];
	const capabilities: TerminalCapabilities[] = [];
	const resizes: [number, number][] = [];
	input.onInput(event => received.push(event));
	input.onCapabilities(caps => capabilities.push(caps));
	input.onResize((columns, rows) => resizes.push([columns, rows]));
	const feed = (...reads: string[]) => {
		for (const read of reads) stdin.emit("data", Buffer.from(read));
	};
	const bytes = (text: string) => {
		for (const ch of text) stdin.emit("data", ch);
	};
	const out = () => writes.join("");
	/** Answer the three startup sentinels (keyboard, background, modes). */
	const settle = () => feed(DA1, DA1, DA1);
	return { clock, stdin, stdout, events, writes, input, received, capabilities, resizes, feed, bytes, out, settle };
}

describe("ProcessTerminalInput lifecycle", () => {
	it("enters raw mode, enables bracketed paste (no focus reporting), and sends every startup probe behind DA1 sentinels", async () => {
		const h = setup();
		const started = h.input.start();
		expect(h.stdin.isRaw).toBe(true);
		expect(h.stdin.paused).toBe(false);
		const out = h.out();
		expect(out.startsWith("\x1b[?2004h\x1b[?1l\x1b>")).toBe(true);
		expect(out).not.toContain("\x1b[?1004h");
		expect(out).toContain("\x1b[?u\x1b[c");
		expect(out).toContain("\x1b]11;?\x07\x1b[c");
		for (const mode of [2026, 2048, 2031, 2004, 1010, 1011]) expect(out).toContain(`\x1b[?${mode}$p`);
		expect(out).toContain("\x1b[>0q");
		expect(out).toContain("\x1b[16t");
		// Image support comes from the terminal's identity (and the SIXEL geometry query), never a Kitty graphics probe.
		expect(out).toContain("\x1b[?2;1;0S");
		expect(out).not.toContain("\x1b_G");
		expect(out.match(/\x1b\[c/g)).toHaveLength(3);
		h.settle();
		await started;
		expect(h.received).toEqual([]);
	});

	it("resolves start after the bounded wait when the terminal never answers", async () => {
		const h = setup({ probeTimeoutMs: 250 });
		let done = false;
		const started = h.input.start().then(() => {
			done = true;
		});
		await Promise.resolve();
		expect(done).toBe(false);
		h.clock.advance(250);
		await started;
		expect(done).toBe(true);
	});

	it("restores modes, raw mode and listeners on stop", async () => {
		const h = setup();
		h.stdin.isRaw = false;
		const started = h.input.start();
		h.settle();
		await started;
		h.writes.length = 0;
		await h.input.stop();
		expect(h.out()).toContain("\x1b[?2004l\x1b[?5522l\x1b[?1006l\x1b[?1003l\x1b[?1000l\x1b[?1l\x1b>");
		expect(h.stdin.isRaw).toBe(false);
		expect(h.stdin.paused).toBe(true);
		expect(h.stdin.count("data")).toBe(0);
		expect(h.stdout.count("resize")).toBe(0);
		expect(h.events.count("SIGWINCH")).toBe(0);
		expect(h.events.count("exit")).toBe(0);
	});

	it("ignores a raw-mode restore failure on a revoked pty but propagates others", async () => {
		const revoked = setup();
		await Promise.all([revoked.input.start(), revoked.settle()]);
		revoked.stdin.rawError = Object.assign(new Error("EIO"), { code: "EIO" });
		await revoked.input.stop();

		const live = setup();
		await Promise.all([live.input.start(), live.settle()]);
		live.stdin.rawError = Object.assign(new Error("boom"), { code: "EPERM" });
		expect(() => live.input.stop()).toThrow("boom");
	});

	it("restores the terminal on process exit while running", async () => {
		const h = setup();
		await Promise.all([h.input.start(), h.settle()]);
		h.writes.length = 0;
		h.events.emit("exit");
		expect(h.out()).toContain("\x1b[?2004l");
		expect(h.stdin.isRaw).toBe(false);
	});
});

describe("ProcessTerminalInput keyboard negotiation", () => {
	it("pushes disambiguate + alternate keys when the kitty reply precedes DA1", () => {
		const h = setup();
		void h.input.start();
		h.writes.length = 0;
		h.feed("\x1b[?0u", DA1);
		expect(h.out()).toContain("\x1b[>5u");
		expect(h.out()).not.toContain("\x1b[>4;2m");
		expect(h.input.capabilities.kittyKeyboard).toBe(true);
	});

	it("keeps event types only when a parent already enabled them", () => {
		const a = setup();
		void a.input.start();
		a.feed("\x1b[?3u");
		expect(a.out()).toContain("\x1b[>7u");
		const b = setup();
		void b.input.start();
		b.feed("\x1b[?5u");
		expect(b.out()).toContain("\x1b[>5u");
	});

	it("replaces the modifyOtherKeys fallback when the kitty reply arrives after DA1", () => {
		const h = setup();
		void h.input.start();
		h.feed(DA1, "\x1b[?0u");
		const out = h.out();
		const enable = out.indexOf("\x1b[>4;2m");
		expect(enable).toBeGreaterThan(0);
		expect(out.indexOf("\x1b[>4;0m")).toBeGreaterThan(enable);
		expect(out.indexOf("\x1b[>5u")).toBeGreaterThan(enable);
	});

	it("falls back to modifyOtherKeys when only DA1 answers, including under tmux", () => {
		for (const env of [{}, { TMUX: "/tmp/t,1,0" }]) {
			const h = setup({ env });
			void h.input.start();
			h.feed(DA1);
			expect(h.out()).toContain("\x1b[>4;2m");
			expect(h.input.capabilities.kittyKeyboard).toBe(false);
			expect(h.input.keyboardScreenModes()).toEqual({
				enterAlt: "\x1b[>4;2m",
				leaveAltBefore: "",
				leaveAltAfter: "",
			});
		}
	});

	it("skips modifyOtherKeys for an unknown terminal behind SSH", () => {
		const h = setup({ env: { SSH_CONNECTION: "a 1 b 22" } });
		void h.input.start();
		h.feed(DA1);
		expect(h.out()).not.toContain("\x1b[>4;2m");
	});

	it("uses disambiguation only on ConPTY, keeping parent event types", () => {
		const a = setup({ conpty: true });
		void a.input.start();
		a.feed("\x1b[?0u");
		expect(a.out()).toContain("\x1b[>1u");
		const b = setup({ conpty: true });
		void b.input.start();
		b.feed("\x1b[?2u");
		expect(b.out()).toContain("\x1b[>3u");
	});

	it("gives the writer per-screen kitty bytes and pops the single push on stop", async () => {
		const h = setup();
		void h.input.start();
		h.feed("\x1b[?1u", DA1, DA1, DA1);
		expect(h.input.keyboardScreenModes()).toEqual({
			enterAlt: "\x1b[>5u",
			leaveAltBefore: "\x1b[<u",
			leaveAltAfter: "\x1b[=5;1u",
		});
		await h.input.stop();
		expect(h.writes.filter(write => write.includes("\x1b[>5u"))).toHaveLength(1);
		expect(h.out().match(/\x1b\[<u/g)).toHaveLength(1);
	});

	it("enables win32-input-mode on a native console and decodes its key records", async () => {
		const h = setup({ conpty: true, nativeWindowsConsole: true, platform: "win32" });
		void h.input.start();
		h.feed(DA1);
		expect(h.out()).toContain("\x1b[?9001h");
		expect(h.out()).not.toContain("\x1b[>4;2m");
		h.feed("\x1b[13;28;13;1;16;1_", "\x1b[13;28;13;0;0;1_", "\x1b[13;28;10;1;8;1_");
		expect(h.received.map(event => (event.type === "key" ? event.key.id : event.type))).toEqual([
			"shift+enter",
			"ctrl+enter",
		]);
		await h.input.stop();
		expect(h.out()).toContain("\x1b[?9001l");
	});

	it("decodes a win32 Enter when its ESC timer expires before stdin delivers the rest", () => {
		const h = setup({ conpty: true, nativeWindowsConsole: true, platform: "win32", decoder: { keyTimeout: 20 } });
		void h.input.start();
		h.settle();
		h.feed("\x1b");
		// The expiry runs first, then the stdin read, then any timer scheduled by the expiry.
		h.clock.schedule(20, () => h.feed("[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_"));
		h.clock.advance(50);
		expect(h.received.map(event => (event.type === "key" ? event.key.id : event.type))).toEqual(["enter"]);

		h.feed("\x1b");
		h.clock.advance(50);
		expect(h.received.map(event => (event.type === "key" ? event.key.id : event.type))).toEqual(["enter", "escape"]);
	});

	it("turns win32-input-mode back off when a late kitty reply arrives", () => {
		const h = setup({ conpty: true, nativeWindowsConsole: true, platform: "win32" });
		void h.input.start();
		h.feed(DA1, "\x1b[?0u");
		expect(h.out()).toContain("\x1b[?9001l\x1b[>1u");
		h.feed("\x1b[13;2u");
		expect(h.received.at(-1)).toMatchObject({ type: "key", key: { id: "shift+enter" } });
	});

	it("requests win32-input-mode alongside modifyOtherKeys under WSL", () => {
		const h = setup({
			env: { WSL_DISTRO_NAME: "Ubuntu" },
			platform: "linux",
			conpty: true,
			nativeWindowsConsole: false,
		});
		void h.input.start();
		h.feed(DA1);
		expect(h.out()).toContain("\x1b[?9001h");
		expect(h.out()).toContain("\x1b[>4;2m");
	});
});

describe("ProcessTerminalInput probe replies", () => {
	it("consumes every reply, split byte by byte, without leaking input", async () => {
		const h = setup();
		const started = h.input.start();
		h.bytes("\x1b[?5u");
		h.bytes("\x1b]11;rgb:1c1c/1c1c/1c1c\x1b\\");
		h.bytes("\x1b[?2026;2$y\x1b[?2048;2$y\x1b[?2031;2$y\x1b[?2004;2$y\x1b[?1010;1$y\x1b[?1011;2$y");
		h.bytes("\x1bP>|kitty(0.39.1)\x1b\\");
		h.bytes("\x1b[6;18;9t");
		h.bytes("\x1b_Gi=31;OK\x1b\\");
		h.bytes(DA1);
		h.bytes(DA1);
		h.bytes(DA1);
		await started;
		h.bytes(DA1);
		expect(h.received).toEqual([]);
		const caps = h.input.capabilities;
		expect(caps).toMatchObject({
			kittyKeyboard: true,
			background: { r: 28, g: 28, b: 28 },
			dark: true,
			synchronizedOutput: true,
			bracketedPaste: true,
			cell: { w: 9, h: 18 },
			// A Kitty graphics reply is swallowed but upgrades nothing: the identity decides.
			images: null,
		});
		expect(h.input.identity.version).toBe("kitty(0.39.1)");
		const out = h.out();
		expect(out).toContain("\x1b[?2048h");
		expect(out).toContain("\x1b[?2031h");
		expect(out).toContain("\x1b[?1010l");
		expect(out).not.toContain("\x1b[?1011l");
		h.writes.length = 0;
		await h.input.stop();
		expect(h.out()).toContain("\x1b[?2048l");
		expect(h.out()).toContain("\x1b[?2031l");
		expect(h.out()).toContain("\x1b[?1010h");
	});

	it("reports modes the terminal does not support", () => {
		const h = setup();
		void h.input.start();
		h.feed("\x1b[?2026;0$y\x1b[?2004;4$y\x1b[?2048;0$y");
		expect(h.input.capabilities.synchronizedOutput).toBe(false);
		expect(h.input.capabilities.bracketedPaste).toBe(false);
		expect(h.out()).not.toContain("\x1b[?2048h");
	});

	it("lets the user's sync-output override beat DECRQM", () => {
		const h = setup({ env: { PI_NO_SYNC_OUTPUT: "1" } });
		void h.input.start();
		h.feed("\x1b[?2026;2$y");
		expect(h.input.capabilities.synchronizedOutput).toBe(false);
	});

	it("matches DA1 sentinels in send order: keyboard first, then background", () => {
		const h = setup();
		void h.input.start();
		h.feed(DA1);
		h.feed("\x1b]11;rgb:ffff/ffff/ffff\x07");
		expect(h.input.capabilities).toMatchObject({ dark: false, background: { r: 255, g: 255, b: 255 } });
		h.feed(DA1);
		expect(h.received).toEqual([]);
	});

	it("queues an appearance refresh behind the in-flight query until its sentinel", () => {
		const h = setup();
		void h.input.start();
		const queries = () => h.writes.filter(write => write.includes("\x1b]11;?")).length;
		h.input.refreshAppearance();
		h.input.refreshAppearance();
		expect(queries()).toBe(1);
		h.feed(DA1);
		expect(queries()).toBe(1);
		h.feed(DA1);
		expect(queries()).toBe(2);
	});

	it("expires an unanswered background query before sending the queued one", () => {
		const h = setup({ replyTimeoutMs: 5000 });
		void h.input.start();
		const queries = () => h.writes.filter(write => write.includes("\x1b]11;?")).length;
		h.input.refreshAppearance();
		h.clock.advance(5000);
		expect(queries()).toBe(2);
	});

	it("takes Mode 2031 notifications at once and re-queries the background once, debounced", () => {
		const h = setup();
		void h.input.start();
		h.settle();
		const queries = () => h.writes.filter(write => write.includes("\x1b]11;?")).length;
		const before = queries();
		h.feed("\x1b[?997;2n", "\x1b[?997;2n", "\x1b[?997;2n");
		expect(h.input.capabilities.dark).toBe(false);
		expect(queries()).toBe(before);
		h.clock.advance(100);
		expect(queries()).toBe(before + 1);
		h.clock.advance(10 * 60_000);
		expect(queries()).toBe(before + 1);
	});

	it("polls the background under Windows Terminal without Mode 2031", () => {
		const h = setup({ platform: "win32", env: { WT_SESSION: "x" }, conpty: true, nativeWindowsConsole: false });
		void h.input.start();
		h.feed("\x1b[?2031;0$y");
		h.settle();
		const queries = () => h.writes.filter(write => write.includes("\x1b]11;?")).length;
		const before = queries();
		h.clock.advance(30_000);
		expect(queries()).toBe(before + 1);
	});

	it("applies DEC 2048 in-band resize reports and the cell size they imply", () => {
		const h = setup();
		void h.input.start();
		h.feed("\x1b[?2048;2$y");
		h.bytes("\x1b[48;40;120;800;1200t");
		expect(h.resizes).toEqual([[120, 40]]);
		expect(h.input.capabilities.cell).toEqual({ w: 10, h: 20 });
		h.feed("\x1b[48;40;120;800;1200t");
		expect(h.resizes).toHaveLength(1);
	});

	it("enables SIXEL from DA1 plus a positive XTSMGRAPHICS geometry", () => {
		const h = setup();
		void h.input.start();
		h.bytes("\x1b[?2;0;1000;800S");
		h.feed("\x1b[?62;4;22c");
		expect(h.input.capabilities.images).toBe("sixel");

		const denied = setup();
		void denied.input.start();
		denied.feed("\x1b[?2;3;0;0S", "\x1b[?62;4;22c", DA1, DA1);
		expect(denied.input.capabilities.images).toBeNull();
	});

	it("marks TSP from the hello reply and still forwards it", () => {
		const hello = '\x1b_tsp;q;{"q":"hello","v":[1],"app":"omp"}\x1b\\';
		const h = setup({ hello });
		void h.input.start();
		expect(h.out()).toContain(`${hello}\x1b[c`);
		h.bytes('\x1b_tsp;r;{"r":"hello","v":1,"term":"tern","kinds":[]}\x1b\\');
		expect(h.input.capabilities.tsp).toBe(true);
		expect(h.received).toEqual([
			{ type: "tsp", verb: "r", params: {}, body: '{"r":"hello","v":1,"term":"tern","kinds":[]}' },
		]);
	});

	it("answers cursor queries 0-based, and null when the terminal stays silent", async () => {
		const h = setup();
		void h.input.start();
		const position = h.input.queryCursor();
		expect(h.out()).toContain("\x1b[6n");
		h.bytes("\x1b[12;40R");
		expect(await position).toEqual({ row: 11, col: 39 });
		const silent = h.input.queryCursor();
		h.clock.advance(500);
		expect(await silent).toBeNull();
		h.feed("\x1b[1;5R");
		expect(h.received.at(-1)).toMatchObject({ type: "key", key: { id: "ctrl+f3" } });
	});

	it("forgets what the terminal answered when stopped", async () => {
		const h = setup();
		void h.input.start();
		h.feed("\x1b]11;rgb:ffff/ffff/ffff\x07", "\x1b[?0u");
		await h.input.stop();
		expect(h.input.capabilities).toMatchObject({ background: null, dark: true, kittyKeyboard: false });
	});
});

describe("ProcessTerminalInput input, resize, title and mouse", () => {
	it("delivers keys, pastes, mouse and focus to listeners", () => {
		const h = setup();
		void h.input.start();
		h.feed("x", "\x1b[200~pasted\x1b[201~", "\x1b[<0;3;2M", "\x1b[I");
		expect(h.received).toEqual([
			{ type: "key", key: { id: "x", kind: "press", raw: "x", text: "x" } },
			{ type: "paste", paste: { text: "pasted" } },
			{ type: "mouse", mouse: { row: 1, col: 2, button: "left", action: "press", mods: [] } },
			{ type: "focus", focused: true },
		]);
	});

	it("coalesces an unbracketed burst unless the loop was stalled", () => {
		let stalled = false;
		const h = setup({ isLoopStalled: () => stalled });
		void h.input.start();
		h.feed("1. a\r2. b\r3. c");
		expect(h.received).toEqual([{ type: "paste", paste: { text: "1. a\r2. b\r3. c" } }]);
		stalled = true;
		h.received.length = 0;
		h.feed("a\rb\rc");
		h.clock.advance(0);
		expect(h.received.map(event => (event.type === "key" ? event.key.id : event.type))).toEqual([
			"a",
			"enter",
			"b",
			"enter",
			"c",
		]);
	});

	it("fires resize on SIGWINCH/resize only when the size changed", () => {
		const h = setup();
		void h.input.start();
		h.stdout.columns = 120;
		h.stdout.emit("resize");
		h.events.emit("SIGWINCH");
		expect(h.resizes).toEqual([[120, 30]]);
		expect(h.input.columns).toBe(120);
		expect(h.input.rows).toBe(30);
	});

	it("saves the title once, sanitizes it, and restores it on stop", async () => {
		const h = setup();
		void h.input.start();
		h.writes.length = 0;
		h.input.setTitle("omp\x1b]evil\x07 — work");
		h.input.setTitle("next");
		expect(h.writes).toEqual(["\x1b[22;0t\x1b]0;omp]evil — work\x07", "\x1b]0;next\x07"]);
		await h.input.stop();
		expect(h.out()).toContain("\x1b[23;0t");
	});

	it("switches mouse tracking and turns it off on stop", async () => {
		const h = setup();
		void h.input.start();
		h.writes.length = 0;
		h.input.setMouse("click");
		h.input.setMouse("any");
		h.input.setMouse("any");
		expect(h.writes).toEqual(["\x1b[?1000h\x1b[?1006h", "\x1b[?1000l\x1b[?1003h\x1b[?1006h"]);
		await h.input.stop();
		expect(h.out()).toContain("\x1b[?1003l\x1b[?1006l");
	});

	it("wraps passthrough for the multiplexer it runs in", () => {
		expect(setup({ env: { TMUX: "/tmp/t,1,0" } }).input.passthrough("\x1b]9;x\x07")).toBe(
			"\x1bPtmux;\x1b\x1b]9;x\x07\x1b\\",
		);
		expect(setup().input.passthrough("\x1b]9;x\x07")).toBe("\x1b]9;x\x07");
	});

	it("resolves the terminal behind tmux through the client lookup", () => {
		const h = setup({
			env: { TMUX: "/tmp/t,1,0", TERM_PROGRAM: "tmux", TERM: "tmux-256color" },
			tmux: args => (args[0] === "display-message" ? "ghostty 1.2\txterm-ghostty" : "on"),
		});
		expect(h.input.identity).toMatchObject({ id: "ghostty", multiplexer: "tmux" });
		expect(h.input.capabilities).toMatchObject({ images: "kitty", multiplexer: "tmux" });
	});
});

describe("ProcessTerminalInput terminal quirks", () => {
	const started = async (options: Partial<ProcessInputOptions> = {}) => {
		const h = setup(options);
		const done = h.input.start();
		h.settle();
		await done;
		return h;
	};

	it("normalizes cursor keys and keypad on entry and exit, and guards the startup probes", async () => {
		const h = setup();
		const done = h.input.start();
		const out = h.out();
		expect(out.startsWith("\x1b[?2004h\x1b[?1l\x1b>\x1b7\x1b[?7l\x1b[8m")).toBe(true);
		// Every query of the batch sits between the guard's begin and end.
		const end = out.indexOf("\x1b[28m\x1b[?7h\x1b8");
		expect(end).toBeGreaterThan(out.lastIndexOf("\x1b[c"));
		h.settle();
		await done;
		h.writes.length = 0;
		await h.input.stop();
		// Paste modes off (bracketed, and the enhanced one an app may have asked for), mouse reporting, then the keypad.
		expect(h.out()).toContain("\x1b[?2004l\x1b[?5522l\x1b[?1006l\x1b[?1003l\x1b[?1000l\x1b[?1l\x1b>");
	});

	it("re-asserts bracketed paste before reads inside tmux, never mid-paste", async () => {
		const h = await started({ env: { TMUX: "/tmp/tmux,1,0" } });
		expect(h.input.rearmsPaste).toBe(true);
		h.writes.length = 0;
		h.feed("a");
		expect(h.out()).toBe("\x1b[?2004h");
		h.writes.length = 0;
		h.feed("\x1b[200~one");
		h.feed(" two");
		expect(h.out()).toBe("\x1b[?2004h");
		h.feed("\x1b[201~");
		await h.input.stop();
		expect(h.input.rearmsPaste).toBe(false);
	});

	it("re-asserts bracketed paste once the terminal confirms it, outside multiplexers too", async () => {
		const h = await started();
		expect(h.input.rearmsPaste).toBe(false);
		h.feed("\x1b[?2004;2$y");
		expect(h.input.rearmsPaste).toBe(true);
	});

	it("keeps synchronized output on in Herdr whatever DECRQM says", async () => {
		const h = await started({ env: { HERDR_ENV: "1" } });
		h.feed("\x1b[?2026;0$y");
		expect(h.input.capabilities.synchronizedOutput).toBe(true);
	});

	it("does not trust OSC 11 through Zellij on macOS", async () => {
		const h = setup({ env: { ZELLIJ: "0" }, platform: "darwin" });
		const done = h.input.start();
		expect(h.out()).not.toContain("\x1b]11;?");
		h.feed(DA1, DA1);
		await done;
		h.feed("\x1b]11;rgb:ffff/ffff/ffff\x07");
		expect(h.input.capabilities.background).toBeNull();
		const linux = setup({ env: { ZELLIJ: "0" }, platform: "linux" });
		void linux.input.start();
		expect(linux.out()).toContain("\x1b]11;?");
	});

	it("uses Zellij's 996 light report over a conflicting forwarded host background", () => {
		const h = setup({ env: { ZELLIJ: "0" }, platform: "linux" });
		void h.input.start();
		expect(h.out()).toContain("\x1b[?996n");
		// Zellij answers DA1 and CSI ?996n itself, reporting light mode, while it
		// forwards OSC 11 to a dark host terminal.
		h.feed(DA1, DA1, "\x1b[?997;2n", "\x1b]11;rgb:0000/0000/0000\x07");
		expect(h.input.capabilities.dark).toBe(false);
		expect(h.input.capabilities.background).toEqual({ r: 0, g: 0, b: 0 });
		// Outside Zellij the background's luminance still decides, and nothing asks for 996.
		const direct = setup();
		void direct.input.start();
		expect(direct.out()).not.toContain("\x1b[?996n");
		direct.feed(DA1, DA1, "\x1b[?997;2n", "\x1b]11;rgb:0000/0000/0000\x07");
		expect(direct.input.capabilities.dark).toBe(true);
	});

	describe("in a Herdr desktop terminal", () => {
		/** Started with in-band resize on and a first report matching the 100×30 pty. */
		async function herdr(env: Record<string, string> = {}) {
			const h = await started({ env: { HC_TERMINAL_ID: "t7", ...env } });
			h.feed("\x1b[?2048;2$y", "\x1b[48;30;100;600;1000t");
			return h;
		}

		it("returns to the pty size after a peek report read late", async () => {
			// Herdr reports the smaller size of a peek but sends no report when the
			// terminal returns to its pane; with the peek's SIGWINCH coalesced away,
			// stdout never shows the peek size.
			const h = await herdr();
			h.feed("\x1b[48;20;80;400;800t");
			expect([h.input.rows, h.input.columns]).toEqual([20, 80]);
			h.clock.advance(499);
			expect(h.resizes).toEqual([[80, 20]]);
			h.clock.advance(1);
			expect(h.resizes).toEqual([
				[80, 20],
				[100, 30],
			]);
			expect(h.input.capabilities.cell).toEqual({ w: 10, h: 20 });
		});

		it("returns to the pty height after a height-only peek report", async () => {
			const h = await herdr();
			h.feed("\x1b[48;15;100;300;1000t");
			expect(h.input.rows).toBe(15);
			h.clock.advance(500);
			expect([h.input.rows, h.input.columns]).toEqual([30, 100]);
		});

		it("keeps a report whose SIGWINCH follows it", async () => {
			const h = await herdr();
			h.feed("\x1b[48;30;140;600;1400t");
			h.stdout.columns = 140;
			h.events.emit("SIGWINCH");
			h.clock.advance(600);
			expect(h.input.columns).toBe(140);
			expect(h.resizes).toEqual([[140, 30]]);
		});

		it.each([
			["a tmux session", { TMUX: "/tmp/tmux-501/default,1,0" }],
			["tmux known only by TERM", { TERM: "tmux-256color" }],
		])("keeps in-band precedence for %s inside it", async (_name, env) => {
			// A grid-owning multiplexer in a Herdr pane owns its own pty; its reports stay authoritative.
			const h = await herdr(env);
			h.feed("\x1b[48;30;140;600;1400t");
			h.clock.advance(600);
			expect(h.input.columns).toBe(140);
		});

		it("returns to the pty size inside Orca, which does not own the grid", async () => {
			const h = await herdr({ ORCA_PANE_KEY: "pane", ORCA_WORKTREE_ID: "wt" });
			h.feed("\x1b[48;20;80;400;800t");
			h.clock.advance(600);
			expect([h.input.rows, h.input.columns]).toEqual([30, 100]);
		});

		it("leaves in-band reports authoritative outside Herdr", async () => {
			const h = await started();
			h.feed("\x1b[?2048;2$y", "\x1b[48;20;80;400;800t");
			h.clock.advance(600);
			expect([h.input.rows, h.input.columns]).toEqual([20, 80]);
		});
	});

	it("refreshes tmux's background cache from the outer terminal before asking it", async () => {
		const h = await started({ env: { TMUX: "/tmp/tmux,1,0" } });
		h.writes.length = 0;
		h.input.refreshAppearance();
		expect(h.out()).toBe("\x1bPtmux;\x1b\x1b]11;?\x07\x1b\\");
		h.clock.advance(100);
		expect(h.out()).toContain("\x1b]11;?\x07\x1b[c");
	});

	it("uses SIXEL inside tmux only when tmux draws it to the attached client", async () => {
		const sixelReplies = (h: ReturnType<typeof setup>) => {
			h.feed("\x1b[?62;4;22c", "\x1b[?62;4;22c");
			h.feed("\x1b[?2;0;800;600S", "\x1b[?62;4;22c");
		};
		const blind = setup({
			env: { TMUX: "/tmp/tmux,1,0" },
			tmux: args => (args[0] === "display-message" ? "client0" : ""),
		});
		const a = blind.input.start();
		sixelReplies(blind);
		await a;
		expect(blind.input.capabilities.images).toBeNull();
		const drawn = setup({
			env: { TMUX: "/tmp/tmux,1,0" },
			tmux: args => (args[0] === "display-message" ? "client0" : "  12: Sxl: (flag) true\n"),
		});
		const b = drawn.input.start();
		sixelReplies(drawn);
		await b;
		expect(drawn.input.capabilities.images).toBe("sixel");
	});

	it("shows progress with OSC 9;4, keeps it alive on Ghostty and clears it on stop", async () => {
		const h = await started({ env: { TERM_PROGRAM: "ghostty" } });
		h.writes.length = 0;
		h.input.setProgress(true);
		h.input.setProgress(true);
		expect(h.out()).toBe("\x1b]9;4;3\x07");
		h.clock.advance(1000);
		h.clock.advance(1000);
		expect(h.out()).toBe("\x1b]9;4;3\x07".repeat(3));
		h.writes.length = 0;
		await h.input.stop();
		expect(h.out().startsWith("\x1b]9;4;0;\x07")).toBe(true);
		h.clock.advance(5000);
		expect(h.out()).not.toContain("\x1b]9;4;3");

		const plain = await started({ env: { TERM_PROGRAM: "WezTerm" } });
		plain.writes.length = 0;
		plain.input.setProgress(true);
		plain.clock.advance(5000);
		plain.input.setProgress(false);
		expect(plain.out()).toBe("\x1b]9;4;3\x07\x1b]9;4;0;\x07");
	});

	it("writes a cursor shape once per change and hands the user's own back on stop", async () => {
		const h = await started();
		h.writes.length = 0;
		h.input.setCursorShape("default");
		h.input.setCursorShape("block");
		h.input.setCursorShape("block");
		h.input.setCursorShape("bar");
		expect(h.out()).toBe("\x1b[0 q\x1b[2 q\x1b[6 q");
		h.writes.length = 0;
		await h.input.stop();
		expect(h.out()).toContain("\x1b[0 q");

		// A default shape needs no restoring.
		const plain = await started();
		plain.input.setCursorShape("default");
		plain.writes.length = 0;
		await plain.input.stop();
		expect(plain.out()).not.toContain(" q");
	});

	it("turns on VT input on a native Windows console and puts the mode back on stop", async () => {
		const calls: string[] = [];
		const h = await started({
			platform: "win32",
			nativeWindowsConsole: true,
			consoleMode: {
				enable: () => (calls.push("enable"), 7),
				restore: mode => calls.push(`restore:${mode}`),
			},
		});
		expect(calls).toEqual(["enable"]);
		await h.input.stop();
		expect(calls).toEqual(["enable", "restore:7"]);
	});

	it("applies an in-band resize body whose terminator comes late, without typing the `t`", async () => {
		const h = await started();
		h.feed("\x1b[48;40;120;800;1200");
		h.clock.advance(100);
		h.feed("t");
		h.feed("\x1b[48;41;121;820;1210\x1b[48;42;122;840;1220t");
		expect(h.received).toEqual([]);
		expect(h.resizes).toEqual([
			[120, 40],
			[121, 41],
			[122, 42],
		]);
		// A `t` long after a complete report is a keystroke.
		h.clock.advance(1000);
		h.feed("t");
		expect(h.received).toHaveLength(1);
	});

	it("sends the TSP hello only where APC reaches the terminal", () => {
		const HELLO = "\x1b_tsp;hello\x1b\\";
		const sent = (env: Record<string, string>, tmux: ProcessInputOptions["tmux"] = () => null) => {
			const h = setup({ env, hello: HELLO, tmux });
			void h.input.start();
			return h.out().includes(HELLO);
		};
		expect(sent({})).toBe(true);
		expect(sent({ PI_TUI_NATIVE: "0" })).toBe(false);
		expect(sent({ STY: "1.pts" })).toBe(false);
		expect(sent({ ZELLIJ: "0", PI_TUI_NATIVE: "1" })).toBe(true);
		expect(sent({ DEVENV_RELOAD_FILE: "/tmp/r" })).toBe(false);
		// A Tern pane trusts session markers only, not a multiplexer TERM it inherited.
		expect(sent({ TERM_PROGRAM: "tern", TERM: "screen-256color" })).toBe(true);
		expect(sent({ TERM_PROGRAM: "tern", HERDR_ENV: "1" })).toBe(false);
		// tmux: only when the hosting terminal set `@tern-tsp`, whatever PI_TUI_NATIVE says.
		expect(sent({ TMUX: "/tmp/t,1,0", PI_TUI_NATIVE: "1" })).toBe(false);
		expect(sent({ TMUX: "/tmp/t,1,0" }, args => (args.includes("@tern-tsp") ? "1\n" : null))).toBe(true);
	});

	it("keeps tmux from turning TSP messages into the pane title while it runs", async () => {
		const calls: string[] = [];
		const h = setup({
			env: { TMUX: "/tmp/t,1,0", TMUX_PANE: "%3" },
			hello: "\x1b_tsp;hello\x1b\\",
			tmux: args => {
				calls.push(args.join(" "));
				return args.includes("@tern-tsp") ? "1" : "";
			},
		});
		const done = h.input.start();
		h.settle();
		await done;
		expect(calls).toContain("set-option -p -t %3 allow-set-title off");
		await h.input.stop();
		expect(calls.at(-1)).toBe("set-option -pu -t %3 allow-set-title");
	});

	it("registers the bundled icons over the Glyph Protocol and records the confirmation", async () => {
		const h = setup();
		const done = h.input.start();
		expect(h.out()).toContain("\x1b_25a1;s\x1b\\");
		h.feed("\x1b_25a1;s;fmt=glyf\x1b\\");
		expect(h.out()).toContain("\x1b_25a1;r;cp=");
		expect(h.out()).toContain("\x1b_25a1;q;cp=f0d57\x1b\\\x1b[c");
		h.settle();
		h.feed("\x1b_25a1;q;cp=f0d57;status=glossary\x1b\\", DA1);
		await done;
		expect(h.input.identity.glyphs).toBe(true);
		expect(h.received).toEqual([]);
		const muxed = setup({ env: { TMUX: "/tmp/t,1,0" } });
		void muxed.input.start();
		expect(muxed.out()).not.toContain("\x1b_25a1;");
		const off = setup({ env: { PI_NO_GLYPH_PROTOCOL: "1" } });
		void off.input.start();
		expect(off.out()).not.toContain("\x1b_25a1;");
	});
});
