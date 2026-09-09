import { afterEach, describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";

// Progressive-enhancement probe ordering contract. omp sends `CSI ? u \\ CSI c`
// at startup: the kitty reply (`CSI ? <flags> u`) authoritatively says the
// terminal speaks the kitty keyboard protocol; the DA1 reply (`CSI ? ... c`)
// is only a sentinel that guarantees a reply even from terminals that ignore
// `CSI ? u`. Some terminals (Superset / xterm-on-Electron) answer DA1 first;
// the kitty reply must still be honored regardless of ordering.

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
const originalTerminalId = TERMINAL.id;

function restoreEnv(name: "SSH_CONNECTION" | "SSH_TTY" | "SSH_CLIENT" | "TMUX", value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

describe("ProcessTerminal kitty keyboard progressive-enhancement ordering", () => {
	let harness: ProcessTerminalRenderHarness | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		restoreEnv("SSH_CONNECTION", originalSshConnection);
		restoreEnv("SSH_TTY", originalSshTty);
		restoreEnv("SSH_CLIENT", originalSshClient);
		restoreEnv("TMUX", originalTmux);
		Object.defineProperty(TERMINAL, "id", { value: originalTerminalId, configurable: true });
	});

	it("requests alternate keys when the kitty reply arrives before the DA1 sentinel", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		expect(harness.writes.join("")).toContain("\x1b[?u\x1b[c");
		harness.writes.length = 0;

		await harness.feed("\x1b[?0u", "\x1b[?1;2c");

		const out = harness.writes.join("");
		expect(harness.terminal.kittyProtocolActive).toBe(true);
		expect(out).toContain("\x1b[>5u");
		expect(out).not.toContain("\x1b[>4;2m");
	});

	it("keeps alternate-key reporting without enabling event types after a previous session", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		harness.writes.length = 0;

		await harness.feed("\x1b[?5u");

		const out = harness.writes.join("");
		expect(out).toContain("\x1b[>5u");
		expect(out).not.toContain("\x1b[>7u");
	});

	it("preserves event-type reporting enabled by a parent app", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		harness.writes.length = 0;

		await harness.feed("\x1b[?3u");

		expect(harness.writes.join("")).toContain("\x1b[>7u");
	});

	it("enables kitty when the DA1 sentinel arrives before the kitty reply (#2042)", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		harness.writes.length = 0;

		// Superset/Electron-xterm answers DA1 before `CSI ? u`. The kitty reply
		// must override the premature modifyOtherKeys fallback.
		await harness.feed("\x1b[?1;2c", "\x1b[?0u");

		const out = harness.writes.join("");
		expect(harness.terminal.kittyProtocolActive).toBe(true);
		expect(out).toContain("\x1b[>5u");
		const enableIdx = out.indexOf("\x1b[>4;2m");
		const disableIdx = out.indexOf("\x1b[>4;0m");
		const kittyIdx = out.indexOf("\x1b[>5u");
		expect(enableIdx).toBeGreaterThanOrEqual(0);
		expect(disableIdx).toBeGreaterThan(enableIdx);
		expect(kittyIdx).toBeGreaterThan(enableIdx);
	});

	it("keeps the modifyOtherKeys fallback when only DA1 ever replies", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		harness.writes.length = 0;

		// Terminals that ignore `CSI ? u` answer DA1 only — modifyOtherKeys is
		// the right answer there.
		await harness.feed("\x1b[?1;2c");

		const out = harness.writes.join("");
		expect(harness.terminal.kittyProtocolActive).toBe(false);
		expect(out).toContain("\x1b[>4;2m");
		expect(out).not.toContain("\x1b[>5u");
	});

	it("skips modifyOtherKeys fallback for SSH_CONNECTION-only unknown terminals", async () => {
		Bun.env.SSH_CONNECTION = "192.0.2.10 54321 192.0.2.20 22";
		delete Bun.env.SSH_TTY;
		delete Bun.env.SSH_CLIENT;
		Object.defineProperty(TERMINAL, "id", { value: "base", configurable: true });
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		harness.writes.length = 0;

		await harness.feed("\x1b[?1;2c");

		const out = harness.writes.join("");
		expect(harness.terminal.kittyProtocolActive).toBe(false);
		expect(out).not.toContain("\x1b[>4;2m");
		expect(harness.terminal.keyboardEnhancementEnterSequence).toBeNull();
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
		harness.writes.length = 0;

		await harness.feed("\x1b[?1;2c");

		const out = harness.writes.join("");
		expect(harness.terminal.kittyProtocolActive).toBe(false);
		expect(out).toContain("\x1b[>4;2m");
		expect(out).not.toContain("\x1b[>5u");
		expect(harness.terminal.keyboardEnhancementEnterSequence).toBe("\x1b[>4;2m");
	});

	it("reasserts modifyOtherKeys fallback when fullscreen overlays enter the alternate screen", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		harness.writes.length = 0;

		await harness.feed("\x1b[?1;2c");
		expect(harness.writes.join("")).toContain("\x1b[>4;2m");
		harness.writes.length = 0;

		const overlay = harness.tui.showOverlay(new ModalProbe(), {
			fullscreen: true,
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		await harness.settle();

		const enterOut = harness.writes.join("");
		expect(enterOut).toContain("\x1b[?1049h\x1b[>4;2m");
		harness.writes.length = 0;

		overlay.hide();
		await harness.settle();

		const exitOut = harness.writes.join("");
		// xterm modifyOtherKeys is a single global flag (no per-screen stack),
		// so the overlay exit must NOT emit `>4;0m` — that would clear it on the
		// normal screen and break the composer between overlays. Only the kitty
		// pop is per-screen and safe to emit on exit.
		expect(exitOut).toContain("\x1b[?1049l");
		expect(exitOut).not.toContain("\x1b[>4;0m");
	});

	it("pops the kitty keyboard frame on fullscreen overlay exit", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
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
		expect(harness.writes.join("")).toContain("\x1b[?1049h\x1b[>5u");
		harness.writes.length = 0;

		overlay.hide();
		await harness.settle();

		const exitOut = harness.writes.join("");
		// Kitty keyboard flags are per-screen, so the matching pop must precede
		// the alt-screen exit to balance the push from overlay entry.
		expect(exitOut).toContain("\x1b[<u\x1b[?1049l");
	});
});
