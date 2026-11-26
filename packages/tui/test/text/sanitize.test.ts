import { describe, expect, it } from "bun:test";
import {
	hasHyperlink,
	hyperlink,
	hyperlinkTarget,
	stripHyperlinks,
	textSized,
	textSizedRows,
} from "@oh-my-pi/pi-tui/text/osc";
import {
	displayLines,
	flattenLine,
	normalizeLineEndings,
	shortenHome,
	shortenHomeIn,
	singleLine,
	stripControl,
} from "@oh-my-pi/pi-tui/text/sanitize";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";

describe("control characters", () => {
	it("drops controls and escapes, keeping tabs and line feeds", () => {
		expect(stripControl("a\x00b\x07c\x1b[31md\x1b[0m\te\nf\x7f\x9b")).toBe("abcd\te\nf");
	});

	it("keeps complete escapes on request", () => {
		expect(stripControl("\x1b[31ma\x08b\x1b[0m\x01", true)).toBe("\x1b[31mab\x1b[0m");
		expect(stripControl("a\x01b", true)).toBe("ab");
	});
});

describe("line handling", () => {
	it("splits raw output into display lines", () => {
		expect(displayLines("one\r\ntwo\nprogress 10%\rprogress 100%\n\tindented\x1b[1m!")).toEqual([
			"one",
			"two",
			"progress 100%",
			"   indented!",
		]);
	});

	it("normalizes line endings", () => {
		expect(normalizeLineEndings("a\r\nb\r\rc")).toBe("a\nb c");
		expect(normalizeLineEndings("plain")).toBe("plain");
	});

	it("confines text to one row", () => {
		expect(singleLine("a\tb\r\nc\nd")).toBe("a   b c d");
		expect(flattenLine("  a \t b\n\n c  ")).toBe("a b c");
	});
});

describe("home paths", () => {
	it("shortens a leading home directory", () => {
		expect(shortenHome("/home/me/src/a.ts", "/home/me")).toBe("~/src/a.ts");
		expect(shortenHome("/home/me", "/home/me/")).toBe("~");
		expect(shortenHome("/home/meadow/a", "/home/me")).toBe("/home/meadow/a");
		expect(shortenHome("/etc/hosts", "/home/me")).toBe("/etc/hosts");
		expect(shortenHome("C:\\Users\\Me\\src\\a.ts", "c:\\users\\me")).toBe("~/src/a.ts");
	});

	it("shortens embedded home paths but leaves URLs and longer names alone", () => {
		const home = "/home/me";
		expect(shortenHomeIn("cd /home/me/repo && ls /home/me", home)).toBe("cd ~/repo && ls ~");
		expect(shortenHomeIn("open '/home/me/a b' (/home/me/x)", home)).toBe("open '~/a b' (~/x)");
		expect(shortenHomeIn("see file:///home/me/x and /home/meadow", home)).toBe(
			"see file:///home/me/x and /home/meadow",
		);
		expect(shortenHomeIn("**/home/me/notes.md**", home)).toBe("**~/notes.md**");
		expect(shortenHomeIn("at C:\\Users\\Me\\proj\\a.ts.", "C:\\Users\\Me")).toBe("at ~/proj/a.ts.");
	});
});

describe("OSC 8 hyperlinks", () => {
	it("wraps text in an ST-terminated link that is zero-width", () => {
		const link = hyperlink("docs", "https://example.com/d");
		expect(link).toBe("\x1b]8;;https://example.com/d\x1b\\docs\x1b]8;;\x1b\\");
		expect(visibleWidth(link)).toBe(4);
		expect(hasHyperlink(link)).toBe(true);
		expect(hyperlinkTarget(link)).toBe("https://example.com/d");
		expect(stripHyperlinks(`a ${link} b`)).toBe("a docs b");
	});

	it("carries an id and keeps styled text inside", () => {
		const link = hyperlink("\x1b[32mx\x1b[0m", "file:///a", "f1");
		expect(link).toBe("\x1b]8;id=f1;file:///a\x1b\\\x1b[32mx\x1b[0m\x1b]8;;\x1b\\");
	});

	it("refuses control bytes and never double-wraps", () => {
		expect(hyperlink("bad", "https://example.com/\x07bad")).toBe("bad");
		const once = hyperlink("x", "https://a");
		expect(hyperlink(once, "https://b")).toBe(once);
	});
});

describe("OSC 66 sized text", () => {
	it("encodes metadata with ST and sanitizes the payload", () => {
		const encoded = textSized("Hi", { scale: 2, widthCells: 3, verticalAlign: "center", horizontalAlign: "right" });
		expect(encoded).toBe("\x1b]66;s=2:w=3:v=2:h=1;Hi\x1b\\");
		expect(visibleWidth(encoded)).toBe(6);
		expect(textSized("A\nB", { scale: 1 })).toBe("\x1b]66;s=1;A B\x1b\\");
		expect(visibleWidth(textSized("👨‍👩‍👧‍👦", { scale: 2, widthCells: 2 }))).toBe(4);
	});

	it("reports how many rows a sized row occupies", () => {
		expect(textSizedRows("plain")).toBe(1);
		expect(textSizedRows(`a${textSized("b", { scale: 2 })}${textSized("c", { scale: 3 })}`)).toBe(3);
	});
});
