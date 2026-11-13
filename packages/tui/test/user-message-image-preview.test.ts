import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import { type UserBubbleOptions, UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { convertImageToPngShared } from "@oh-my-pi/pi-tui/chat/image-loading";
import { ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	getCellDimensions,
	ImageProtocol,
	parseKittyDirectPlacementLine,
	setCellDimensions,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

// 1x1 PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type MutableTerminalInfo = { id: string; imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminalInfo;

const originalProtocol = TERMINAL.imageProtocol;
const originalGraphics = { ...getKittyGraphics() };
const originalCellDims = getCellDimensions();

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	setCellDimensions(originalCellDims);
	terminal.imageProtocol = originalProtocol;
	setKittyGraphics(originalGraphics);
	setNativeRendering(false);
});

/** Render the component through a budget pass, like the transcript host does. */
function renderWithBudget(component: UserMessageComponent, budget: ImageBudget, width = 60): readonly string[] {
	budget.beginPass();
	const lines = component.render(width);
	budget.endPass();
	return lines;
}

function baselineLines(text: string, options?: UserBubbleOptions): readonly string[] {
	const plain = new UserMessageComponent(text, options);
	return plain.render(60);
}

const OSC133_ZONE_CLOSE = "\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07";

describe("user message image previews", () => {
	it("renders no preview children without a graphics protocol", () => {
		terminal.imageProtocol = null;
		const budget = new ImageBudget(8, () => {});
		const withImage = new UserMessageComponent("see shot", {
			images: [{ type: "image", data: PNG, mimeType: "image/png" }],
			imageBudget: budget,
			showImages: true,
		});
		expect(renderWithBudget(withImage, budget)).toEqual(baselineLines("see shot"));
	});

	it("appends a live SIXEL preview after the text once the encode lands", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		const encodeSixel = spyOn(natives, "encodeSixelAsync").mockResolvedValue("\x1bP0;1;0q\x1b\\");
		try {
			let repaints = 0;
			const budget = new ImageBudget(8, () => {
				repaints++;
			});
			const component = new UserMessageComponent("see shot", {
				images: [{ type: "image", data: PNG, mimeType: "image/png" }],
				imageBudget: budget,
				onImageUpdate: () => repaints++,
				showImages: true,
			});
			const textOnly = baselineLines("see shot");

			// First pass reserves the preview rows while the encode runs.
			const pending = renderWithBudget(component, budget);
			expect(pending.length).toBeGreaterThan(textOnly.length);

			await encodeSixel.mock.results[0]?.value;
			const shown = renderWithBudget(component, budget);
			expect(shown.at(-1)).toContain("\x1bP");
			expect(shown.length).toBe(pending.length);
			expect(repaints).toBeGreaterThan(0);
		} finally {
			encodeSixel.mockRestore();
		}
	});

	it("skips previews for video chips and synthetic messages", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const budget = new ImageBudget(8, () => {});
		const video = new UserMessageComponent("see clip", {
			images: [{ type: "image", data: PNG, mimeType: "video/mp4" }],
			imageBudget: budget,
			showImages: true,
		});
		expect(renderWithBudget(video, budget)).toEqual(baselineLines("see clip"));

		const synthetic = new UserMessageComponent("Session update", {
			images: [{ type: "image", data: PNG, mimeType: "image/png" }],
			imageBudget: budget,
			synthetic: true,
			showImages: true,
		});
		expect(renderWithBudget(synthetic, budget)).toEqual(baselineLines("Session update", { synthetic: true }));
	});

	it("feeds Kitty a converted PNG for a non-PNG paste and repaints when it lands", async () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		setKittyGraphics({ unicodePlaceholders: false });
		let repaints = 0;
		// Non-PNG bytes are what the Kitty branch keys on (mime is metadata; the
		// decoder sniffs content), so PNG bytes labeled jpeg exercise the same
		// decode → re-encode → cache → re-mount path as a real paste.
		const jpegImage = { type: "image", data: PNG, mimeType: "image/jpeg" } as const;
		const budget = new ImageBudget(8, () => {
			repaints++;
		});
		const component = new UserMessageComponent("see photo", {
			images: [jpegImage],
			imageBudget: budget,
			onImageUpdate: () => repaints++,
			showImages: true,
		});

		// No cached conversion yet: no preview rows, no repaint request.
		const before = renderWithBudget(component, budget);
		expect(before).toEqual(baselineLines("see photo"));
		expect(repaints).toBe(0);

		// Await the same shared conversion the component queued; its handler (a
		// continuation registered first) has run by the time this resolves.
		await convertImageToPngShared(jpegImage);
		expect(repaints).toBeGreaterThan(0);

		const shown = renderWithBudget(component, budget);
		expect(shown.length).toBeGreaterThan(before.length);
		const last = shown.at(-1) ?? "";
		expect(last).toContain("\x1b_Ga=p");
		// The placement line is a direct placement: it carries no image payload at all.
		expect(last).not.toContain(PNG);
		const transmits = [...budget.takeTransmits()];
		expect(transmits).toHaveLength(1);
		expect(transmits[0]).toContain("\x1b_Ga=t");
	});

	it("renders no previews when terminal.showImages is off or the native renderer owns the bubble", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const budget = new ImageBudget(8, () => {});
		const image = { type: "image", data: PNG, mimeType: "image/png" } as const;
		const off = new UserMessageComponent("see shot", { images: [image], imageBudget: budget, showImages: false });
		expect(renderWithBudget(off, budget)).toEqual(baselineLines("see shot"));
		const omitted = new UserMessageComponent("see shot", { images: [image], imageBudget: budget });
		expect(renderWithBudget(omitted, budget)).toEqual(baselineLines("see shot"));

		setNativeRendering(true);
		const native = new UserMessageComponent("see shot", { images: [image], imageBudget: budget, showImages: true });
		expect(renderWithBudget(native, budget)).toEqual(baselineLines("see shot"));
	});

	it("closes the OSC 133 zone on the prose row so the Kitty placement row stays parseable", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		setKittyGraphics({ unicodePlaceholders: false });
		const budget = new ImageBudget(8, () => {});
		const component = new UserMessageComponent("see shot", {
			images: [{ type: "image", data: PNG, mimeType: "image/png" }],
			imageBudget: budget,
			showImages: true,
		});
		const shown = renderWithBudget(component, budget);
		const textOnly = baselineLines("see shot");
		expect(parseKittyDirectPlacementLine(shown.at(-1) ?? "")).not.toBeNull();
		expect(shown.filter(line => line.includes(OSC133_ZONE_CLOSE))).toEqual([textOnly.at(-1) ?? ""]);
	});

	it("mounts one spacer when two Kitty conversions land at different times", async () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		setKittyGraphics({ unicodePlaceholders: false });
		const png = { type: "image", data: PNG, mimeType: "image/png" } as const;
		const late = { type: "image", data: PNG, mimeType: "image/webp" } as const;
		const budget = new ImageBudget(8, () => {});
		const component = new UserMessageComponent("two shots", {
			images: [png, late],
			imageBudget: budget,
			showImages: true,
		});
		await convertImageToPngShared(late);
		const shown = renderWithBudget(component, budget);

		// The same two images, both ready at construction: the layout a remount must reproduce.
		const readyBudget = new ImageBudget(8, () => {});
		const ready = new UserMessageComponent("two shots", {
			images: [png, png],
			imageBudget: readyBudget,
			showImages: true,
		});
		expect(shown.length).toBe(renderWithBudget(ready, readyBudget).length);
	});
});
