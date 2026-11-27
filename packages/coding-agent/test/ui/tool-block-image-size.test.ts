import { describe, expect, test } from "bun:test";
import { imagePlaceholder } from "../../src/ui/transcript/tool-block";

/** JPEG whose SOF0 sits after a 64-byte APP1 segment, past any short header prefix. */
function jpeg(width: number, height: number): string {
	const app1 = [0xff, 0xe1, 0x00, 66, ...Array.from({ length: 64 }, () => 0)];
	const sof0 = [0xff, 0xc0, 0x00, 11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0];
	return Buffer.from([0xff, 0xd8, ...app1, ...sof0, 0xff, 0xd9]).toString("base64");
}

/** Extended (VP8X) WebP header. */
function webp(width: number, height: number): string {
	const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
	const chunk = [...Buffer.from("VP8X"), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
	const body = [...Buffer.from("WEBP"), ...chunk];
	return Buffer.from([...Buffer.from("RIFF"), body.length, 0, 0, 0, ...body]).toString("base64");
}

describe("tool result image placeholder", () => {
	test("reports JPEG pixel size", () => {
		expect(imagePlaceholder({ data: jpeg(1280, 720), mimeType: "image/jpeg" })).toBe(
			"[Image: [image/jpeg] 1280x720]",
		);
	});

	test("reports WebP pixel size", () => {
		expect(imagePlaceholder({ data: webp(1000, 677), mimeType: "image/webp" })).toBe(
			"[Image: [image/webp] 1000x677]",
		);
	});
});
