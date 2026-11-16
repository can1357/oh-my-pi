import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { getCellDimensions, setCellDimensions } from "@oh-my-pi/pi-tui/inline-image";
import { withFakeTmux } from "./helpers/fake-tmux";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";

// XTSMGRAPHICS item 2 reply captured from foot 1.27: status 0 (success) plus the
// terminal's maximum SIXEL geometry in pixels.
const SIXEL_SUPPORTED_REPLY = "\x1b[?2;0;1692;432S";
/** XTSMGRAPHICS: read the maximum SIXEL geometry. */
const GRAPHICS_QUERY = "\x1b[?2;1;0S";
/** XTWINOPS 16: report the cell size in pixels. */
const CELL_SIZE_QUERY = "\x1b[16t";

const originalProtocol = TERMINAL.imageProtocol;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete Bun.env[name];
	else Bun.env[name] = value;
}

/** A row with recognizable text that counts its invalidations. */
class Row implements Component {
	invalidations = 0;
	constructor(readonly text: string) {}
	invalidate(): void {
		this.invalidations++;
	}
	render(): string[] {
		return [this.text];
	}
}

// Reply parsing (status, zero geometry), the 250 ms answer window, and the
// cell-size query that follows adoption are the engine's (session and input
// tests). These cases pin the JS side: which environments send the probe, the
// TUI adopting SIXEL with a repaint, and the cell size reaching the image
// geometry.
/** Variables that name the hosting terminal (and with it a static image protocol). */
const TERMINAL_IDENTITY_KEYS = [
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"VSCODE_PID",
	"ALACRITTY_WINDOW_ID",
	"LC_TERMINAL",
	"PASEO_TERMINAL_ID",
] as const;

describe("TUI SIXEL adoption from the XTSMGRAPHICS probe", () => {
	withoutTerminalMultiplexer();
	// The engine resolves the static image protocol from the environment, so
	// the runner's own terminal identity must not pick one.
	const envKeys = [
		"PI_FORCE_IMAGE_PROTOCOL",
		"PI_TUI_NATIVE",
		"PI_NO_GLYPH_PROTOCOL",
		"WT_SESSION",
		"WSL_DISTRO_NAME",
		"WSL_INTEROP",
		...TERMINAL_IDENTITY_KEYS,
	] as const;
	const previousEnv = new Map<string, string | undefined>();
	const ROW = "sixel-probe-row";
	let originalCellDimensions = getCellDimensions();
	let harness: ProcessTerminalRenderHarness | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		for (const key of envKeys) {
			previousEnv.set(key, Bun.env[key]);
			delete Bun.env[key];
		}
		Bun.env.PI_TUI_NATIVE = "0";
		Bun.env.PI_NO_GLYPH_PROTOCOL = "1";
		setTerminalImageProtocol(null);
		originalCellDimensions = getCellDimensions();
	});

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		vi.useRealTimers();
		setTerminalImageProtocol(originalProtocol);
		setCellDimensions(originalCellDimensions);
		for (const [key, value] of previousEnv) restoreEnv(key, value);
		previousEnv.clear();
	});

	async function startTui(): Promise<{ harness: ProcessTerminalRenderHarness; row: Row }> {
		harness = createProcessTerminalRenderHarness(80, 24, { conpty: false });
		const row = new Row(ROW);
		harness.tui.addChild(row);
		await harness.settle();
		return { harness, row };
	}

	// The probe used to be gated on the host: on `isConPTYHosted() && WT_SESSION`,
	// which left foot (TERM=foot, COLORTERM=truecolor, nothing else) on the text
	// card, and then on `process.platform === "win32"`, which missed WSL (#6009).
	it.each([
		["a terminal that exports no identifying variable (foot)", {}],
		["WSL + Windows Terminal", { WT_SESSION: "test-wt-session", WSL_DISTRO_NAME: "Ubuntu" }],
	] as const)("adopts SIXEL from a positive reply on %s and repaints", async (_host, env) => {
		Object.assign(Bun.env, env);
		const { harness } = await startTui();
		expect(harness.writes.join("")).toContain(GRAPHICS_QUERY);
		expect(TERMINAL.imageProtocol).toBeNull();
		harness.writes.length = 0;

		await harness.feed(SIXEL_SUPPORTED_REPLY.slice(0, 11), SIXEL_SUPPORTED_REPLY.slice(11));

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		const out = harness.writes.join("");
		// The engine learned the protocol from the forced repaint: image rows are
		// sized by the cell, so it asks for it.
		expect(out).toContain(CELL_SIZE_QUERY);
		expect(out).toContain(ROW);
	});

	it("leaves an unknown tmux client's protocol to the probe", async () => {
		Object.assign(Bun.env, { TMUX: "/tmp/tmux/default,1,0", TERM: "tmux-256color", TERM_PROGRAM: "tmux" });
		const { harness } = await startTui();
		expect(harness.writes.join("")).toContain(GRAPHICS_QUERY);

		await harness.feed(SIXEL_SUPPORTED_REPLY);

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
	});

	it("applies the reported cell size to image geometry and invalidates the rows", async () => {
		const { harness, row } = await startTui();
		await harness.feed(SIXEL_SUPPORTED_REPLY);
		expect(harness.writes.join("")).toContain(CELL_SIZE_QUERY);
		const invalidations = row.invalidations;

		await harness.feed("\x1b[6;23;11t");

		expect(getCellDimensions()).toEqual({ widthPx: 11, heightPx: 23 });
		expect(row.invalidations).toBeGreaterThan(invalidations);
	});

	it("respects the PI_FORCE_IMAGE_PROTOCOL kill switch", async () => {
		// `off` resolves imageProtocol to null on purpose; the probe must not
		// re-enable images behind the user's back.
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "off";
		const { harness } = await startTui();
		expect(harness.writes.join("")).not.toContain(GRAPHICS_QUERY);

		await harness.feed(SIXEL_SUPPORTED_REPLY);

		expect(TERMINAL.imageProtocol).toBeNull();
	});
});

