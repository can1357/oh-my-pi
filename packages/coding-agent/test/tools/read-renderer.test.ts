import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { theme as activeTheme, getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { readToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/read";
import type { TUI } from "@oh-my-pi/pi-tui";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

function extractLinkTexts(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;[^\x1b]+\x1b\\([\s\S]*?)\x1b\]8;;\x1b\\/g)].map(match =>
		Bun.stripANSI(match[1]!),
	);
}

beforeAll(async () => {
	await initTheme();
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
});

afterAll(() => {
	resetSettingsForTest();
});

describe("readToolRenderer hyperlinks", () => {
	it("links local-style read titles to the resolved filesystem path and selected line", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const handoffPath = path.resolve("/tmp/omp-local/handoff.md");
		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "second line" }],
				details: {
					resolvedPath: handoffPath,
					displayContent: { text: "second line", startLine: 2 },
					contentType: "text/plain",
				},
			},
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "local://handoff.md:2" },
		);

		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("local://handoff.md");
		expect(rendered).toContain(":2");
		const handoffUri = new URL(url.pathToFileURL(path.resolve(handoffPath)).href);
		handoffUri.searchParams.set("line", "2");
		expect(extractLinkUris(rendered)).toContain(handoffUri.href);
		expect(extractLinkTexts(rendered)).toContain("local://handoff.md");
		expect(extractLinkTexts(rendered)).not.toContain("local://handoff.md:2");
	});

	it("links absolute read call paths to file URIs with selector lines", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const examplePath = path.resolve("/tmp/omp-read/example.ts");
		const component = readToolRenderer.renderCall(
			{ path: `${examplePath}:10-12` },
			{ expanded: false, isPartial: false },
			theme!,
		);

		const rendered = component.render(200).join("\n");
		expect(Bun.stripANSI(rendered)).toContain(`${examplePath}:10-12`);
		const exampleUri = new URL(url.pathToFileURL(path.resolve(examplePath)).href);
		exampleUri.searchParams.set("line", "10");
		expect(extractLinkUris(rendered)).toContain(exampleUri.href);
		expect(extractLinkTexts(rendered)).toContain(examplePath);
		expect(extractLinkTexts(rendered)).not.toContain(`${examplePath}:10-12`);
	});

	it("links HTTP read result headers to the final URL", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "---\n\nhello" }],
				details: {
					kind: "url",
					url: "http://example.com/start",
					finalUrl: "http://example.com/final",
					contentType: "text/plain",
					method: "fetch",
					truncated: false,
					notes: [],
				},
			} as never,
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "http://example.com/start" },
		);

		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("example.com /final");
		expect(extractLinkUris(rendered)).toContain("http://example.com/final");
	});
});

describe("readToolRenderer markdown content", () => {
	it("renders text/markdown details through the markdown renderer", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "[notes.md#ABCD]\n1:# Heading\n2:\n3:This is **bold** text." }],
				details: {
					displayContent: { text: "# Heading\n\nThis is **bold** text.", startLine: 1 },
					contentType: "text/markdown",
				},
			},
			{ expanded: true, isPartial: false },
			theme!,
			{ path: "notes.md" },
		);

		const stripped = component
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(stripped).toContain("Heading");
		expect(stripped).toContain("This is bold text.");
		expect(stripped).not.toContain("# Heading");
		expect(stripped).not.toContain("**bold**");
	});

	it("keeps untagged markdown source in the code renderer", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "[notes.md#ABCD]\n1:# Heading\n2:\n3:This is **bold** text." }],
				details: {
					displayContent: { text: "# Heading\n\nThis is **bold** text.", startLine: 1 },
				},
			},
			{ expanded: true, isPartial: false },
			theme!,
			{ path: "notes.md" },
		);

		const stripped = component
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(stripped).toContain("# Heading");
		expect(stripped).toContain("**bold**");
	});

	it("keeps raw markdown selector reads in the code renderer", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "# Heading\n\nThis is **bold** text." }],
				details: {
					displayContent: { text: "# Heading\n\nThis is **bold** text.", startLine: 1 },
					contentType: "text/markdown",
				},
			},
			{ expanded: true, isPartial: false },
			theme!,
			{ path: "notes.md:raw" },
		);

		const stripped = component
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(stripped).toContain("# Heading");
		expect(stripped).toContain("**bold**");
	});
});

describe("read ToolExecutionComponent framing", () => {
	it("renders framed read results inside the standard tool container padding", () => {
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("read", { path: "src/example.ts" }, {}, undefined, uiStub);
		component.updateResult(
			{
				content: [{ type: "text", text: "export const x = 1;" }],
				details: {
					displayContent: { text: "export const x = 1;", startLine: 1 },
					contentType: "text/plain",
				},
			},
			false,
		);

		try {
			const lines = component.render(80).map(line => Bun.stripANSI(line));
			const topBorderIndex = lines.findIndex(
				line => line.includes(activeTheme.boxRound.topLeft) && line.includes("Read"),
			);
			const bottomBorderIndex = lines.findIndex(
				(line, index) => index > topBorderIndex && line.includes(activeTheme.boxRound.bottomLeft),
			);

			expect(topBorderIndex).toBeGreaterThanOrEqual(0);
			expect(lines[topBorderIndex + 1]).toContain("export const x = 1;");
			expect(bottomBorderIndex).toBeGreaterThan(topBorderIndex);
		} finally {
			component.stopAnimation();
		}
	});
});
