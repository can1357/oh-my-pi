import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { setTerminalGlyphProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { type FakeTtyTerminal, fakeTtyTerminal } from "./helpers/fake-tty-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";

const SUPPORT_QUERY = "\x1b_25a1;s\x1b\\";
const SUPPORT_REPLY = "\x1b_25a1;s;fmt=glyf\x1b\\";
const CONFIRM_REPLY = "\x1b_25a1;q;cp=f0d57;status=glossary\x1b\\";
const UNSUPPORTED_REPLY = "\x1b_25a1;s;fmt=\x1b\\";
/**
 * What the handshake writes after a `glyf`-capable support reply: every bundled
 * registration (the engine embeds the bundle; its codec is covered by the
 * pi-natives glyph tests), then the confirmation coverage query behind DA1.
 */
const REGISTRATION_WRITE =
	/(?:\x1b_25a1;r;cp=[0-9a-f]+;reply=0;upm=\d+;aw=\d+;lh=\d+;size=(?:stretch|contain);[A-Za-z0-9+/=]+\x1b\\){200,}\x1b_25a1;q;cp=f0d57\x1b\\\x1b\[c/u;

const originalProbeEnv = Bun.env.PI_TUI_GLYPH_PROTOCOL_PROBE;
const originalKillSwitch = Bun.env.PI_NO_GLYPH_PROTOCOL;

function restoreEnv(key: string, original: string | undefined): void {
	if (original === undefined) {
		delete Bun.env[key];
		return;
	}
	Bun.env[key] = original;
}

// The handshake's sequencing (DA1 FIFO, coverage confirmation, sentinel races)
// is the engine's and covered by its session tests; these cases pin what
// reaches JS: the capability flag, subscribers, the probe gate, and the TUI's
// repaint.
describe("glyph protocol probe", () => {
	withoutTerminalMultiplexer();
	let tty: FakeTtyTerminal | undefined;

	beforeEach(() => {
		setTerminalGlyphProtocol(false);
		Bun.env.PI_TUI_GLYPH_PROTOCOL_PROBE = "1";
		delete Bun.env.PI_NO_GLYPH_PROTOCOL;
	});

	afterEach(() => {
		tty?.dispose();
		tty = undefined;
		setTerminalGlyphProtocol(false);
		restoreEnv("PI_TUI_GLYPH_PROTOCOL_PROBE", originalProbeEnv);
		restoreEnv("PI_NO_GLYPH_PROTOCOL", originalKillSwitch);
	});

	function start(): { tty: FakeTtyTerminal; reports: boolean[] } {
		// Non-ConPTY: the bundle is one capture chunk; ConPTY hosts (win32, WSL) split it.
		const started = fakeTtyTerminal({ conpty: false });
		tty = started;
		const reports: boolean[] = [];
		started.terminal.onGlyphProtocolReport(supported => reports.push(supported));
		started.terminal.start();
		return { tty: started, reports };
	}

	it("registers the bundle on a torn support reply and publishes success only once the coverage query confirms it", () => {
		const { tty, reports } = start();
		expect(tty.output()).toContain(`${SUPPORT_QUERY}\x1b[c`);
		const before = tty.output().length;

		tty.feed(SUPPORT_REPLY.slice(0, 12));
		tty.feed(SUPPORT_REPLY.slice(12));
		expect(tty.output().slice(before)).toMatch(REGISTRATION_WRITE);
		// Not confirmed yet: the bundle is in flight until the `q` answer lands.
		expect(TERMINAL.glyphProtocol).toBe(false);
		expect(reports).toEqual([]);

		tty.feed(CONFIRM_REPLY);
		expect(TERMINAL.glyphProtocol).toBe(true);
		expect(reports).toEqual([true]);
		// Handshake replies never reach the host as input.
		expect(tty.received).toEqual([]);

		// A subscriber arriving after the handshake resolved gets the outcome.
		const late: boolean[] = [];
		tty.terminal.onGlyphProtocolReport(supported => late.push(supported));
		expect(late).toEqual([true]);

		// A resumed TUI may own a different terminal: stopping releases the support.
		tty.terminal.stop();
		expect(TERMINAL.glyphProtocol).toBe(false);
	});

	it("publishes a failed handshake to subscribers, late ones included, without writing the bundle", () => {
		const { tty, reports } = start();
		const before = tty.output().length;

		tty.feed(UNSUPPORTED_REPLY);

		expect(reports).toEqual([false]);
		expect(TERMINAL.glyphProtocol).toBe(false);
		expect(tty.output().slice(before)).not.toContain("\x1b_25a1;r;");
		const late: boolean[] = [];
		tty.terminal.onGlyphProtocolReport(supported => late.push(supported));
		expect(late).toEqual([false]);
	});

	it("skips the probe under a multiplexer and under the kill switch", () => {
		// The other probes still went out: only this one is gated.
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
		const tmux = start().tty;
		expect(tmux.output()).toContain("\x1b[c");
		expect(tmux.output()).not.toContain(SUPPORT_QUERY);
		tmux.dispose();

		delete Bun.env.TMUX;
		Bun.env.PI_NO_GLYPH_PROTOCOL = "1";
		const killed = start().tty;
		expect(killed.output()).toContain("\x1b[c");
		expect(killed.output()).not.toContain(SUPPORT_QUERY);
	});
});

class Label implements Component {
	constructor(readonly text: string) {}
	invalidate(): void {}
	render(): string[] {
		return [this.text];
	}
}

describe("TUI glyph protocol repaint", () => {
	withoutTerminalMultiplexer();
	const ROW = "glyph-repaint-row";
	let harness: ProcessTerminalRenderHarness | undefined;

	beforeEach(() => {
		setTerminalGlyphProtocol(false);
		Bun.env.PI_TUI_GLYPH_PROTOCOL_PROBE = "1";
		delete Bun.env.PI_NO_GLYPH_PROTOCOL;
	});

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		setTerminalGlyphProtocol(false);
		restoreEnv("PI_TUI_GLYPH_PROTOCOL_PROBE", originalProbeEnv);
		restoreEnv("PI_NO_GLYPH_PROTOCOL", originalKillSwitch);
	});

	async function startTui(): Promise<ProcessTerminalRenderHarness> {
		harness = createProcessTerminalRenderHarness(100, 30);
		harness.tui.addChild(new Label(ROW));
		await harness.settle();
		expect(harness.writes.join("")).toContain(ROW);
		return harness;
	}

	it("repaints rows painted before the registration landed once the handshake confirms", async () => {
		const harness = await startTui();
		await harness.feed(SUPPORT_REPLY);
		harness.writes.length = 0;

		await harness.feed(CONFIRM_REPLY);

		expect(TERMINAL.glyphProtocol).toBe(true);
		// Unchanged content: only the forced full repaint re-emits the row.
		expect(harness.writes.join("")).toContain(ROW);
	});

	it("leaves the screen alone when the terminal has no glyph support", async () => {
		const harness = await startTui();
		harness.writes.length = 0;

		await harness.feed(UNSUPPORTED_REPLY);

		expect(TERMINAL.glyphProtocol).toBe(false);
		expect(harness.writes.join("")).not.toContain(ROW);
	});
});
