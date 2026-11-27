/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, test } from "bun:test";
import { createRoot, createSurface, effect, isUiNode, type JSXNode, signal, type UiNode } from "@oh-my-pi/pi-tui";
import type { FramePlan, TerminalCapabilities, TerminalDriver } from "@oh-my-pi/pi-tui/driver/contract";
import { RESERVED_ROW } from "@oh-my-pi/pi-tui/driver/images/anchor";
import { itermImage } from "@oh-my-pi/pi-tui/driver/images/iterm";
import { kittyPlacementRows, kittyTransmit } from "@oh-my-pi/pi-tui/driver/images/kitty";
import { TerminalImages, type TerminalImagesOptions } from "@oh-my-pi/pi-tui/driver/images/store";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { driverImages, TermBackend } from "@oh-my-pi/pi-tui/term/backend";
import { type PaintEnvironment, paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import "@oh-my-pi/pi-tui/term/painters/index";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

const theme = loadThemeSync("dark");
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_1PX, "base64");
const BLOB = registerBlob(PNG_BYTES, "image/png");

function capabilities(overrides: Partial<TerminalCapabilities> = {}): TerminalCapabilities {
	return {
		truecolor: true,
		colors: 16_777_216,
		synchronizedOutput: true,
		hyperlinks: false,
		images: "kitty",
		kittyKeyboard: true,
		bracketedPaste: true,
		background: null,
		dark: true,
		cell: { w: 10, h: 20 },
		multiplexer: null,
		textSizing: false,
		tsp: false,
		pixelMouse: false,
		...overrides,
	};
}

function store(overrides: Partial<TerminalCapabilities> = {}, options: Partial<TerminalImagesOptions> = {}) {
	const caps = signal(capabilities(overrides));
	const images = new TerminalImages({ capabilities: caps, ...options });
	return { images, seam: driverImages(images, caps) };
}

function one(jsx: JSXNode): UiNode {
	if (!isUiNode(jsx)) throw new Error("expected one node");
	return jsx;
}

/** Paint inside a root (images are referenced by the painting computation); returns the rows and a disposer. */
function paint(env: PaintEnvironment, node: UiNode, width: number, height?: number): readonly string[] {
	return paintNode(env, node, width, height).rows;
}

