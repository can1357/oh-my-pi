import { describe, expect, it } from "bun:test";
import { EnhancedPasteController } from "@oh-my-pi/pi-coding-agent/utils/enhanced-paste";

const ST = "\x1b\\";
const BEL = "\x07";
const OSC = "\x1b]5522;";

function packet(metadata: string, payload?: string): string {
	return `${OSC}${metadata}${payload === undefined ? "" : `;${payload}`}${ST}`;
}

function unexpectedNativePaste(): never {
	throw new Error("unexpected native clipboard paste");
}

describe("EnhancedPasteController", () => {
	it("requests image data from an OSC 5522 paste event and preserves chunk boundaries", () => {
		const writes: string[] = [];
		const pastedImages: Array<{ data: string; mimeType: string }> = [];
		const statuses: string[] = [];
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			pasteText: () => statuses.push("unexpected text paste"),
			pasteImage: image => {
				pastedImages.push({ data: image.data, mimeType: image.mimeType });
			},
			showStatus: message => statuses.push(message),
			pasteNative: unexpectedNativePaste,
		});

		controller.enable();
		expect(writes).toEqual(["\x1b[?5522h"]);

		const imageMime = Buffer.from("image/png", "utf8").toString("base64");
		const textMime = Buffer.from("text/plain", "utf8").toString("base64");
		const password = Buffer.from("secret123", "utf8").toString("base64");
		controller.handleInput(packet(`type=read:status=OK:pw=${password}`));
		controller.handleInput(packet(`type=read:status=DATA:mime=${textMime}`));
		controller.handleInput(packet(`type=read:status=DATA:mime=${imageMime}`));
		controller.handleInput(packet("type=read:status=DONE"));

		const pasteEventName = Buffer.from("Paste event", "utf8").toString("base64");
		expect(writes.at(-1)).toBe(`${OSC}type=read:pw=${password}:name=${pasteEventName}:mime=${imageMime}${BEL}`);

		controller.handleInput(packet("type=read:status=OK"));
		controller.handleInput(
			packet(`type=read:status=DATA:mime=${imageMime}`, Buffer.from("image-", "utf8").toString("base64")),
		);
		controller.handleInput(
			packet(`type=read:status=DATA:mime=${imageMime}`, Buffer.from("bytes", "utf8").toString("base64")),
		);
		controller.handleInput(packet("type=read:status=DONE"));

		expect(pastedImages).toEqual([
			{
				data: Buffer.from("image-bytes", "utf8").toString("base64"),
				mimeType: "image/png",
			},
		]);
		expect(statuses).toEqual([]);
	});

	it("falls back to text/plain and carries primary-selection location into the read request", () => {
		const writes: string[] = [];
		const pastedText: string[] = [];
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			pasteText: text => pastedText.push(text),
			pasteImage: () => {
				throw new Error("unexpected image paste");
			},
			showStatus: message => pastedText.push(`status:${message}`),
			pasteNative: unexpectedNativePaste,
		});

		const textMime = Buffer.from("text/plain", "utf8").toString("base64");
		const password = Buffer.from("secret456", "utf8").toString("base64");
		const pasteEventName = Buffer.from("Paste event", "utf8").toString("base64");
		expect(controller.handleInput("plain text")).toBe(false);
		controller.handleInput(packet(`type=read:status=OK:loc=primary:pw=${password}`));
		controller.handleInput(packet(`type=read:status=DATA:mime=${textMime}`));
		controller.handleInput(packet("type=read:status=DONE"));

		expect(writes).toEqual([
			`${OSC}type=read:loc=primary:pw=${password}:name=${pasteEventName}:mime=${textMime}${BEL}`,
		]);

		controller.handleInput(packet("type=read:status=OK"));
		controller.handleInput(
			packet(`type=read:status=DATA:mime=${textMime}`, Buffer.from("hello ", "utf8").toString("base64")),
		);
		controller.handleInput(
			packet(`type=read:status=DATA:mime=${textMime}`, Buffer.from("world", "utf8").toString("base64")),
		);
		controller.handleInput(packet("type=read:status=DONE"));

		expect(pastedText).toEqual(["hello world"]);
	});

	it("falls back to the native clipboard reader when the listing has no supported MIME type", () => {
		const writes: string[] = [];
		const statuses: string[] = [];
		let nativeAvailable = true;
		let nativePastes = 0;
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			pasteText: () => {},
			pasteImage: () => {},
			showStatus: message => statuses.push(message),
			pasteNative: () => {
				nativePastes++;
				return nativeAvailable;
			},
		});

		// macOS screenshots copied straight to the clipboard list only `image/tiff` (#17696).
		const tiffMime = Buffer.from("image/tiff", "utf8").toString("base64");
		expect(controller.handleInput(packet("type=read:status=OK"))).toBe(true);
		expect(controller.handleInput(packet(`type=read:status=DATA:mime=${tiffMime}`))).toBe(true);
		expect(controller.handleInput(packet("type=read:status=DONE"))).toBe(true);

		expect(nativePastes).toBe(1);
		expect(writes).toEqual([]);
		expect(statuses).toEqual([]);

		// Remote session: the native clipboard is not the user's, so report the unsupported listing.
		nativeAvailable = false;
		const htmlMime = Buffer.from("text/html", "utf8").toString("base64");
		controller.handleInput(packet("type=read:status=OK"));
		controller.handleInput(packet(`type=read:status=DATA:mime=${htmlMime}`));
		controller.handleInput(packet("type=read:status=DONE"));

		expect(nativePastes).toBe(2);
		expect(writes).toEqual([]);
		expect(statuses).toEqual(["Clipboard paste has no supported text or image data"]);
	});

	it("does not paste the regular clipboard for an unsupported primary-selection listing", () => {
		const statuses: string[] = [];
		const controller = new EnhancedPasteController({
			write: () => {},
			pasteText: () => {},
			pasteImage: () => {},
			showStatus: message => statuses.push(message),
			pasteNative: unexpectedNativePaste,
		});

		const tiffMime = Buffer.from("image/tiff", "utf8").toString("base64");
		controller.handleInput(packet("type=read:status=OK:loc=primary"));
		controller.handleInput(packet(`type=read:status=DATA:mime=${tiffMime}`));
		controller.handleInput(packet("type=read:status=DONE"));

		expect(statuses).toEqual(["Clipboard paste has no supported text or image data"]);
	});

	it("decodes Kitty's dot-listing DATA payload to discover plain-text and request it", () => {
		const writes: string[] = [];
		const pastedText: string[] = [];
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			pasteText: text => pastedText.push(text),
			pasteImage: () => {
				throw new Error("unexpected image paste");
			},
			showStatus: message => pastedText.push(`status:${message}`),
			pasteNative: unexpectedNativePaste,
		});

		const dot = Buffer.from(".", "utf8").toString("base64");
		const textMime = Buffer.from("text/plain", "utf8").toString("base64");
		const password = Buffer.from("secret-token-123", "utf8").toString("base64");
		const pasteEventName = Buffer.from("Paste event", "utf8").toString("base64");

		// Kitty bundles the available MIME types into a single DATA packet
		// whose `mime` field is the literal `.` and whose payload carries a
		// whitespace-separated, base64-encoded list (e.g. "text/plain\n").
		controller.handleInput(packet(`type=read:status=OK:pw=${password}`));
		controller.handleInput(
			packet(
				`type=read:status=DATA:mime=${dot}:pw=${password}`,
				Buffer.from("text/plain\n", "utf8").toString("base64"),
			),
		);
		controller.handleInput(packet(`type=read:status=DONE:pw=${password}`));

		expect(writes.at(-1)).toBe(`${OSC}type=read:pw=${password}:name=${pasteEventName};${textMime}${BEL}`);

		controller.handleInput(packet("type=read:status=OK"));
		controller.handleInput(
			packet(`type=read:status=DATA:mime=${textMime}`, Buffer.from("hello", "utf8").toString("base64")),
		);
		controller.handleInput(
			packet(`type=read:status=DATA:mime=${textMime}`, Buffer.from(" world", "utf8").toString("base64")),
		);
		controller.handleInput(packet("type=read:status=DONE"));

		expect(pastedText).toEqual(["hello world"]);
	});

	it("prefers images when Kitty's dot-listing payload advertises multiple MIME types", () => {
		const writes: string[] = [];
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			pasteText: () => {
				throw new Error("unexpected text paste");
			},
			pasteImage: () => {},
			showStatus: () => {},
			pasteNative: unexpectedNativePaste,
		});

		const dot = Buffer.from(".", "utf8").toString("base64");
		const imageMime = Buffer.from("image/png", "utf8").toString("base64");

		controller.handleInput(packet("type=read:status=OK"));
		controller.handleInput(
			packet(
				`type=read:status=DATA:mime=${dot}`,
				Buffer.from("text/plain image/png text/html\n", "utf8").toString("base64"),
			),
		);
		controller.handleInput(packet("type=read:status=DONE"));

		expect(writes.at(-1)).toBe(`${OSC}type=read;${imageMime}${BEL}`);
	});
});
