import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { logger } from "@oh-my-pi/pi-utils";
import { getMarkdownTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	applyFileLinkSetting,
	applyHyperlinkSetting,
	fileHyperlink,
	fileLinkSpan,
	fileUriForTerminal,
	isHyperlinkEnabled,
	tryFileUri,
	uriHyperlink,
	urlHyperlink,
	urlHyperlinkAlways,
} from "@oh-my-pi/pi-tui/render/hyperlink";
import * as terminalCaps from "@oh-my-pi/pi-tui";
import { SkillMessageComponent } from "../src/chat/skill-message";
import { openableImageProps } from "../src/native/blobs";
import { fileHref } from "../src/tools/native-view";

// OSC 8 sequence markers
const OSC = "\x1b]";
const ST = "\x1b\\";
const BEL = "\x07";
const LINK_END = `${OSC}8;;${ST}`;
const ORIGINAL_NO_COLOR = Bun.env.NO_COLOR;

/** Extract the hyperlink URI from a wrapped string. Returns undefined if not wrapped. */
function extractLinkUri(text: string): string | undefined {
	const match = text.match(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/);
	return match?.[1];
}

function extractAnyTerminatorLinkUri(text: string): string | undefined {
	return text.match(/\x1b\]8;[^;]*;([^\x1b\x07]+)(?:\x1b\\|\x07)/)?.[1];
}

/** Returns true if the string contains an OSC 8 hyperlink wrapping a given display text. */
function isHyperlinked(text: string): boolean {
	return text.includes(`${OSC}8;`) && text.includes(LINK_END);
}

/** Push the hyperlink policy as a host would when its preferences change. */
function setHyperlinkMode(mode: "off" | "auto" | "always"): void {
	applyHyperlinkSetting(mode);
}

beforeEach(() => applyFileLinkSetting({}));

afterEach(() => {
	applyFileLinkSetting({});
	vi.restoreAllMocks();
	applyHyperlinkSetting("auto");
	if (ORIGINAL_NO_COLOR === undefined) {
		delete Bun.env.NO_COLOR;
	} else {
		Bun.env.NO_COLOR = ORIGINAL_NO_COLOR;
	}
});

describe("isHyperlinkEnabled", () => {
	it('returns false when mode is "off"', () => {
		setHyperlinkMode("off");
		expect(isHyperlinkEnabled()).toBe(false);
	});

	it('returns true when mode is "always" regardless of TTY', () => {
		setHyperlinkMode("always");
		expect(isHyperlinkEnabled()).toBe(true);
	});

	it("returns false in auto mode when NO_COLOR is set", () => {
		setHyperlinkMode("auto");
		Bun.env.NO_COLOR = "1";
		expect(isHyperlinkEnabled()).toBe(false);
	});

	it("returns false in auto mode when stdout is not a TTY", () => {
		setHyperlinkMode("auto");
		const origTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		try {
			Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
			expect(isHyperlinkEnabled()).toBe(false);
		} finally {
			if (origTTY) {
				Object.defineProperty(process.stdout, "isTTY", origTTY);
			} else {
				Reflect.deleteProperty(process.stdout, "isTTY");
			}
		}
	});

	it("resolves auto against detected capability, immune to runtime flag mutation", () => {
		setHyperlinkMode("auto");
		delete Bun.env.NO_COLOR;
		const origTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		const origHyperlinks = terminalCaps.TERMINAL.hyperlinks;
		try {
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
			// Other test modules may have already changed the runtime flag since
			// hyperlink.ts captured detection. Neither runtime value may change auto.
			const detected = isHyperlinkEnabled();
			terminalCaps.setTerminalHyperlinks(false);
			expect(isHyperlinkEnabled()).toBe(detected);
			terminalCaps.setTerminalHyperlinks(true);
			expect(isHyperlinkEnabled()).toBe(detected);
		} finally {
			terminalCaps.setTerminalHyperlinks(origHyperlinks);
			if (origTTY) {
				Object.defineProperty(process.stdout, "isTTY", origTTY);
			} else {
				Reflect.deleteProperty(process.stdout, "isTTY");
			}
		}
	});
});

