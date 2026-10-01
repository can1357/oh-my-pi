import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	encodeBundledGlyphRegistrations,
	encodeGlyphCoverageQuery,
	encodeGlyphRegistration,
	GLYPH_BUNDLE,
	GLYPH_CONFIRMATION_CODEPOINT,
	isPrivateUseCodepoint,
	parseGlyphProtocolReply,
} from "@oh-my-pi/pi-tui/glyph-protocol";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalGlyphProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

const SUPPORT_QUERY = "\x1b_25a1;s\x1b\\";
const DA1_REPLY = "\x1b[?1;2c";
const SUPPORT_REPLY = "\x1b_25a1;s;fmt=glyf\x1b\\";
const CONFIRM_HEX = GLYPH_CONFIRMATION_CODEPOINT.toString(16);
const CONFIRM_REPLY = `\x1b_25a1;q;cp=${CONFIRM_HEX};status=glossary\x1b\\`;
/** Everything the handshake writes after a `glyf`-capable support reply. */
const REGISTRATION_WRITE = `${encodeBundledGlyphRegistrations()}${encodeGlyphCoverageQuery(GLYPH_CONFIRMATION_CODEPOINT)}\x1b[c`;

describe("glyph protocol codec", () => {
	it("encodes a registration with the bundle metrics and fire-and-forget reply gate", () => {
		const seq = encodeGlyphRegistration(
			0xe0b0,
			{ glyf: "AAA=", stretch: true },
			{ upm: 1000, aw: 600, lh: 1320, glyphs: {} },
		);
		expect(seq).toBe("\x1b_25a1;r;cp=e0b0;reply=0;upm=1000;aw=600;lh=1320;size=stretch;AAA=\x1b\\");
		const icon = encodeGlyphRegistration(0xf00c, { glyf: "AAA=" }, { upm: 1000, aw: 600, lh: 1320, glyphs: {} });
		expect(icon).toContain(";size=contain;");
	});

	it("refuses to register outside the private use areas", () => {
		expect(() => encodeGlyphRegistration(0x61, { glyf: "AAA=" })).toThrow(RangeError);
		expect(isPrivateUseCodepoint(0xe000)).toBe(true);
		expect(isPrivateUseCodepoint(0xf8ff)).toBe(true);
		expect(isPrivateUseCodepoint(0xf900)).toBe(false);
		expect(isPrivateUseCodepoint(0xf0000)).toBe(true);
		expect(isPrivateUseCodepoint(0xffffe)).toBe(false);
		expect(isPrivateUseCodepoint(0x10fffd)).toBe(true);
	});

	it("parses every reply verb and treats empty lists as none", () => {
		expect(parseGlyphProtocolReply("\x1b_25a1;s;fmt=glyf,colrv0,colrv1\x1b\\")).toEqual({
			verb: "s",
			formats: ["glyf", "colrv0", "colrv1"],
		});
		expect(parseGlyphProtocolReply("\x1b_25a1;s;fmt=\x1b\\")).toEqual({ verb: "s", formats: [] });
		expect(parseGlyphProtocolReply("\x1b_25a1;q;cp=e0a0;status=system,glossary\x1b\\")).toEqual({
			verb: "q",
			cp: 0xe0a0,
			coverage: ["system", "glossary"],
		});
		expect(parseGlyphProtocolReply("\x1b_25a1;q;cp=e0a0;status=\x1b\\")).toEqual({
			verb: "q",
			cp: 0xe0a0,
			coverage: [],
		});
		expect(parseGlyphProtocolReply("\x1b_25a1;r;cp=100000;status=3;reason=payload_too_large\x1b\\")).toEqual({
			verb: "r",
			cp: 0x100000,
			status: 3,
			reason: "payload_too_large",
		});
		expect(parseGlyphProtocolReply("\x1b_25a1;c;status=0\x1b\\")).toEqual({ verb: "c", status: 0 });
	});

	it("rejects foreign APCs, unknown verbs and malformed numerics", () => {
		expect(parseGlyphProtocolReply("\x1b_Ga=t,i=1;AAAA\x1b\\")).toBeNull();
		expect(parseGlyphProtocolReply("\x1b_25a1;x;cp=e000\x1b\\")).toBeNull();
		expect(parseGlyphProtocolReply("\x1b_25a1;r;status=0\x1b\\")).toBeNull();
		expect(parseGlyphProtocolReply("\x1b_25a1;s;fmt=glyf")).toBeNull();
	});
});