describe("ProcessTerminal DA1 SIXEL detection", () => {
	withoutTerminalMultiplexer();
	const envKeys = [
		"PI_FORCE_IMAGE_PROTOCOL",
		"PI_TUI_NATIVE",
		"PI_NO_GLYPH_PROTOCOL",
		"TERM_PROGRAM",
		...TERMINAL_IDENTITY_KEYS,
	] as const;
	const previousEnv = new Map<string, string | undefined>();
	let harness: ProcessTerminalRenderHarness | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		for (const key of envKeys) {
			previousEnv.set(key, Bun.env[key]);
			delete Bun.env[key];
		}
		Bun.env.PI_TUI_NATIVE = "0";
		Bun.env.PI_NO_GLYPH_PROTOCOL = "1";
		setTerminalImageProtocol(null);
	});

	afterEach(() => {
		harness?.dispose();
		vi.useRealTimers();
		harness = undefined;
		setTerminalImageProtocol(originalProtocol);
		for (const [key, value] of previousEnv) restoreEnv(key, value);
		previousEnv.clear();
	});

	it("enables SIXEL from native Windows Terminal DA1 without a graphics reply", () => {
		harness = createProcessTerminalRenderHarness(80, 24, { conpty: true, nativeWindowsConsole: false });
		const received: string[] = [];
		harness.tui.addInputListener(data => {
			received.push(data);
		});

		harness.type("\x1b[?61;4;6;7;14;21;22;23;24;28;32;42;52cx");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		expect(received).toEqual(["x"]);
		vi.advanceTimersByTime(251);
		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
	});

	it("consumes the graphics reply after DA1 has already enabled SIXEL", () => {
		harness = createProcessTerminalRenderHarness(80, 24, { conpty: false });
		const received: string[] = [];
		harness.tui.addInputListener(data => {
			received.push(data);
		});

		harness.type("\x1b[?62;4;22;28c");
		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		harness.type(`${SIXEL_SUPPORTED_REPLY}x`);

		expect(received).toEqual(["x"]);
		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
	});

	it("consumes a graphics reply split across the stdin flush deadline after DA1", () => {
		harness = createProcessTerminalRenderHarness(80, 24, { conpty: false });
		const received: string[] = [];
		harness.tui.addInputListener(data => {
			received.push(data);
		});

		harness.type("\x1b[?62;4;22;28c");
		harness.type("\x1b[?2;0;1692");
		vi.advanceTimersByTime(51);
		expect(received).toEqual([]);
		harness.type(";432Sx");

		expect(received).toEqual(["x"]);
		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
	});

	it("consumes a negative graphics reply without revoking DA1-advertised support", () => {
		harness = createProcessTerminalRenderHarness(80, 24, { conpty: false });
		const received: string[] = [];
		harness.tui.addInputListener(data => {
			received.push(data);
		});

		harness.type("\x1b[?62;4;22;28c\x1b[?2;3;0Sx");

		expect(received).toEqual(["x"]);
		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
	});

	// tmux 3.6a built with SIXEL answers pane DA1 with attribute 4 whatever
	// client is attached, and refuses the XTSMGRAPHICS geometry query. Only the
	// client terminal's effective `Sxl` (terminfo, overrides, or the `sixel`
	// feature) says whether tmux draws SIXEL or its text placeholder.
	for (const [name, socket, capability, expected] of [
		["ignores tmux's DA1 SIXEL attribute when the client lacks Sxl", "4242", " 216: Sxl: [missing]", null],
		[
			"trusts tmux's DA1 SIXEL attribute when terminal-overrides supply Sxl",
			"4243",
			" 216: Sxl: (flag) true",
			ImageProtocol.Sixel,
		],
	] as const) {
		it.skipIf(process.platform === "win32")(name, async () => {
			const replies = {
				"display-message -p #{client_name}": "/dev/pts/3",
				"show-messages -T -t /dev/pts/3": `Terminal 0: st-256color for /dev/pts/3, flags=0x0:\n${capability}`,
			};
			await withFakeTmux(replies, async binDir => {
				const previousPath = Bun.env.PATH;
				try {
					Bun.env.PATH = `${binDir}:${previousPath ?? ""}`;
					Bun.env.TMUX = `/tmp/tmux-1000/default,${socket},0`;
					harness = createProcessTerminalRenderHarness(80, 24, { conpty: false });
					const received: string[] = [];
					harness.tui.addInputListener(data => {
						received.push(data);
					});

					harness.type("\x1b[?1;2;4c\x1b[?2;3;0Sx");
					vi.advanceTimersByTime(251);

					expect(received).toEqual(["x"]);
					expect(TERMINAL.imageProtocol).toBe(expected);
				} finally {
					harness?.dispose();
					harness = undefined;
					restoreEnv("PATH", previousPath);
				}
			});
		});
	}

	it("reassembles a DA1 advertisement split beyond the stdin flush deadline", () => {
		harness = createProcessTerminalRenderHarness(80, 24, { conpty: true, nativeWindowsConsole: false });
		const received: string[] = [];
		harness.tui.addInputListener(data => {
			received.push(data);
		});

		harness.type("\x1b[?61;4;6;7;14");
		vi.advanceTimersByTime(51);
		expect(TERMINAL.imageProtocol).toBeNull();
		harness.type(";21;22;23;24;28;32;42;52cx");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		expect(received).toEqual(["x"]);
	});

	it("accepts a late unowned DA1 advertisement after the graphics timeout", () => {
		harness = createProcessTerminalRenderHarness(80, 24, { conpty: true, nativeWindowsConsole: false });
		const sentinelCount = harness.writes.reduce((count, write) => count + (write.match(/\x1b\[c/g)?.length ?? 0), 0);
		harness.type("\x1b[?61;6;22c".repeat(sentinelCount));
		vi.advanceTimersByTime(251);
		expect(TERMINAL.imageProtocol).toBeNull();

		harness.type("\x1b[?61;4;6;22c");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
	});

	for (const override of ["off", "none"]) {
		it(`keeps graphics disabled by an explicit ${override} override`, () => {
			Bun.env.PI_FORCE_IMAGE_PROTOCOL = override;
			harness = createProcessTerminalRenderHarness(80, 24, { conpty: true, nativeWindowsConsole: false });

			harness.type("\x1b[?61;4;6;22c");

			expect(TERMINAL.imageProtocol).toBeNull();
		});
	}

	for (const [protocol, identity] of [
		[ImageProtocol.Kitty, "KITTY_WINDOW_ID"],
		[ImageProtocol.Iterm2, "ITERM_SESSION_ID"],
	] as const) {
		it(`does not replace the already selected ${protocol} graphics protocol`, () => {
			// The engine detects the protocol from the terminal's identity.
			Bun.env[identity] = "1";
			setTerminalImageProtocol(protocol);
			harness = createProcessTerminalRenderHarness(80, 24, { conpty: true, nativeWindowsConsole: false });

			harness.type("\x1b[?61;4;6;22c");

			expect(TERMINAL.imageProtocol).toBe(protocol);
		});
	}
});
