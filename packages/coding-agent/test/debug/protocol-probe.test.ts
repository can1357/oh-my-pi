import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	buildLargeTextLines,
	buildSampleImage,
	encodeRgbPng,
	ProtocolProbeComponent,
} from "@oh-my-pi/pi-coding-agent/debug/protocol-probe";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getImageDimensions, ImageBudget, ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	// buildLargeTextLines styles the OSC 66 span through the global theme singleton.
	await initTheme();
});

type MutableTerminalInfo = { imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminalInfo;
const originalImageProtocol = TERMINAL.imageProtocol;

afterEach(() => {
	terminal.imageProtocol = originalImageProtocol;
});

describe("encodeRgbPng / buildSampleImage", () => {
	it("emits a PNG whose IHDR dimensions decode back to the requested size", () => {
		// The graphics test relies on producing a *valid* PNG: Kitty/iTerm2 hand
		// the bytes to the terminal and Sixel decodes them natively, so a malformed
		// header (wrong CRC, bad chunk framing) silently breaks the whole panel.
		const sample = buildSampleImage(48, 24);
		expect(sample.mimeType).toBe("image/png");
		expect(sample.dimensions).toEqual({ widthPx: 48, heightPx: 24 });

		const decoded = getImageDimensions(sample.base64, "image/png");
		expect(decoded).toEqual({ widthPx: 48, heightPx: 24 });
	});

	it("begins with the PNG signature and round-trips arbitrary pixel sizes", () => {
		const png = encodeRgbPng(3, 2, new Uint8Array(3 * 2 * 3));
		expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

		const decoded = getImageDimensions(Buffer.from(png).toString("base64"), "image/png");
		expect(decoded).toEqual({ widthPx: 3, heightPx: 2 });
	});
});

it("uses independent graphics ids for repeated probe panels", () => {
	terminal.imageProtocol = ImageProtocol.Kitty;
	const budget = new ImageBudget(8, () => {});
	const image = buildSampleImage(8, 8);
	const first = new ProtocolProbeComponent({ image, imageBudget: budget, notificationSuppressed: true });
	const second = new ProtocolProbeComponent({ image, imageBudget: budget, notificationSuppressed: true });

	budget.beginPass();
	const firstBytes = first.render(80).join("\n");
	const secondBytes = second.render(80).join("\n");
	budget.endPass();

	const firstMatch = firstBytes.match(/i=(\d+)/);
	const secondMatch = secondBytes.match(/i=(\d+)/);
	expect(firstMatch).not.toBeNull();
	expect(secondMatch).not.toBeNull();
	const firstId = Number(firstMatch![1]);
	const secondId = Number(secondMatch![1]);
	expect(secondId).toBe((firstId + 1) & 0xffffff || 1);
});

describe("buildLargeTextLines", () => {
	it("encodes each scale as an OSC 66 span and reserves scale-1 blank rows below it", () => {
		const lines = buildLargeTextLines([2, 3]);
		// scale 2 → 1 reserved row, scale 3 → 2 reserved rows.
		expect(lines).toHaveLength(5);
		expect(lines[0]).toContain("\x1b]66;s=2;");
		expect(lines[1]).toBe("");
		expect(lines[2]).toContain("\x1b]66;s=3;");
		expect(lines[3]).toBe("");
		expect(lines[4]).toBe("");
	});
});
