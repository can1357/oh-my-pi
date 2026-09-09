import { describe, expect, it } from "bun:test";
import { EnhancedPasteController } from "@oh-my-pi/pi-coding-agent/utils/enhanced-paste";

const ST = "\x1b\\";
const BEL = "\x07";
const OSC = "\x1b]5522;";

function packet(metadata: string, payload?: string): string {
	return `${OSC}${metadata}${payload === undefined ? "" : `;${payload}`}${ST}`;
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

	it("reports unsupported paste events instead of leaking OSC packets to the editor", () => {
		const statuses: string[] = [];
		const controller = new EnhancedPasteController({
			write: () => {},
			pasteText: () => {},
			pasteImage: () => {},
			showStatus: message => statuses.push(message),
		});

		const htmlMime = Buffer.from("text/html", "utf8").toString("base64");
		expect(controller.handleInput(packet("type=read:status=OK"))).toBe(true);
		expect(controller.handleInput(packet(`type=read:status=DATA:mime=${htmlMime}`))).toBe(true);
		expect(controller.handleInput(packet("type=read:status=DONE"))).toBe(true);

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