describe("image painter", () => {
	test("without terminal images: the muted alt, cut to the width", () => {
		createRoot(dispose => {
			const env = staticEnvironment(theme);
			const node = one(<image blob={BLOB} w={100} h={100} alt="[Image: shot.png]" />);
			expect(paint(env, node, 40)).toEqual([theme.fg("muted", "[Image: shot.png]")]);
			expect(paint(env, node, 8).map(stripEscapes)).toEqual(["[Image:…"]);
			dispose();
		});
	});

	test("kitty: per-row placements at the fitted box; the frame transmits the blob once", () => {
		createRoot(dispose => {
			const { images, seam } = store();
			const env = staticEnvironment(theme, { images: seam });
			// 100×100 px on 10×20 cells, capped at 4 columns: 4×2 cells.
			const node = one(<image blob={BLOB} w={100} h={100} alt="a" max={{ w: "4ch" }} />);
			const rows = paint(env, node, 40);
			expect(images.settle()).toBe(false);
			const sequences = images.takeSequences();
			const id = Number(/i=(\d+)/.exec(sequences)?.[1]);
			expect(sequences).toBe(kittyTransmit(PNG_1PX, id));
			expect(rows).toEqual(kittyPlacementRows({ id, widthPx: 100, heightPx: 100 }, 4, 2, 1));
			// A parent fixing one row caps the box.
			expect(paint(env, node, 40, 1)).toHaveLength(1);
			dispose();
		});
	});

	test("iTerm2: the inline file anchored to the box's last row", () => {
		createRoot(dispose => {
			const env = staticEnvironment(theme, { images: store({ images: "iterm" }).seam });
			const node = one(<image blob={BLOB} w={100} h={100} max={{ w: "4ch", h: "2lines" }} />);
			expect(paint(env, node, 40)).toEqual([RESERVED_ROW, `\x1b7\x1b[1A${itermImage(PNG_1PX, 4, 2)}\x1b8`]);
			dispose();
		});
	});

	test("SIXEL: reserved rows while encoding, then the encoded image", async () => {
		const { images, seam } = store(
			{ images: "sixel" },
			{ encodeSixel: async (bytes, w, h) => `\x1bPq${bytes.length}:${w}x${h}\x1b\\` },
		);
		const env = staticEnvironment(theme, { images: seam });
		const node = createRoot(() => one(<image blob={BLOB} w={40} h={40} />));
		expect(paint(env, node, 40)).toEqual([RESERVED_ROW, RESERVED_ROW]);
		await images.whenEncoded();
		expect(paint(env, node, 40)).toEqual([RESERVED_ROW, `\x1b7\x1b[1A\x1bPq${PNG_BYTES.length}:40x40\x1b\\\x1b8`]);
	});

	test("budget: the older image falls back to its label in the rows it took", () => {
		createRoot(dispose => {
			const { images, seam } = store({}, { budget: 1 });
			const env = staticEnvironment(theme, { images: seam });
			const other = registerBlob(Buffer.concat([PNG_BYTES, Buffer.from([0])]), "image/png");
			const older = one(<image blob={BLOB} w={100} h={100} alt="older" max={{ w: "4ch" }} />);
			const newer = one(<image blob={other} w={100} h={100} alt="newer" max={{ w: "4ch" }} />);
			paint(env, older, 40);
			paint(env, newer, 40);
			expect(images.settle()).toBe(true);
			// The label is cut to the image box (4 columns).
			const fallback = paint(env, older, 40);
			expect(fallback.map(stripEscapes)).toEqual(["old…", ""]);
			expect(fallback[1]).toBe(RESERVED_ROW);
			expect(paint(env, newer, 40)[0]).toContain("\x1b_Ga=p");
			dispose();
		});
	});

	test("an unknown blob falls back to the label", () => {
		createRoot(dispose => {
			const env = staticEnvironment(theme, { images: store().seam });
			expect(paint(env, one(<image blob="feed" w={10} h={10} alt="gone" />), 40)).toEqual([
				theme.fg("muted", "gone"),
			]);
			dispose();
		});
	});

	test("JPEG on kitty: reserved while converting to PNG, then drawn; undecodable data falls back", async () => {
		const converted: string[] = [];
		const { images, seam } = store(
			{},
			{
				convertPng: async bytes => {
					if (bytes[3] === 1) throw new Error("undecodable");
					converted.push(Buffer.from(bytes).toString("hex"));
					return PNG_1PX;
				},
			},
		);
		const env = staticEnvironment(theme, { images: seam });
		const jpeg = registerBlob(Buffer.from([0xff, 0xd8, 0xff, 0]), "image/jpeg");
		const broken = registerBlob(Buffer.from([0xff, 0xd8, 0xff, 1]), "image/jpeg");
		const rows = signal(0);
		let painted: readonly string[] = [];
		let fallback: readonly string[] = [];
		const dispose = createRoot(dispose => {
			const node = one(<image blob={jpeg} w={10} h={20} alt="jpeg" />);
			const bad = one(<image blob={broken} w={10} h={20} alt="broken" />);
			effect(() => {
				rows();
				painted = paint(env, node, 40);
				fallback = paint(env, bad, 40);
			});
			return dispose;
		});
		expect(painted).toEqual([RESERVED_ROW]);
		expect(fallback).toEqual([RESERVED_ROW]);
		await images.whenEncoded();
		rows.set(1);
		expect(converted).toEqual(["ffd8ff00"]);
		expect(painted.map(stripEscapes)).toEqual([""]);
		expect(painted[0]).toContain("\x1b_Ga=p");
		expect(fallback).toEqual([theme.fg("muted", "broken")]);
		expect(images.takeSequences()).toContain(kittyTransmit(PNG_1PX, Number(/i=(\d+)/.exec(painted[0]!)?.[1])));
		dispose();
	});
});

class StubDriver implements TerminalDriver {
	readonly columns = 40;
	readonly rows = 10;
	readonly capabilities = capabilities();
	last: FramePlan = { viewport: [], cursor: null };
	constructor(readonly images: TerminalImages) {}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	present(frame: FramePlan): number | undefined {
		this.last = frame;
		return frame.history?.id;
	}
	writeRaw(): void {}
	onInput(): () => void {
		return () => {};
	}
	onResize(): () => void {
		return () => {};
	}
	onCapabilities(): () => void {
		return () => {};
	}
	onReplay(): () => void {
		return () => {};
	}
	resetDisplay(): void {}
	setTitle(): void {}
}

describe("terminal backend image seam", () => {
	test("painters reach the images the backend was given", () => {
		const { images, seam } = store();
		const driver = new StubDriver(images);
		const surface = createSurface(() => ({
			dock: <image blob={BLOB} w={100} h={100} alt="dock" max={{ w: "4ch" }} />,
		}));
		const backend = new TermBackend({ surface, driver, theme: () => theme, images: seam, frameInterval: 0 });
		backend.start();
		expect(backend.environment.images).toBe(seam);
		const placements = driver.last.viewport.filter(row => row.includes("\x1b_Ga=p"));
		expect(placements).toHaveLength(2);
		backend.stop();
		surface.dispose();
	});
});