describe("glyph bundle", () => {
	it("ships only PUA codepoints as simple-glyph records under the wire budget", () => {
		let count = 0;
		for (const hex in GLYPH_BUNDLE.glyphs) {
			count++;
			expect(isPrivateUseCodepoint(Number.parseInt(hex, 16))).toBe(true);
			const record = Buffer.from(GLYPH_BUNDLE.glyphs[hex]!.glyf, "base64");
			// Simple-glyph header: numberOfContours ≥ 0 (composites are negative).
			expect(record.readInt16BE(0)).toBeGreaterThan(0);
			expect(record.length).toBeLessThanOrEqual(64 * 1024);
		}
		expect(count).toBeGreaterThan(200);
		expect(encodeBundledGlyphRegistrations().split("\x1b_25a1;r;").length - 1).toBe(count);
		expect(GLYPH_BUNDLE.glyphs[CONFIRM_HEX]).toBeDefined();
	});
});

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const originalProbeEnv = Bun.env.PI_TUI_GLYPH_PROTOCOL_PROBE;
const originalKillSwitch = Bun.env.PI_NO_GLYPH_PROTOCOL;
const originalTmux = Bun.env.TMUX;

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

function restoreEnv(key: string, original: string | undefined): void {
	if (original === undefined) {
		delete Bun.env[key];
		return;
	}
	Bun.env[key] = original;
}

function setupProcessTerminal() {
	const writes: string[] = [];
	const received: string[] = [];
	const reports: boolean[] = [];
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
	vi.spyOn(process, "kill").mockReturnValue(true);
	vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		writes.push(typeof chunk === "string" ? chunk : chunk.toString());
		return true;
	});

	const terminal = new ProcessTerminal();
	terminal.onGlyphProtocolReport(supported => reports.push(supported));
	terminal.start(
		data => received.push(data),
		() => {},
	);
	return { terminal, writes, received, reports };
}

