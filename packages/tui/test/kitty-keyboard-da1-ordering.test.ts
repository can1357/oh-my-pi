import { afterEach, describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { isKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

// The keyboard negotiation itself — kitty reply vs DA1 ordering (#2042), the
// pushed flags, the modifyOtherKeys / win32-input-mode fallbacks — is the
// engine's (session and device tests). These cases pin what JS owns: the
// environment facts the engine decides from (SSH, multiplexer), the
// `kittyProtocolActive` state input decoding follows, and a fullscreen
// overlay's alternate screen carrying the enhancement end to end.

class ModalProbe implements Component {
	invalidate(): void {}
	render(): string[] {
		return ["modal"];
	}
}
const originalSshConnection = Bun.env.SSH_CONNECTION;
const originalSshTty = Bun.env.SSH_TTY;
const originalSshClient = Bun.env.SSH_CLIENT;
const originalTmux = Bun.env.TMUX;

function restoreEnv(name: "SSH_CONNECTION" | "SSH_TTY" | "SSH_CLIENT" | "TMUX", value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

describe("ProcessTerminal kitty keyboard progressive-enhancement ordering", () => {
	withoutTerminalMultiplexer();
	let harness: ProcessTerminalRenderHarness | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		restoreEnv("SSH_CONNECTION", originalSshConnection);
		restoreEnv("SSH_TTY", originalSshTty);
		restoreEnv("SSH_CLIENT", originalSshClient);
		restoreEnv("TMUX", originalTmux);
	});

	it("requests alternate keys when the kitty reply arrives before the DA1 sentinel", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		expect(harness.writes.join("")).toContain("\x1b[?u\x1b[c");
		harness.writes.length = 0;

		await harness.feed("\x1b[?0u", "\x1b[?1;2c");

		const out = harness.writes.join("");
		expect(harness.terminal.kittyProtocolActive).toBe(true);
		// Input decoding follows the negotiated protocol.
		expect(isKittyProtocolActive()).toBe(true);
		expect(out).toContain("\x1b[>5u");
		expect(out).not.toContain("\x1b[>4;2m");

		// The exit restore pops the enhancement; input decoding follows it off.
		harness.tui.stop();
		expect(harness.terminal.kittyProtocolActive).toBe(false);
		expect(isKittyProtocolActive()).toBe(false);
	});

	it("skips modifyOtherKeys fallback for SSH_CONNECTION-only unknown terminals", async () => {
		// The engine identifies the terminal from its env: only an SSH marker and a
		// generic TERM, so it resolves to the unknown `base` terminal.
		harness = createProcessTerminalRenderHarness(100, 30, {
			conpty: false,
			env: { SSH_CONNECTION: "192.0.2.10 54321 192.0.2.20 22", TERM: "xterm-256color" },
		});
		await harness.settle();
		harness.writes.length = 0;

		await harness.feed("\x1b[?1;2c");

		const out = harness.writes.join("");
		expect(harness.terminal.kittyProtocolActive).toBe(false);
		expect(out).not.toContain("\x1b[>4;2m");
	});

	it("enables modifyOtherKeys fallback under tmux so extended-keys panes keep modified keys (#5620)", async () => {
		// tmux answers DA1 but not `CSI ? u`. omp must still request the xterm
		// modifyOtherKeys fallback; tmux honors it under `extended-keys on`/`always`
		// (delivering Ctrl+H and Shift+Enter distinctly) and ignores it under
		// `extended-keys off`, so tmux — not omp — is the capability gate. A blanket
		// tmux exclusion (#5502) collapsed those keys to legacy bytes in every pane.
		Bun.env.TMUX = "/tmp/tmux-501/default,1234,0";
		delete Bun.env.SSH_CONNECTION;
		delete Bun.env.SSH_TTY;
		delete Bun.env.SSH_CLIENT;
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();

		await harness.feed("\x1b[?1;2c");

		const out = harness.writes.join("");
		expect(harness.terminal.kittyProtocolActive).toBe(false);
		expect(out).toContain("\x1b[>4;2m");
		expect(out).not.toContain("\x1b[>5u");
	});

	it("pops the kitty frame on overlay exit and reasserts the main-screen flags", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: false });
		await harness.settle();
		await harness.feed("\x1b[?0u", "\x1b[?1;2c");
		expect(harness.terminal.kittyProtocolActive).toBe(true);
		harness.writes.length = 0;

		const overlay = harness.tui.showOverlay(new ModalProbe(), {
			fullscreen: true,
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		await harness.settle();
		// Kitty keyboard flags are per-screen: the alternate screen gets its own push.
		expect(harness.writes.join("")).toContain("\x1b[?1049h\x1b[>5u");
		harness.writes.length = 0;

		overlay.hide();
		await harness.settle();

		// The matching pop precedes the alt-screen exit, and the main-screen flags
		// are replaced right after (Windows Terminal 1.25–1.27 drop them on
		// `?1049l`, microsoft/terminal#20763).
		expect(harness.writes.join("")).toContain("\x1b[<u\x1b[?1049l\x1b[=5;1u");
	});
});
