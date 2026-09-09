import { describe, expect, it } from "bun:test";
import {
	collectTerminalState,
	formatTerminalState,
	type TerminalStateInfo,
} from "@oh-my-pi/pi-coding-agent/debug/terminal-info";
import { TERMINAL } from "@oh-my-pi/pi-tui";

const sample: TerminalStateInfo = {
	detectedId: "kitty",
	columns: 120,
	rows: 40,
	cellWidthPx: 9,
	cellHeightPx: 18,
	trueColor: true,
	imageProtocol: "Kitty graphics",
	notifyProtocol: "OSC 99 (kitty desktop notifications)",
	osc99Confirmed: true,
	hyperlinks: false,
	deccara: true,
	screenToScrollback: true,
	synchronizedOutput: false,
	multiplexer: null,
	env: { TERM: "xterm-kitty", TERM_PROGRAM: undefined, TERM_PROGRAM_VERSION: undefined, COLORTERM: "truecolor" },
};

describe("formatTerminalState", () => {
	it("surfaces the negotiated subprotocols and their on/off state", () => {
		const out = formatTerminalState(sample);
		expect(out).toContain("Detected:     kitty");
		expect(out).toContain("Graphics:     Kitty graphics");
		expect(out).toContain("Notify:       OSC 99 (kitty desktop notifications) · confirmed via DA");
		expect(out).toContain("Hyperlinks:   no (OSC 8)");
		expect(out).toContain("True color:   yes (24-bit SGR)");
		expect(out).toContain("DECCARA:      yes (rectangular-SGR background fills)");
		expect(out).toContain("Sync output:  no (DEC 2026)");
	});

	it("reports geometry, cell size, and the scrollback strategy", () => {
		const out = formatTerminalState(sample);
		expect(out).toContain("120x40 cells · cell 9x18px");
		// supportsScreenToScrollback -> the non-destructive CSI 22 J clear.
		expect(out).toContain("Screen->history clear: CSI 22 J");
	});

	it("renders the redraw fallback when screen-to-scrollback is unsupported", () => {
		const out = formatTerminalState({ ...sample, screenToScrollback: false });
		expect(out).toContain("Screen->history clear: CSI 2 J (redraw)");
	});

	it("drops the OSC-99-confirmed marker when the terminal never answered the probe", () => {
		const out = formatTerminalState({ ...sample, osc99Confirmed: false });
		expect(out).toContain("Notify:       OSC 99 (kitty desktop notifications)");
		expect(out).not.toContain("confirmed via DA");
	});

	it("shows 'none' for no multiplexer and '(unset)' for absent detection vars", () => {
		const out = formatTerminalState(sample);
		expect(out).toContain("Multiplexer:  none");
		expect(out).toContain("TERM:                 xterm-kitty");
		expect(out).toContain("COLORTERM:            truecolor");
		expect(out).toContain("TERM_PROGRAM:         (unset)");
	});

	it("names the multiplexer when one wraps the session", () => {
		expect(formatTerminalState({ ...sample, multiplexer: "tmux" })).toContain("Multiplexer:  tmux");
	});
});

describe("collectTerminalState", () => {
	it("reports herdr from pane identity vars, not client-only socket paths", () => {
		const keys = [
			"HERDR_ENV",
			"HERDR_PANE_ID",
			"HERDR_TAB_ID",
			"HERDR_WORKSPACE_ID",
			"HERDR_SOCKET_PATH",
			"TMUX",
			"STY",
			"ZELLIJ",
			"CMUX_WORKSPACE_ID",
			"CMUX_SURFACE_ID",
			"CMUX_REMOTE_TRANSPORT",
		] as const;
		const previous = new Map<string, string | undefined>();
		for (const key of keys) {
			previous.set(key, Bun.env[key]);
			delete Bun.env[key];
		}
		const runtime = { columns: 80, rows: 24, synchronizedOutput: true };
		try {
			expect(collectTerminalState(runtime).multiplexer).toBeNull();
			Bun.env.HERDR_ENV = "1";
			expect(collectTerminalState(runtime).multiplexer).toBe("herdr");
			delete Bun.env.HERDR_ENV;
			Bun.env.HERDR_PANE_ID = "p1";
			expect(collectTerminalState(runtime).multiplexer).toBe("herdr");
			delete Bun.env.HERDR_PANE_ID;
			Bun.env.HERDR_SOCKET_PATH = "/tmp/x";
			expect(collectTerminalState(runtime).multiplexer).toBeNull();
		} finally {
			for (const key of keys) {
				const value = previous.get(key);
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
		}
	});

	it("passes live geometry through and maps protocols to human-readable names (never raw escapes)", () => {
		const info = collectTerminalState({ columns: 88, rows: 25, synchronizedOutput: true });
		expect(info.columns).toBe(88);
		expect(info.rows).toBe(25);
		expect(info.synchronizedOutput).toBe(true);
		// The graphics/notify subprotocols are surfaced as readable labels, not the
		// enum's underlying escape sequences (\x1b_G, \x1b]99;;, …).
		expect(info.imageProtocol).not.toContain("\x1b");
		expect(info.notifyProtocol).not.toContain("\x1b");
		expect(info.imageProtocol.length).toBeGreaterThan(0);
		expect(info.notifyProtocol.length).toBeGreaterThan(0);
		// Capability booleans mirror the resolved TERMINAL singleton.
		expect(info.deccara).toBe(TERMINAL.deccara);
		expect(info.hyperlinks).toBe(TERMINAL.hyperlinks);
		expect(info.trueColor).toBe(TERMINAL.trueColor);
	});
});
