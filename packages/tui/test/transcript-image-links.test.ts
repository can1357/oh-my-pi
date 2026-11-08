import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { linkedImageText, setImageBlobWriter, transcriptImageLink } from "@oh-my-pi/pi-tui/prompt/image-references";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TspSpan } from "@oh-my-pi/pi-wire";

// 1x1 PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const IMAGE = { data: PNG, mimeType: "image/png" };

let disposeWriter: (() => void) | undefined;
let writes = 0;

/** Install a blob writer that counts calls and resolves to a fixed path. */
function installWriter(write: () => string = () => path.resolve("blobs", "copy.png")): void {
	writes = 0;
	disposeWriter = setImageBlobWriter(() => {
		writes++;
		return { displayPath: write() };
	});
}

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	disposeWriter?.();
	disposeWriter = undefined;
	setNativeRendering(false);
	applyHyperlinkSetting("auto");
});

describe("transcript image links", () => {
	it("links an image read from disk to its source file without writing a blob", () => {
		applyHyperlinkSetting("always");
		installWriter();
		const source = path.resolve("shots", "a.png");
		expect(transcriptImageLink(IMAGE, source)).toBe(source);
		expect(writes).toBe(0);
	});

	it("links a sourceless image to one blob copy reused across renders", () => {
		applyHyperlinkSetting("always");
		installWriter();
		const first = linkedImageText("[Image]", IMAGE);
		const second = linkedImageText("[Image]", IMAGE);
		expect(first).toContain(url.pathToFileURL(path.resolve("blobs", "copy.png")).href);
		expect(second).toBe(first);
		expect(writes).toBe(1);
	});

	it("leaves the placeholder plain when no file can back it", () => {
		applyHyperlinkSetting("always");
		expect(linkedImageText("[Image]", IMAGE)).toBe("[Image]");
		installWriter(() => {
			throw new Error("disk full");
		});
		expect(linkedImageText("[Image]", IMAGE)).toBe("[Image]");
	});

	it("writes no blob and emits no link under an off policy, in text mode and natively", () => {
		applyHyperlinkSetting("off");
		installWriter();
		expect(linkedImageText("[Image]", IMAGE, path.resolve("a.png"))).toBe("[Image]");
		setNativeRendering(true);
		expect(transcriptImageLink(IMAGE)).toBeUndefined();
		expect(writes).toBe(0);
	});

	it("stops writing blobs once the registering host disposes its writer", () => {
		applyHyperlinkSetting("always");
		installWriter();
		disposeWriter?.();
		disposeWriter = undefined;
		expect(transcriptImageLink(IMAGE)).toBeUndefined();
		expect(writes).toBe(0);
	});
});

/** Every `md` mark in a described tree. */
function collectMarks(value: unknown, out: TspSpan[] = []): TspSpan[] {
	if (Array.isArray(value)) {
		for (const item of value) collectMarks(item, out);
	} else if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			if (key === "marks" && Array.isArray(child)) out.push(...child);
			else collectMarks(child, out);
		}
	}
	return out;
}

/** The first object in a described tree matching `match`. */
function findProps(
	value: unknown,
	match: (p: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findProps(item, match);
			if (found) return found;
		}
	} else if (value && typeof value === "object") {
		const record = Object.fromEntries(Object.entries(value));
		if (match(record)) return record;
		for (const child of Object.values(record)) {
			const found = findProps(child, match);
			if (found) return found;
		}
	}
	return undefined;
}

describe("native user message image chips", () => {
	it("links each #N chip to the Nth attachment's file", () => {
		const first = path.resolve("shots", "first.png");
		const second = path.resolve("shots", "second.png");
		const user = new UserMessageComponent("compare [Image #1, 1x1] with [Image #2, 1x1]", {
			images: [
				{ type: "image", ...IMAGE },
				{ type: "image", ...IMAGE },
			],
			imageLinks: [first, second],
		});
		const marks = collectMarks(user.describe());
		const hrefFor = (n: number) => marks.find(mark => mark.t.endsWith(`#${n}`))?.href;
		expect(hrefFor(1)).toBe(url.pathToFileURL(first).href);
		expect(hrefFor(2)).toBe(url.pathToFileURL(second).href);
	});

	it("opens thumbnails as file URLs and drops every link when the policy turns off", () => {
		setNativeRendering(true);
		const file = path.resolve("shots", "first.png");
		const user = new UserMessageComponent("see [Image #1, 1x1]", {
			images: [{ type: "image", ...IMAGE }],
			imageLinks: [file],
		});
		const thumbHref = (tree: unknown) => findProps(tree, p => p.title === "#1" && "blob" in p)?.href;
		expect(thumbHref(user.describe())).toBe(url.pathToFileURL(file).href);
		applyHyperlinkSetting("off");
		const described = user.describe();
		expect(thumbHref(described)).toBeUndefined();
		expect(collectMarks(described).some(mark => mark.href !== undefined)).toBe(false);
	});
});