describe("glyph protocol probe", () => {
	let previousHeadless = false;

	beforeEach(() => {
		setTerminalGlyphProtocol(false);
		previousHeadless = setTerminalHeadless(false);
		Bun.env.PI_TUI_GLYPH_PROTOCOL_PROBE = "1";
		delete Bun.env.PI_NO_GLYPH_PROTOCOL;
		delete Bun.env.TMUX;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		setTerminalGlyphProtocol(false);
		restoreEnv("PI_TUI_GLYPH_PROTOCOL_PROBE", originalProbeEnv);
		restoreEnv("PI_NO_GLYPH_PROTOCOL", originalKillSwitch);
		restoreEnv("TMUX", originalTmux);
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
	});

	it("registers the bundle on a support reply and reports success only after the coverage query confirms it", () => {
		const { terminal, writes, received, reports } = setupProcessTerminal();
		try {
			expect(writes).toContain(`${SUPPORT_QUERY}\x1b[c`);
			const before = writes.length;

			process.stdin.emit("data", SUPPORT_REPLY);
			expect(writes.slice(before)).toEqual([REGISTRATION_WRITE]);
			// Not confirmed yet: the bundle is in flight until the `q` answer lands.
			expect(TERMINAL.glyphProtocol).toBe(false);
			expect(reports).toEqual([]);

			// The terminal answers the support-phase sentinel next; that DA1 must
			// not abort the confirmation phase.
			process.stdin.emit("data", DA1_REPLY);
			expect(reports).toEqual([]);

			process.stdin.emit("data", CONFIRM_REPLY);
			expect(TERMINAL.glyphProtocol).toBe(true);
			expect(reports).toEqual([true]);
			expect(received).toEqual([]);

			// Confirmation-phase sentinel and a stray acknowledgement: swallowed.
			process.stdin.emit("data", DA1_REPLY);
			process.stdin.emit("data", "\x1b_25a1;r;cp=e0b0;status=0\x1b\\");
			expect(received).toEqual([]);
			expect(reports).toEqual([true]);

			// A subscriber arriving after the handshake resolved gets the outcome.
			const late: boolean[] = [];
			terminal.onGlyphProtocolReport(supported => late.push(supported));
			expect(late).toEqual([true]);
		} finally {
			terminal.stop();
		}
	});

	it("reports failure when the coverage query says the glossary does not serve the codepoint", () => {
		const { terminal, reports } = setupProcessTerminal();
		try {
			process.stdin.emit("data", SUPPORT_REPLY);
			process.stdin.emit("data", `\x1b_25a1;q;cp=${CONFIRM_HEX};status=system\x1b\\`);
			expect(reports).toEqual([false]);
			expect(TERMINAL.glyphProtocol).toBe(false);
		} finally {
			terminal.stop();
		}
	});

	it("reports failure when the confirmation sentinel arrives before the coverage reply", () => {
		const { terminal, reports } = setupProcessTerminal();
		try {
			process.stdin.emit("data", SUPPORT_REPLY);
			// Drain the FIFO (earlier probes, then the ignored support-phase
			// sentinel) until the confirmation-phase sentinel lands with no `q` answer.
			for (let i = 0; i < 10 && reports.length === 0; i++) process.stdin.emit("data", DA1_REPLY);
			expect(reports).toEqual([false]);
			expect(TERMINAL.glyphProtocol).toBe(false);
		} finally {
			terminal.stop();
		}
	});

	it("reassembles a support reply torn across stdin reads", () => {
		const { terminal, writes, received } = setupProcessTerminal();
		try {
			const before = writes.length;
			process.stdin.emit("data", "\x1b_25a1;s;fmt=gl");
			process.stdin.emit("data", "yf\x1b\\");
			expect(writes.slice(before)).toEqual([REGISTRATION_WRITE]);
			expect(received).toEqual([]);
		} finally {
			terminal.stop();
		}
	});

	it("marks the protocol unsupported when the DA1 sentinel wins, without writing the bundle", () => {
		const { terminal, writes, reports } = setupProcessTerminal();
		try {
			const before = writes.length;
			// One sentinel per outstanding probe in the FIFO (OSC 11, DECRQM, …);
			// keep answering until ours is consumed.
			for (let i = 0; i < 8 && reports.length === 0; i++) process.stdin.emit("data", DA1_REPLY);

			expect(reports).toEqual([false]);
			expect(TERMINAL.glyphProtocol).toBe(false);
			expect(writes.slice(before).some(w => w.includes("\x1b_25a1;r;"))).toBe(false);

			// A late reply after the sentinel resolved the probe is ignored, and a
			// late subscriber sees the stored negative outcome.
			process.stdin.emit("data", SUPPORT_REPLY);
			expect(TERMINAL.glyphProtocol).toBe(false);
			expect(reports).toEqual([false]);
			expect(writes.slice(before).some(w => w.includes("\x1b_25a1;r;"))).toBe(false);
			const late: boolean[] = [];
			terminal.onGlyphProtocolReport(supported => late.push(supported));
			expect(late).toEqual([false]);
		} finally {
			terminal.stop();
		}
	});

	it("treats a reply without glyf support as unsupported", () => {
		const { terminal, writes, reports } = setupProcessTerminal();
		try {
			const before = writes.length;
			process.stdin.emit("data", "\x1b_25a1;s;fmt=\x1b\\");
			expect(reports).toEqual([false]);
			expect(writes.length).toBe(before);
		} finally {
			terminal.stop();
		}
	});

	it("skips the probe under a multiplexer and under the kill switch", () => {
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
		const tmux = setupProcessTerminal();
		try {
			expect(tmux.writes.some(w => w.includes(SUPPORT_QUERY))).toBe(false);
		} finally {
			tmux.terminal.stop();
			vi.restoreAllMocks();
		}

		delete Bun.env.TMUX;
		Bun.env.PI_NO_GLYPH_PROTOCOL = "1";
		const killed = setupProcessTerminal();
		try {
			expect(killed.writes.some(w => w.includes(SUPPORT_QUERY))).toBe(false);
		} finally {
			killed.terminal.stop();
		}
	});
});