describe("fileHyperlink", () => {
	it("returns plain text when hyperlinks are disabled (mode=off)", () => {
		setHyperlinkMode("off");
		const filePath = path.resolve("/Users/foo/bar.ts");
		const result = fileHyperlink(filePath, "bar.ts");
		expect(result).toBe("bar.ts");
	});

	it("wraps text in OSC 8 when hyperlinks are enabled (mode=always)", () => {
		setHyperlinkMode("always");
		const filePath = path.resolve("/Users/foo/bar.ts");
		const result = fileHyperlink(filePath, "bar.ts");
		expect(isHyperlinked(result)).toBe(true);
		expect(result).toContain("bar.ts");
	});

	it("percent-encodes URL-reserved path bytes without appending a query", () => {
		setHyperlinkMode("always");
		const filePath = path.resolve("/Users/foo/a#b?c% d.ts");
		const result = fileHyperlink(filePath, "a#b?c% d.ts", { line: 12 });
		const uri = extractLinkUri(result);
		// The location must not ride in the URI: `Paths.get(URI)` rejects a file
		// URI with a query or a fragment, which is what broke JVM language
		// servers and opened blank editor tabs (#12109).
		expect(uri).toBe(url.pathToFileURL(path.resolve(filePath)).href);
		expect(uri).not.toContain("?");
		expect(uri).not.toContain("#");
	});

	it("resolves relative paths before building file URIs", () => {
		setHyperlinkMode("always");
		const result = fileHyperlink("relative file#1.ts", "relative file#1.ts");
		const uri = extractLinkUri(result);
		expect(uri).toBeDefined();
		expect(decodeURIComponent(new URL(uri!).pathname)).toEndWith("/relative file#1.ts");
	});

	it("keeps the location out of the URI when line and col are provided", () => {
		setHyperlinkMode("always");
		const filePath = path.resolve("/Users/foo/bar.ts");
		const result = fileHyperlink(filePath, "bar.ts", { line: 42, col: 7 });
		const uri = extractLinkUri(result);
		expect(uri).toBe(url.pathToFileURL(filePath).href);
		expect(uri).not.toContain("line");
		expect(uri).not.toContain("col");
	});

	it("uses the vscode://file form on the VS Code family, with the location after the path", () => {
		const filePath = path.resolve("/Users/foo/bar.ts");
		// vscode://file takes the forward-slash path: `/Users/foo/bar.ts`, or `/C:/Users/foo/bar.ts` on Windows.
		const vscodePath = url.pathToFileURL(filePath).pathname;
		expect(fileUriForTerminal(filePath, { line: 42, col: 7 }, "vscode")).toBe(`vscode://file${vscodePath}:42:7`);
		expect(fileUriForTerminal(filePath, { line: 42 }, "vscode")).toBe(`vscode://file${vscodePath}:42`);
		// Without a line there is nothing to navigate to, so the bare path stands.
		expect(fileUriForTerminal(filePath, undefined, "vscode")).toBe(`vscode://file${vscodePath}`);
	});

	it("encodes reserved path bytes in vscode://file targets without hiding the location", () => {
		const uri = fileUriForTerminal("/Users/foo/a#b?c% d.ts", { line: 42, col: 7 }, "vscode");
		expect(uri).toBe("vscode://file/Users/foo/a%23b%3Fc%25%20d.ts:42:7");
		// The vscode:// branch never builds a `file:` URL, so it always has a target.
		expect(new URL(uri!).search).toBe("");
		expect(new URL(uri!).hash).toBe("");
		expect(fileUriForTerminal("C:\\Users\\foo bar\\a.ts", { line: 4 }, "vscode")).toBe(
			"vscode://file/C:/Users/foo%20bar/a.ts:4",
		);
	});

	it("keeps a plain file URI on terminals that are not the VS Code family", () => {
		const filePath = path.resolve("/Users/foo/bar.ts");
		for (const terminalId of ["iterm2", "kitty", "base"] as const) {
			expect(fileUriForTerminal(filePath, { line: 42, col: 7 }, terminalId)).toBe(url.pathToFileURL(filePath).href);
		}
	});

	it("keeps a path with a lone surrogate link-free on the VS Code family", () => {
		setHyperlinkMode("always");
		// encodeURIComponent throws URIError on a lone surrogate, which a
		// model-authored path can carry; the row must keep its text.
		const filePath = "/tmp/\uD800";
		expect(fileUriForTerminal(filePath, { line: 3 }, "vscode")).toBeUndefined();
		expect(() => fileHyperlink(filePath, "odd.ts")).not.toThrow();
	});

	it.skipIf(process.platform !== "win32")(
		"renders a path Node cannot encode as plain text instead of throwing",
		() => {
			setHyperlinkMode("always");
			// A UNC path escaped twice by its author, as a resumed session can still
			// hold it: Node rejects it with ERR_INVALID_ARG_VALUE ("Empty UNC servername").
			const malformed = String.raw`\\\wsl.localhost\Ubuntu-24.04\opt\build-armv7\crypto\evp.h`;
			expect(fileUriForTerminal(malformed, undefined, "kitty")).toBeUndefined();
			expect(fileHyperlink(malformed, "evp.h")).toBe("evp.h");
			expect(fileLinkSpan(malformed, "evp.h")).toEqual({ t: "evp.h", s: "path" });
			// Native heads and image props share the same converter.
			expect(fileHref(malformed)).toBeUndefined();
			expect(openableImageProps(malformed)).toEqual({});
		},
	);

	it("defaults host to os.hostname() when only PI_LINK_SCHEME is set", () => {
		applyFileLinkSetting({ scheme: "ompfile" });
		const filePath = path.resolve("/Users/foo/bar.ts");
		const expectedPathname = url.pathToFileURL(filePath).pathname;
		expect(fileUriForTerminal(filePath, undefined, "kitty")).toBe(`ompfile://${os.hostname()}${expectedPathname}`);
	});

	it("overrides vscode terminal target when PI_LINK_SCHEME is set", () => {
		applyFileLinkSetting({ scheme: "ompfile", host: "beelink" });
		const filePath = path.resolve("/Users/foo/bar.ts");
		const expectedPathname = url.pathToFileURL(filePath).pathname;
		expect(fileUriForTerminal(filePath, { line: 10 }, "vscode")).toBe(`ompfile://beelink${expectedPathname}?line=10`);
	});

	it("leaves URIs unchanged when only PI_LINK_HOST is set without PI_LINK_SCHEME", () => {
		applyFileLinkSetting({ host: "remote-server" });
		const filePath = path.resolve("/Users/foo/bar.ts");
		expect(fileUriForTerminal(filePath, undefined, "base")).toBe(url.pathToFileURL(filePath).href);
	});

	it("leaves file and vscode URIs unchanged when PI_LINK_SCHEME and PI_LINK_HOST are unset", () => {
		applyFileLinkSetting({});
		const filePath = path.resolve("/Users/foo/bar.ts");
		const expectedFileUri = url.pathToFileURL(filePath).href;
		expect(fileUriForTerminal(filePath, undefined, "kitty")).toBe(expectedFileUri);
		const vscodePath = url.pathToFileURL(filePath).pathname;
		expect(fileUriForTerminal(filePath, { line: 10 }, "vscode")).toBe(`vscode://file${vscodePath}:10`);
	});

	it("wraps custom scheme and host URI in OSC 8 via fileHyperlink", () => {
		setHyperlinkMode("always");
		applyFileLinkSetting({ scheme: "ompfile", host: "mybox" });
		const filePath = path.resolve("/Users/foo/bar.ts");
		const result = fileHyperlink(filePath, "bar.ts");
		const uri = extractLinkUri(result);
		const expectedPathname = url.pathToFileURL(filePath).pathname;
		expect(uri).toBe(`ompfile://mybox${expectedPathname}`);
		expect(result).toContain("bar.ts");
		expect(isHyperlinked(result)).toBe(true);
	});

	it("preserves custom-handler positions separately from reserved filename bytes", () => {
		applyFileLinkSetting({ scheme: "ompfile", host: "beelink" });
		setHyperlinkMode("always");
		const filePath = path.resolve("/tmp/a#b?c% 中文.ts");
		const uri = extractLinkUri(fileHyperlink(filePath, "a.ts", { line: 42, col: 7 }));
		const parsed = new URL(uri!);
		expect(parsed.pathname).toBe(url.pathToFileURL(filePath).pathname);
		expect(parsed.searchParams.get("line")).toBe("42");
		expect(parsed.searchParams.get("col")).toBe("7");
		expect(parsed.hash).toBe("");
		expect(tryFileUri(filePath, { col: 3 })).toEndWith("?col=3");
	});

	it("routes native file links to the remote handler while image open actions stay local", () => {
		applyFileLinkSetting({ scheme: "ompfile", host: "beelink" });
		const filePath = path.resolve("/tmp/remote project/a.ts");
		const href = `ompfile://beelink${url.pathToFileURL(filePath).pathname}`;
		expect(fileLinkSpan(filePath, "a.ts")).toEqual({ t: "a.ts", s: "path", href });
		expect(fileHref(filePath)).toBe(href);
		expect(openableImageProps(filePath)).toEqual({
			href: url.pathToFileURL(filePath).href,
			actions: { menu: ["open"] },
		});
	});

	it("routes a native skill card to the remote SKILL.md", async () => {
		await initTheme();
		applyFileLinkSetting({ scheme: "ompfile", host: "beelink" });
		const filePath = path.resolve("/tmp/remote skill/SKILL.md");
		const component = new SkillMessageComponent({
			role: "custom",
			customType: "skill-prompt",
			content: "Loaded instructions",
			display: true,
			attribution: "user",
			timestamp: 1,
			details: { name: "example", path: filePath, lineCount: 1, prompt: "/skill:example Run checks" },
		});
		const described = component.describe();
		if (described.k !== "card") throw new Error("Skill link must be in the card header");
		expect(described.p?.head).toContainEqual(
			expect.objectContaining({ href: `ompfile://beelink${url.pathToFileURL(filePath).pathname}` }),
		);
	});

	it("renders rejected paths as plain text under a custom handler", () => {
		applyFileLinkSetting({ scheme: "ompfile", host: "beelink" });
		setHyperlinkMode("always");
		const malformed = String.raw`\\\wsl.localhost\x\a.ts`;
		// Exercise Node's Windows parsing on every platform, including the real
		// malformed-UNC failure that a resumed session can contain.
		const pathToFileURL = url.pathToFileURL;
		spyOn(url, "pathToFileURL").mockImplementation(filePath => pathToFileURL(filePath, { windows: true }));
		expect(tryFileUri(malformed)).toBeUndefined();
		expect(fileUriForTerminal(malformed, undefined, "vscode")).toBeUndefined();
		expect(fileHyperlink(malformed, "a.ts")).toBe("a.ts");
		expect(fileLinkSpan(malformed, "a.ts")).toEqual({ t: "a.ts", s: "path" });
		expect(fileHref(malformed)).toBeUndefined();
		expect(openableImageProps(malformed)).toEqual({});
	});

	it("keeps a Windows UNC server in the custom target on every platform", () => {
		applyFileLinkSetting({ scheme: "ompfile", host: "beelink" });
		const pathToFileURL = url.pathToFileURL;
		spyOn(url, "pathToFileURL").mockImplementation(filePath => pathToFileURL(filePath, { windows: true }));
		expect(tryFileUri("\\\\nas\\share\\a#b% 中文.ts")).toBe(
			"ompfile://beelink//nas/share/a%23b%25%20%E4%B8%AD%E6%96%87.ts",
		);
	});

	it("warns and restores ordinary links when the scheme includes a protocol separator", () => {
		applyFileLinkSetting({ scheme: "ompfile", host: "beelink" });
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		applyFileLinkSetting({ scheme: "ompfile://", host: "beelink" });
		const filePath = path.resolve("/tmp/a.ts");
		expect(fileUriForTerminal(filePath, undefined, "kitty")).toBe(url.pathToFileURL(filePath).href);
		expect(warning).toHaveBeenCalledTimes(1);
	});

	it("warns and restores ordinary links when the host would reshape the URI", () => {
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		const filePath = path.resolve("/tmp/a.ts");
		for (const host of ["my box", "box/evil", "user@box", "box?x"]) {
			applyFileLinkSetting({ scheme: "ompfile", host });
			expect(tryFileUri(filePath)).toBe(url.pathToFileURL(filePath).href);
		}
		expect(warning).toHaveBeenCalledTimes(4);
		applyFileLinkSetting({ scheme: "ompfile", host: "beelink.lan:2222" });
		expect(tryFileUri(filePath)).toBe(`ompfile://beelink.lan:2222${url.pathToFileURL(filePath).pathname}`);
	});

	it("accepts extended scheme characters case-insensitively", () => {
		applyFileLinkSetting({ scheme: "OMP+File.v2-remote", host: "beelink" });
		const filePath = path.resolve("/tmp/a.ts");
		expect(tryFileUri(filePath)).toBe(`omp+file.v2-remote://beelink${url.pathToFileURL(filePath).pathname}`);
	});

	it("produces a stable id for the same path", () => {
		setHyperlinkMode("always");
		const filePath = path.resolve("/Users/foo/bar.ts");
		const r1 = fileHyperlink(filePath, "bar.ts");
		const r2 = fileHyperlink(filePath, "different display text");
		// Extract id= from params (between "id=" and next ";")
		const id1 = r1.match(/id=([^;]+)/)?.[1];
		const id2 = r2.match(/id=([^;]+)/)?.[1];
		expect(id1).toBeDefined();
		expect(id1).toBe(id2);
	});

	it("does not double-wrap text that already contains an OSC 8 sequence", () => {
		setHyperlinkMode("always");
		const alreadyWrappedUri = url.pathToFileURL(path.resolve("/foo/bar.ts")).href;
		const alreadyWrapped = `${OSC}8;id=abc123;${alreadyWrappedUri}${ST}bar.ts${LINK_END}`;
		const result = fileHyperlink(path.resolve("/Users/foo/other.ts"), alreadyWrapped);
		// Should return the already-wrapped text unchanged
		expect(result).toBe(alreadyWrapped);
	});

	it("preserves ANSI color codes inside the hyperlink", () => {
		setHyperlinkMode("always");
		const colored = "\x1b[32mbar.ts\x1b[0m";
		const filePath = path.resolve("/Users/foo/bar.ts");
		const result = fileHyperlink(filePath, colored);
		expect(result).toContain(colored);
		expect(isHyperlinked(result)).toBe(true);
	});
});

