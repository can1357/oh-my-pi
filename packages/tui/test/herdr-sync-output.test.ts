import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import type { PrivateModeReportHandler } from "@oh-my-pi/pi-tui/terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Contract: after TUI.start(), a confirmed DECRPM 2026 “unrecognized”
 * report (status 0) must not restore the Herdr dirty-row tear (top frozen,
 * bottom-only refresh). Permanently-reset (status 4) and three-argument
 * unsupported reports still disable synchronized output.
 *
 * Static `shouldEnableSynchronizedOutputByDefault()` tests cannot catch a
 * regression in this start() handler.
 */
withoutTerminalMultiplexer();

const SYNC_OVERRIDE_KEYS = [
	"PI_NO_SYNC_OUTPUT",
	"PI_FORCE_SYNC_OUTPUT",
	"PI_TUI_SYNC_OUTPUT",
	"TERM_FEATURES",
	"WT_SESSION",
] as const;

class ReportingTerminal extends VirtualTerminal {
	#callbacks: PrivateModeReportHandler[] = [];

	onPrivateModeReport(callback: PrivateModeReportHandler): void {
		this.#callbacks.push(callback);
	}

	report(...args: Parameters<PrivateModeReportHandler>): void {
		for (const callback of this.#callbacks) callback(...args);
	}
}

describe("TUI Herdr synchronized-output DECRQM carve-out", () => {
	const previous = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const key of SYNC_OVERRIDE_KEYS) {
			previous.set(key, Bun.env[key]);
			delete Bun.env[key];
		}
	});

	afterEach(() => {
		for (const key of SYNC_OVERRIDE_KEYS) {
			const value = previous.get(key);
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		previous.clear();
	});

	it("keeps synchronized output on in Herdr after a DECRPM unrecognized ?2026 report", () => {
		// If this regresses, Herdr panes tear: the live viewport's top stays frozen
		// while only the bottom refreshes after the startup DECRQM probe.
		Bun.env.HERDR_ENV = "1";
		const terminal = new ReportingTerminal(80, 24);
		const tui = new TUI(terminal);
		try {
			expect(tui.synchronizedOutput).toBe(true);
			tui.start();
			terminal.report(2026, false, true, 0);
			expect(tui.synchronizedOutput).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("turns synchronized output off after a confirmed unsupported ?2026 report outside Herdr", () => {
		Bun.env.TERM_FEATURES = "Sy";
		const terminal = new ReportingTerminal(80, 24);
		const tui = new TUI(terminal);
		try {
			expect(tui.synchronizedOutput).toBe(true);
			tui.start();
			terminal.report(2026, false, true, 0);
			expect(tui.synchronizedOutput).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("turns synchronized output off in Herdr when a three-argument unsupported ?2026 report omits DECRPM status", () => {
		// Custom Terminals may still call (2026, false, true) without status.
		// That is a definitive unsupported, not Herdr's unrecognized (status 0).
		Bun.env.HERDR_ENV = "1";
		const terminal = new ReportingTerminal(80, 24);
		const tui = new TUI(terminal);
		try {
			expect(tui.synchronizedOutput).toBe(true);
			tui.start();
			terminal.report(2026, false, true);
			expect(tui.synchronizedOutput).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("turns synchronized output off in Herdr when DECRPM reports 2026 permanently reset", () => {
		// Status 4 means the terminal cannot enable the mode. Wrapping paints in
		// CSI ?2026 would emit a mode the host has permanently disabled.
		Bun.env.HERDR_ENV = "1";
		const terminal = new ReportingTerminal(80, 24);
		const tui = new TUI(terminal);
		try {
			expect(tui.synchronizedOutput).toBe(true);
			tui.start();
			terminal.report(2026, false, true, 4);
			expect(tui.synchronizedOutput).toBe(false);
		} finally {
			tui.stop();
		}
	});
});
