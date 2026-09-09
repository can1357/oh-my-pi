import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { getMarkdownTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	applyHyperlinkSetting,
	fileHyperlink,
	isHyperlinkEnabled,
	resolveMarkdownLinkTargets,
	tryResolveInternalUrlSync,
	uriHyperlink,
	urlHyperlink,
	urlHyperlinkAlways,
} from "@oh-my-pi/pi-coding-agent/tui/hyperlink";
import * as terminalCaps from "@oh-my-pi/pi-tui";

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

/** Set the `tui.hyperlinks` mode via a non-persistent runtime override. */
function setHyperlinkMode(mode: "off" | "auto" | "always"): void {
	settings.override("tui.hyperlinks", mode);
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
	if (ORIGINAL_NO_COLOR === undefined) {
		delete Bun.env.NO_COLOR;
	} else {
		Bun.env.NO_COLOR = ORIGINAL_NO_COLOR;
	}
});

describe("isHyperlinkEnabled", () => {
	it("falls back to plain text before Settings.init", async () => {
		resetSettingsForTest();
		try {
			expect(isHyperlinkEnabled()).toBe(false);
			expect(fileHyperlink(path.resolve("/Users/foo/bar.ts"), "bar.ts")).toBe("bar.ts");
			expect(urlHyperlinkAlways("https://example.com/path", "example")).toBe("example");
		} finally {
			await Settings.init({ inMemory: true });
		}
	});

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

	it("builds a valid file:// URI with the absolute path", () => {
		setHyperlinkMode("always");
		const filePath = path.resolve("/Users/foo/bar.ts");
		const result = fileHyperlink(filePath, "bar.ts");
		const uri = extractLinkUri(result);
		expect(uri).toMatch(/^file:\/\//);
		expect(uri).toContain("bar.ts");
	});

	it("encodes spaces in the path", () => {
		setHyperlinkMode("always");
		const filePath = path.resolve("/Users/foo/my file.ts");
		const result = fileHyperlink(filePath, "my file.ts");
		const uri = extractLinkUri(result);
		expect(uri).toContain("%20");
		expect(uri).not.toContain(" ");
	});

	it("percent-encodes URL-reserved path bytes before appending query params", () => {
		setHyperlinkMode("always");
		const filePath = path.resolve("/Users/foo/a#b?c% d.ts");
		const result = fileHyperlink(filePath, "a#b?c% d.ts", { line: 12 });
		const uri = extractLinkUri(result);
		const expectedUri = new URL(url.pathToFileURL(path.resolve(filePath)).href);
		expectedUri.searchParams.set("line", "12");
		expect(uri).toBe(expectedUri.href);
	});

	it("resolves relative paths before building file URIs", () => {
		setHyperlinkMode("always");
		const result = fileHyperlink("relative file#1.ts", "relative file#1.ts");
		const uri = extractLinkUri(result);
		expect(uri).toBeDefined();
		expect(decodeURIComponent(new URL(uri!).pathname)).toEndWith("/relative file#1.ts");
	});

	it("appends line and col as query params when provided", () => {
		setHyperlinkMode("always");
		const filePath = path.resolve("/Users/foo/bar.ts");
		const result = fileHyperlink(filePath, "bar.ts", { line: 42, col: 7 });
		const uri = extractLinkUri(result);
		expect(uri).toContain("line=42");
		expect(uri).toContain("col=7");
	});

	it("omits query params when line/col are not provided", () => {
		setHyperlinkMode("always");
		const filePath = path.resolve("/Users/foo/bar.ts");
		const result = fileHyperlink(filePath, "bar.ts");
		const uri = extractLinkUri(result);
		expect(uri).not.toContain("?");
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

describe("tryResolveInternalUrlSync", () => {
	// The "no session options" contract below asserts on process-global state
	// (AgentRegistry main session, LocalProtocolHandler override) that sibling
	// test files in the same worker may have populated. Pin the premise
	// explicitly so the test is full-suite safe, not just file-local safe.
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
	});

	it("returns undefined for non-internal URLs", () => {
		expect(tryResolveInternalUrlSync("/abs/path/file.ts")).toBeUndefined();
		expect(tryResolveInternalUrlSync("relative/path.ts")).toBeUndefined();
		expect(tryResolveInternalUrlSync("https://example.com/foo")).toBeUndefined();
	});

	it("returns undefined for unsupported internal URL schemes", () => {
		// Async-resolved schemes are intentionally not handled here.
		expect(tryResolveInternalUrlSync("artifact://123")).toBeUndefined();
		expect(tryResolveInternalUrlSync("agent://abc")).toBeUndefined();
		expect(tryResolveInternalUrlSync("skill://foo")).toBeUndefined();
		expect(tryResolveInternalUrlSync("omp://docs.md")).toBeUndefined();
	});

	it("returns undefined when local:// resolution has no session options", () => {
		// No AgentRegistry main session in this unit test, no override installed.
		expect(tryResolveInternalUrlSync("local://foo.md")).toBeUndefined();
	});

	it("swallows errors from malformed URLs", () => {
		// Malformed input should not throw, just return undefined.
		expect(tryResolveInternalUrlSync("local://%ZZ")).toBeUndefined();
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

	it("applies the configured policy while Settings.init publishes the singleton", async () => {
		resetSettingsForTest();
		terminalCaps.setTerminalHyperlinks(false);
		try {
			await Settings.init({ inMemory: true, overrides: { "tui.hyperlinks": "always" } });
			const output = new terminalCaps.Markdown(
				"See [the docs](https://example.com/path) for details.",
				0,
				0,
				getMarkdownTheme(),
			)
				.render(80)
				.join("\n");
			expect(terminalCaps.TERMINAL.hyperlinks).toBe(true);
			expect(extractAnyTerminatorLinkUri(output)).toBe("https://example.com/path");
		} finally {
			resetSettingsForTest();
			await Settings.init({ inMemory: true });
		}
	});

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

describe("resource links in chat markdown", () => {
	let tempDir: string;
	let originalHyperlinks: boolean;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-markdown-links-"));
		originalHyperlinks = terminalCaps.TERMINAL.hyperlinks;
		terminalCaps.setTerminalHyperlinks(true);
		await initTheme();
	});

	afterEach(async () => {
		terminalCaps.setTerminalHyperlinks(originalHyperlinks);
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("expands labeled, reference, and table links to real local and artifact files", async () => {
		const localFile = path.join(tempDir, "local", "reviewed findings#.json");
		const artifactFile = path.join(tempDir, "42.txt");
		await Bun.write(localFile, '{"reviewed":true}');
		await Bun.write(artifactFile, "artifact output");
		const href = "local://reviewed%20findings%23.json";
		const text = [
			`[Reviewed findings](${href})`,
			"",
			"| Report |",
			"| --- |",
			"| [Artifact][output] |",
			"",
			"[output]: artifact://42",
		].join("\n");
		const targets = await resolveMarkdownLinkTargets([text], {
			localProtocolOptions: { getArtifactsDir: () => tempDir },
		});
		const localUri = url.pathToFileURL(await fs.realpath(localFile)).href;
		const artifactUri = url.pathToFileURL(artifactFile).href;
		const markdown = new terminalCaps.Markdown(text, 0, 0, {
			...getMarkdownTheme(),
			resolveLink: href => targets.get(href),
		});
		const output = markdown.render(300).join("\n");
		expect(extractAnyTerminatorLinkUri(output)).toBe(localUri);
		expect(output).toContain(`\x1b]8;;${artifactUri}\x07`);
		const visible = stripVTControlCharacters(output);
		expect(visible).toContain(`Reviewed findings (${href})`);
		expect(visible).toContain("Artifact (artifact://42)");
		expect(visible).not.toContain("file://");
	});

	it("links ordinary paths against the session cwd while preserving displayed paths and source anchors", async () => {
		const file = path.join(tempDir, "src", "my file.ts");
		await Bun.write(file, "export const value = 1;");
		const relative = "src/my%20file.ts#L7";
		const absolute = file.replaceAll("\\", "/").replaceAll(" ", "%20");
		const text = `[Source](${relative}) and [Absolute](${absolute}) and [Missing](src/missing.ts) and [Heading](#heading)`;
		const targets = await resolveMarkdownLinkTargets([text], { cwd: tempDir });
		const fileUri = url.pathToFileURL(file).href;
		const output = new terminalCaps.Markdown(text, 0, 0, {
			...getMarkdownTheme(),
			resolveLink: href => targets.get(href),
		})
			.render(300)
			.join("\n");
		expect(extractAnyTerminatorLinkUri(output)).toBe(`${fileUri}#L7`);
		expect(output).toContain(`\x1b]8;;${fileUri}\x07`);
		expect(output).toContain("\x1b]8;;src/missing.ts\x07");
		expect(output).toContain("\x1b]8;;#heading\x07");
		const visible = stripVTControlCharacters(output);
		expect(visible).toContain(`Source (${relative})`);
		expect(visible).toContain(`Absolute (${absolute})`);
		expect(visible).not.toContain("file://");
	});

	it("leaves missing, escaping, remote, and non-link destinations unexpanded", async () => {
		await Bun.write(path.join(tempDir, "local", "report.json"), "{}");
		await Bun.write(path.join(tempDir, "outside.json"), "{}");
		await fs.symlink(path.join(tempDir, "outside.json"), path.join(tempDir, "local", "escape.json"));
		const text = [
			"`[code](local://report.json)`",
			"![image](local://report.json)",
			"```md",
			"[fenced](local://report.json)",
			"```",
			"[missing](local://missing.json)",
			"[escape](local://escape.json)",
			"[remote](mcp://server/resource)",
			"[web](https://example.com/report)",
		].join("\n\n");
		const targets = await resolveMarkdownLinkTargets([text], {
			localProtocolOptions: { getArtifactsDir: () => tempDir },
		});
		expect([...targets]).toEqual([]);
		const output = new terminalCaps.Markdown(text, 0, 0, {
			...getMarkdownTheme(),
			resolveLink: href => targets.get(href),
		})
			.render(200)
			.join("\n");
		expect(output).toContain("\x1b]8;;local://missing.json\x07");
		expect(output).toContain("\x1b]8;;https://example.com/report\x07");
	});

	it("pins identical local links to their calling sessions", async () => {
		const text = "[Report](local://report.json)";
		const outputs: string[] = [];
		for (const session of ["a", "b"]) {
			const artifactsDir = path.join(tempDir, session);
			const file = path.join(artifactsDir, "local", "report.json");
			await Bun.write(file, session);
			const targets = await resolveMarkdownLinkTargets([text], {
				localProtocolOptions: { getArtifactsDir: () => artifactsDir },
			});
			const output = new terminalCaps.Markdown(text, 0, 0, {
				...getMarkdownTheme(),
				resolveLink: href => targets.get(href),
			})
				.render(300)
				.join("\n");
			expect(extractAnyTerminatorLinkUri(output)).toBe(url.pathToFileURL(await fs.realpath(file)).href);
			outputs.push(output);
		}
		expect(outputs[0]).not.toBe(outputs[1]);
	});
});

describe("applyHyperlinkSetting on project-scoped reload", () => {
	// A cross-project reload (`/move`, resume, rollback) fires SETTING_HOOKS via
	// Settings.reloadForCwd → the tui.hyperlinks hook reapplies the policy, so
	// renderers gating on TERMINAL.hyperlinks never keep the previous project's
	// value while path links already track the new one (#10196 review).
	it("reapplies the effective policy so the runtime flag tracks the reloaded setting", async () => {
		const origHyperlinks = terminalCaps.TERMINAL.hyperlinks;
		const dirA = path.join(os.tmpdir(), "omp-hyperlink-reload-a");
		const dirB = path.join(os.tmpdir(), "omp-hyperlink-reload-b");
		try {
			terminalCaps.setTerminalHyperlinks(false);
			settings.override("tui.hyperlinks", "always");
			await settings.reloadForCwd(dirA);
			expect(terminalCaps.TERMINAL.hyperlinks).toBe(true);

			settings.override("tui.hyperlinks", "off");
			await settings.reloadForCwd(dirB);
			expect(terminalCaps.TERMINAL.hyperlinks).toBe(false);
		} finally {
			settings.clearOverride("tui.hyperlinks");
			terminalCaps.setTerminalHyperlinks(origHyperlinks);
		}
	});
});