describe("uriHyperlink", () => {
	it("wraps arbitrary URI targets when hyperlinks are enabled", () => {
		setHyperlinkMode("always");
		const result = uriHyperlink("local://handoff.md", "handoff");
		expect(isHyperlinked(result)).toBe(true);
		expect(extractLinkUri(result)).toBe("local://handoff.md");
	});

	it("leaves text plain for URI targets containing control bytes", () => {
		setHyperlinkMode("always");
		expect(uriHyperlink("https://example.com/\x07bad", "bad")).toBe("bad");
	});
});

describe("urlHyperlink", () => {
	it("wraps HTTP URLs and normalizes www hosts", () => {
		setHyperlinkMode("always");
		const result = urlHyperlink("www.example.com/path", "example");
		expect(isHyperlinked(result)).toBe(true);
		expect(extractLinkUri(result)).toBe("https://www.example.com/path");
	});

	it("does not wrap non-HTTP URL schemes", () => {
		setHyperlinkMode("always");
		expect(urlHyperlink("ftp://example.com/file", "file")).toBe("file");
	});
});

describe("urlHyperlinkAlways", () => {
	it("wraps HTTP URLs in auto mode even when capability detection would suppress", () => {
		setHyperlinkMode("auto");
		Bun.env.NO_COLOR = "1"; // forces isHyperlinkEnabled() to false in auto mode
		const result = urlHyperlinkAlways("www.example.com/path", "example");

		expect(isHyperlinkEnabled()).toBe(false);
		expect(result).toContain(`${OSC}8;`);
		expect(result).toContain(`${OSC}8;;${BEL}`);
		expect(extractAnyTerminatorLinkUri(result)).toBe("https://www.example.com/path");
	});

	it("returns plain text when the user opts out with tui.hyperlinks=off", () => {
		setHyperlinkMode("off");
		expect(urlHyperlinkAlways("https://example.com/path", "example")).toBe("example");
	});

	it("does not wrap non-HTTP URL schemes", () => {
		setHyperlinkMode("always");
		expect(urlHyperlinkAlways("ftp://example.com/file", "file")).toBe("file");
	});
});

