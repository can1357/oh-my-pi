import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import {
	resolveMarkdownLinkTargets,
	tryResolveInternalUrlSync,
} from "@oh-my-pi/pi-coding-agent/internal-urls/hyperlink-targets";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getMarkdownTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import * as terminalCaps from "@oh-my-pi/pi-tui";
import { isHyperlinkEnabled } from "@oh-my-pi/pi-tui/render/hyperlink";
import { isFeedModelBadgeEnabled, resolveImageOptions } from "@oh-my-pi/pi-tui/render/render-utils";

function extractAnyTerminatorLinkUri(text: string): string | undefined {
	return text.match(/\x1b\]8;[^;]*;([^\x1b\x07]+)(?:\x1b\\|\x07)/)?.[1];
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
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

describe("renderer settings propagation", () => {
	it("updates renderer preferences when runtime overrides are applied and cleared", async () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		resetSettingsForTest();
		try {
			Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
			await Settings.init({ inMemory: true });
			settings.set("tui.maxInlineImageColumns", 64);
			settings.set("tui.maxInlineImageRows", 7);
			settings.set("task.showResolvedModelBadge", true);
			settings.set("tui.hyperlinks", "always");
			expect(resolveImageOptions()).toEqual({ maxWidthCells: 64, maxHeightCells: 7 });
			expect(isFeedModelBadgeEnabled()).toBe(true);
			expect(isHyperlinkEnabled()).toBe(true);

			settings.override("tui.maxInlineImageColumns", 72);
			settings.override("tui.maxInlineImageRows", 0);
			settings.override("task.showResolvedModelBadge", false);
			settings.override("tui.hyperlinks", "off");
			expect(resolveImageOptions()).toEqual({ maxWidthCells: 72, maxHeightCells: 24 });
			expect(isFeedModelBadgeEnabled()).toBe(false);
			expect(isHyperlinkEnabled()).toBe(false);

			settings.clearOverride("tui.maxInlineImageColumns");
			settings.clearOverride("tui.maxInlineImageRows");
			settings.clearOverride("task.showResolvedModelBadge");
			settings.clearOverride("tui.hyperlinks");
			expect(resolveImageOptions()).toEqual({ maxWidthCells: 64, maxHeightCells: 7 });
			expect(isFeedModelBadgeEnabled()).toBe(true);
			expect(isHyperlinkEnabled()).toBe(true);
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
			resetSettingsForTest();
			await Settings.init({ inMemory: true });
		}
	});
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
		const artifactFile = path.join(tempDir, "42.read.log");
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
