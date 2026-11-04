import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { MacAppearanceObserver, MacOSAppearance, rasterizeSvg } from "@oh-my-pi/pi-natives";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Image } from "@oh-my-pi/pi-tui/components/image";
import type { TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";
import {
	type CellDimensions,
	getCellDimensions,
	getTerminalBackgroundColor,
	ImageProtocol,
	isInsideTerminalMultiplexer,
	isTerminalBackgroundQueryTrusted,
	setCellDimensions,
	setTerminalBackgroundColor,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { initTheme, setTheme, stopThemeWatcher } from "@oh-my-pi/pi-tui/theme";
import { type TerminalFramePlan, type TerminalFrameProvider, TUI, type ViewportSize } from "@oh-my-pi/pi-tui";
import { parseSixelPalettePercent } from "./helpers/sixel-palette";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { ManualScheduler, TspHarness, TspTestTerminal } from "./native/tsp-harness";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

class AppearanceTerminal extends VirtualTerminal {
	readonly #reports = new Set<(appearance: TerminalAppearance) => void>();
	readonly writes: string[] = [];

	onAppearanceReport(callback: (appearance: TerminalAppearance) => void): () => void {
		this.#reports.add(callback);
		return () => this.#reports.delete(callback);
	}

	reportBackground(backgroundRgb: number): void {
		setTerminalBackgroundColor(backgroundRgb);
		for (const callback of this.#reports) callback("dark");
	}

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

class TspAppearanceTerminal extends TspTestTerminal {
	readonly #reports = new Set<(appearance: TerminalAppearance) => void>();

	onAppearanceReport(callback: (appearance: TerminalAppearance) => void): () => void {
		this.#reports.add(callback);
		return () => this.#reports.delete(callback);
	}

	reportBackground(backgroundRgb: number): void {
		setTerminalBackgroundColor(backgroundRgb);
		for (const callback of this.#reports) callback("light");
	}
}

async function translucentImage(requestRender: () => void): Promise<Image> {
	const png = await rasterizeSvg(
		new TextEncoder().encode(
			'<svg width="16" height="12"><rect width="16" height="12" fill="white" opacity="0.25"/></svg>',
		),
		16,
		12,
		1,
	);
	return new Image(
		png.toBase64(),
		"image/png",
		{ fallbackColor: text => text },
		{ maxWidthCells: 8, maxHeightCells: 2, requestRender },
		{ widthPx: 16, heightPx: 12 },
	);
}

function expectSixelColor(writes: readonly string[], expected: number): void {
	const channels = parseSixelPalettePercent(writes);
	if (!channels) throw new Error("missing SIXEL palette");
	for (const channel of channels) expect(channel).toBeCloseTo(expected, 0);
}

class TranscriptProvider implements TerminalFrameProvider {
	constructor(readonly transcript: TranscriptContainer) {}

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		return { history: this.transcript.peekFlushBatch(viewport.columns), viewport: ["editor"] };
	}

	acknowledgeHistory(id: number): void {
		this.transcript.acknowledgeFinalizedBatch(id);
	}

	beginHistoryReplay(): void {
		this.transcript.beginReplay();
	}
}

describe("terminal background SIXEL repaint", () => {
	let previousProtocol: ImageProtocol | null;
	let previousCellDimensions: CellDimensions;

	beforeEach(() => {
		previousProtocol = TERMINAL.imageProtocol;
		previousCellDimensions = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 2, heightPx: 6 });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		setTerminalBackgroundColor(0x101010);
	});

	afterEach(() => {
		setTerminalImageProtocol(previousProtocol);
		setCellDimensions(previousCellDimensions);
		setTerminalBackgroundColor(undefined);
	});

	it("repaints a same-appearance RGB change through committed transcript history", async () => {
		const terminal = new AppearanceTerminal(40, 5);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const image = await translucentImage(() => tui.requestRender());
		const transcript = new TranscriptContainer();
		transcript.addChild(image);
		const provider = new TranscriptProvider(transcript);
		tui.addChild(transcript);
		tui.setFrameProvider(provider);
		tui.start();
		try {
			await scheduler.settle(terminal);
			expectSixelColor(terminal.writes, 30);
			terminal.writes.length = 0;

			terminal.reportBackground(0x202020);
			await scheduler.settle(terminal);
			expectSixelColor(terminal.writes, 35);
			expect(terminal.writes.join("")).toContain("\x1b[3J");

			terminal.writes.length = 0;
			terminal.reportBackground(0x202020);
			await scheduler.settle(terminal);
			expect(terminal.writes).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("repaints when a new owner reports the previous owner's RGB after resetting it at startup", async () => {
		const terminal = new AppearanceTerminal(40, 5);
		const start = terminal.start.bind(terminal);
		const startSpy = vi.spyOn(terminal, "start").mockImplementation((onInput, onResize) => {
			setTerminalBackgroundColor(undefined);
			start(onInput, onResize);
		});
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const image = await translucentImage(() => tui.requestRender());
		const transcript = new TranscriptContainer();
		transcript.addChild(image);
		tui.addChild(transcript);
		tui.setFrameProvider(new TranscriptProvider(transcript));
		tui.start();
		try {
			await scheduler.settle(terminal);
			expectSixelColor(terminal.writes, getTerminalBackgroundColor() === 0 ? 25 : 100);
			terminal.writes.length = 0;

			terminal.reportBackground(0x101010);
			await scheduler.settle(terminal);
			expectSixelColor(terminal.writes, 30);
			expect(terminal.writes.join("")).toContain("\x1b[3J");
		} finally {
			tui.stop();
			startSpy.mockRestore();
		}
	});

	it("does not replay identical rows when the background report precedes SIXEL enablement", async () => {
		// The startup OSC 11 reply usually arrives before DA1 enables SIXEL, and
		// the protocol may flip to SIXEL only later, so a report consumed while the
		// protocol is still non-SIXEL must seed the tracked color: revisiting the
		// same RGB once SIXEL is live is not a change and must not replay scrollback.
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const terminal = new AppearanceTerminal(40, 5);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const image = await translucentImage(() => tui.requestRender());
		tui.addChild(image);
		tui.start();
		try {
			await scheduler.settle(terminal);
			terminal.writes.length = 0;
			terminal.reportBackground(0x202020);
			await scheduler.settle(terminal);
			expect(terminal.writes).toEqual([]);

			terminal.writes.length = 0;
			setTerminalImageProtocol(ImageProtocol.Sixel);
			terminal.reportBackground(0x202020);
			await scheduler.settle(terminal);
			expect(terminal.writes).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("repaints multiplexer viewports without clearing their native history", async () => {
		const previousSty = Bun.env.STY;
		Bun.env.STY = "fixture";
		expect(isInsideTerminalMultiplexer()).toBe(true);
		expect(isTerminalBackgroundQueryTrusted()).toBe(true);
		const terminal = new AppearanceTerminal(40, 5);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		let ready = Promise.withResolvers<void>();
		const image = await translucentImage(() => {
			tui.requestRender();
			ready.resolve();
		});
		tui.addChild(image);
		tui.start();
		try {
			await scheduler.settle(terminal);
			await ready.promise;
			await scheduler.settle(terminal);
			expectSixelColor(terminal.writes, 30);
			ready = Promise.withResolvers<void>();
			terminal.writes.length = 0;
			terminal.reportBackground(0x202020);
			await scheduler.settle(terminal);
			await ready.promise;
			await scheduler.settle(terminal);
			expectSixelColor(terminal.writes, 35);
			expect(terminal.writes.join("")).not.toContain("\x1b[3J");
		} finally {
			tui.stop();
			if (previousSty === undefined) delete Bun.env.STY;
			else Bun.env.STY = previousSty;
		}
	});

	it("unsubscribes across stop and restart even when the terminal preserves listeners", async () => {
		const terminal = new AppearanceTerminal(40, 5);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		let ready = Promise.withResolvers<void>();
		const image = await translucentImage(() => {
			tui.requestRender();
			ready.resolve();
		});
		tui.addChild(image);
		tui.start();
		try {
			await scheduler.settle(terminal);
			await ready.promise;
			await scheduler.settle(terminal);
			expectSixelColor(terminal.writes, 30);
			tui.stop();
			terminal.writes.length = 0;
			terminal.reportBackground(0x202020);
			await scheduler.settle(terminal);
			expect(terminal.writes).toEqual([]);
			ready = Promise.withResolvers<void>();
			tui.start();
			await scheduler.settle(terminal);
			await ready.promise;
			await scheduler.settle(terminal);
			expectSixelColor(terminal.writes, 35);
			terminal.writes.length = 0;
			ready = Promise.withResolvers<void>();
			terminal.reportBackground(0x303030);
			await scheduler.settle(terminal);
			await ready.promise;
			await scheduler.settle(terminal);
			expectSixelColor(terminal.writes, 39);
		} finally {
			tui.stop();
		}
	});

	it.each([ImageProtocol.Kitty, ImageProtocol.Iterm2, null])("does not repaint protocol %s", async protocol => {
		setTerminalImageProtocol(protocol);
		const terminal = new AppearanceTerminal(40, 5);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const image = await translucentImage(() => tui.requestRender());
		tui.addChild(image);
		tui.start();
		try {
			await scheduler.settle(terminal);
			terminal.writes.length = 0;
			terminal.reportBackground(0x202020);
			await scheduler.settle(terminal);
			expect(terminal.writes).toEqual([]);
		} finally {
			tui.stop();
		}
	});
	describe("TSP handshakes", () => {
		it.each(["rejection", "timeout"] as const)("repaints SIXEL after TSP handshake %s", async failure => {
			await initTheme(false);
			setTerminalBackgroundColor(0x000000);
			const terminal = new TspAppearanceTerminal({
				expected: true,
				reply: false,
				manualProbe: failure === "timeout",
			});
			const harness = new TspHarness(terminal, new ManualScheduler());
			const image = await translucentImage(() => harness.tui.requestRender());
			harness.tui.addChild(image);
			harness.tui.start();
			try {
				// Let optimistic startup either receive its rejection or expire.
				// A timed-out probe can still be pending in the terminal afterward.
				harness.flush(1000);
				expect(harness.tui.nativeRendering).toBe(false);
				await harness.until(() => {
					harness.flush(40);
					return /#\d+;2;/.test(terminal.rowBytes);
				});
				expectSixelColor([terminal.rowBytes], 25);
				terminal.rowBytes = "";
				terminal.reportBackground(0x000000);
				harness.flush(40);
				expect(terminal.rowBytes).toBe("");

				terminal.reportBackground(0xffffff);
				await harness.until(() => {
					harness.flush(40);
					return /#\d+;2;/.test(terminal.rowBytes);
				});
				expectSixelColor([terminal.rowBytes], 100);
			} finally {
				harness.stop();
			}
		});

		it.each(["rejection", "timeout"] as const)(
			"repaints when the background returns to its startup RGB after TSP %s",
			async failure => {
				await initTheme(false);
				setTerminalBackgroundColor(0x000000);
				const terminal = new TspAppearanceTerminal({
					expected: true,
					reply: false,
					manualProbe: failure === "timeout",
				});
				const harness = new TspHarness(terminal, new ManualScheduler());
				const image = await translucentImage(() => harness.tui.requestRender());
				harness.tui.addChild(image);
				harness.tui.start();
				try {
					expect(harness.tui.nativeRendering).toBe(true);
					// Both colors are dark: RGB tracking must not depend on a theme change.
					terminal.reportBackground(0x404040);
					harness.flush(1000);
					expect(harness.tui.nativeRendering).toBe(false);
					await harness.until(() => {
						harness.flush(40);
						return /#\d+;2;/.test(terminal.rowBytes);
					});
					expectSixelColor([terminal.rowBytes], 44);
					terminal.rowBytes = "";

					terminal.reportBackground(0x000000);
					await harness.until(() => {
						harness.flush(40);
						return /#\d+;2;/.test(terminal.rowBytes);
					});
					expectSixelColor([terminal.rowBytes], 25);
				} finally {
					harness.stop();
				}
			},
		);

		it.each(["optimistic", "confirmed"] as const)("does not row-repaint a %s native surface", async state => {
			await initTheme(false);
			const terminal = new TspAppearanceTerminal({ expected: true, manualProbe: state === "optimistic" });
			const harness = new TspHarness(terminal, new ManualScheduler());
			const image = await translucentImage(() => harness.tui.requestRender());
			harness.tui.addChild(image);
			harness.tui.start();
			try {
				harness.flush();
				expect(harness.tui.nativeRendering).toBe(true);
				terminal.rowBytes = "";
				terminal.reportBackground(0xffffff);
				harness.flush(40);
				expect(terminal.rowBytes).toBe("");
			} finally {
				harness.stop();
			}
		});
	});

	describe("macOS fallback appearance", () => {
		let platformDescriptor: PropertyDescriptor;
		let previousColorfgbg: string | undefined;
		let previousZellij: string | undefined;
		let reportAppearance: (appearance: MacOSAppearance) => void;

		beforeEach(async () => {
			platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
			previousColorfgbg = Bun.env.COLORFGBG;
			previousZellij = Bun.env.ZELLIJ;
			Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
			Bun.env.ZELLIJ = "1";
			delete Bun.env.COLORFGBG;
			setTerminalBackgroundColor(undefined);
			vi.spyOn(MacAppearanceObserver, "start").mockImplementation(callback => {
				reportAppearance = appearance => callback(null, appearance);
				return { stop() {} };
			});
			await initTheme(true, undefined, undefined, "dark", "dark");
			reportAppearance(MacOSAppearance.Dark);
		});

		afterEach(() => {
			stopThemeWatcher();
			vi.restoreAllMocks();
			Object.defineProperty(process, "platform", platformDescriptor);
			if (previousColorfgbg === undefined) delete Bun.env.COLORFGBG;
			else Bun.env.COLORFGBG = previousColorfgbg;
			if (previousZellij === undefined) delete Bun.env.ZELLIJ;
			else Bun.env.ZELLIJ = previousZellij;
		});

		async function startFallbackImage() {
			const terminal = new AppearanceTerminal(40, 5);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
			let ready = Promise.withResolvers<void>();
			const image = await translucentImage(() => {
				tui.requestRender();
				ready.resolve();
			});
			tui.addChild(image);
			tui.start();
			async function settleImage(): Promise<void> {
				await scheduler.settle(terminal);
				await ready.promise;
				await scheduler.settle(terminal);
				ready = Promise.withResolvers<void>();
			}
			await settleImage();
			return { terminal, scheduler, tui, settleImage };
		}

		it.each(["fixed theme", "identical auto-theme mappings"])("repaints fallback RGB with %s", async mode => {
			if (mode === "fixed theme") await setTheme("dark");
			const { terminal, tui, settleImage } = await startFallbackImage();
			try {
				expectSixelColor(terminal.writes, 25);
				terminal.writes.length = 0;
				reportAppearance(MacOSAppearance.Light);
				await settleImage();
				expectSixelColor(terminal.writes, 100);
				expect(terminal.writes.join("")).not.toContain("\x1b[3J");
			} finally {
				tui.stop();
			}
		});

		it("does not repaint duplicate reports or changes overridden by COLORFGBG", async () => {
			const { terminal, scheduler, tui } = await startFallbackImage();
			try {
				terminal.writes.length = 0;
				reportAppearance(MacOSAppearance.Dark);
				await scheduler.settle(terminal);
				expect(terminal.writes).toEqual([]);

				Bun.env.COLORFGBG = "15;0";
				reportAppearance(MacOSAppearance.Light);
				await scheduler.settle(terminal);
				expect(terminal.writes).toEqual([]);
			} finally {
				tui.stop();
			}
		});

		it("stops fallback repaints while stopped and resumes them after restart", async () => {
			const { terminal, scheduler, tui, settleImage } = await startFallbackImage();
			try {
				tui.stop();
				terminal.writes.length = 0;
				reportAppearance(MacOSAppearance.Light);
				await scheduler.settle(terminal);
				expect(terminal.writes).toEqual([]);

				tui.start();
				await settleImage();
				expectSixelColor(terminal.writes, 100);
				terminal.writes.length = 0;
				reportAppearance(MacOSAppearance.Dark);
				await settleImage();
				expectSixelColor(terminal.writes, 25);
			} finally {
				tui.stop();
			}
		});
	});
});