describe("chat markdown links honor tui.hyperlinks", () => {
	// The Markdown renderer gates OSC 8 on TERMINAL.hyperlinks. The coding-agent
	// applies its setting to that shared flag so chat links track path/resource
	// links (issue #10195).
	const originalHyperlinks = terminalCaps.TERMINAL.hyperlinks;

	beforeAll(async () => {
		await initTheme();
	});
	afterEach(() => {
		terminalCaps.TERMINAL.hyperlinks = originalHyperlinks;
	});

	function renderChatLink(): string {
		applyHyperlinkSetting();
		const md = new terminalCaps.Markdown(
			"See [the docs](https://example.com/path) for details.",
			0,
			0,
			getMarkdownTheme(),
		);
		return md.render(80).join("\n");
	}

	it('wraps the link in OSC 8 under "always" even when the terminal did not advertise support', () => {
		terminalCaps.TERMINAL.hyperlinks = false;
		setHyperlinkMode("always");
		const output = renderChatLink();
		// The Markdown renderer terminates OSC 8 with BEL, so match either terminator.
		expect(output.includes(`${OSC}8;`)).toBe(true);
		expect(extractAnyTerminatorLinkUri(output)).toBe("https://example.com/path");
	});

	it('suppresses the OSC 8 wrap under "off" even when the terminal advertised support', () => {
		terminalCaps.TERMINAL.hyperlinks = true;
		setHyperlinkMode("off");
		const output = renderChatLink();
		expect(output).toContain("the docs");
		expect(output.includes(`${OSC}8;`)).toBe(false);
	});
});
