import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { editToolRenderer } from "@oh-my-pi/pi-coding-agent/edit/renderer";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { astGrepToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/ast-grep";
import { ReadTool, readToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool, writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { grepToolRenderer } from "../../src/tools/grep";

// 1x1 PNG so the read tool takes its image branch.
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

function createTestToolSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

beforeAll(async () => {
	await initTheme(false);
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
});

afterAll(() => {
	resetSettingsForTest();
});

describe("tool output OSC 8 file:// hyperlinks", () => {
	it("links plain text and image read titles to the resolved filesystem path", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = (await getThemeByName("dark"))!;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-link-read-"));
		try {
			const textPath = path.join(dir, "task.txt");
			fs.writeFileSync(textPath, "hello\nworld\n");
			const imgPath = path.join(dir, "task.png");
			fs.writeFileSync(imgPath, Buffer.from(TINY_PNG_BASE64, "base64"));

			const tool = new ReadTool(createTestToolSession(dir));
			const textRes = await tool.execute("t", { path: textPath });
			const imgRes = await tool.execute("i", { path: imgPath });

			const textRender = readToolRenderer
				.renderResult(
					{ content: textRes.content, details: textRes.details, isError: textRes.isError },
					{ expanded: false, isPartial: false },
					theme,
					{ path: textPath },
				)
				.render(200)
				.join("\n");
			const imgRender = readToolRenderer
				.renderResult(
					{ content: imgRes.content, details: imgRes.details, isError: imgRes.isError },
					{ expanded: false, isPartial: false },
					theme,
					{ path: imgPath },
				)
				.render(200)
				.join("\n");

			expect(extractLinkUris(textRender)).toContain(url.pathToFileURL(path.resolve(textPath)).href);
			expect(extractLinkUris(imgRender)).toContain(url.pathToFileURL(path.resolve(imgPath)).href);
		} finally {
			removeSyncWithRetries(dir);
		}
	});

	it("links the write header to the absolute path it wrote", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = (await getThemeByName("dark"))!;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-link-write-"));
		try {
			const filePath = path.join(dir, "out.ts");
			const tool = new WriteTool(createTestToolSession(dir));
			const res = await tool.execute("w", { path: filePath, content: "export const x = 1;\n" });
			const rendered = writeToolRenderer
				.renderResult(
					{ content: res.content, details: res.details, isError: res.isError },
					{ expanded: false, isPartial: false },
					theme,
					{ path: filePath },
				)
				.render(200)
				.join("\n");
			expect(extractLinkUris(rendered)).toContain(url.pathToFileURL(path.resolve(filePath)).href);
		} finally {
			removeSyncWithRetries(dir);
		}
	});

	it("resolves scoped search links against cwd, not the (sub)scope path", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = (await getThemeByName("dark"))!;
		// Scoped search: scope dir (`searchPath`) is below cwd, and the grouped
		// display paths are cwd-relative. Resolving against searchPath would double
		// the `src` prefix (`/proj/src/src/...`).
		const projectRoot = path.resolve("/tmp/omp-project");
		const srcRoot = path.join(projectRoot, "src");
		const interactiveModePath = path.join(srcRoot, "interactive-mode.ts");
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 1,
				fileCount: 1,
				cwd: projectRoot,
				searchPath: srcRoot,
				scopePath: "src",
				displayContent: ["# src/", "## interactive-mode.ts#abcd", "*12│const needle = true;"].join("\n"),
			},
		};
		const rendered = grepToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, theme, { pattern: "needle" })
			.render(240)
			.join("\n");
		const interactiveModeUri = url.pathToFileURL(path.resolve(interactiveModePath)).href;
		const interactiveModeLineUri = new URL(interactiveModeUri);
		interactiveModeLineUri.searchParams.set("line", "12");
		const uris = extractLinkUris(rendered);
		expect(uris).toContain(interactiveModeUri);
		expect(uris).toContain(interactiveModeLineUri.href);
		expect(uris.some(uri => uri.includes("/src/src/"))).toBe(false);
	});

	it("resolves scoped ast-grep links against cwd, not the (sub)scope path", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = (await getThemeByName("dark"))!;
		const projectRoot = path.resolve("/tmp/omp-project");
		const srcRoot = path.join(projectRoot, "src");
		const interactiveModePath = path.join(srcRoot, "interactive-mode.ts");
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 1,
				fileCount: 1,
				filesSearched: 1,
				limitReached: false,
				cwd: projectRoot,
				searchPath: srcRoot,
				scopePath: "src",
				displayContent: ["# src/", "## interactive-mode.ts", "  *12│const needle = true;"].join("\n"),
			},
		};
		const rendered = astGrepToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, theme, { pat: "needle" })
			.render(240)
			.join("\n");
		const interactiveModeUri = url.pathToFileURL(path.resolve(interactiveModePath)).href;
		const uris = extractLinkUris(rendered);
		expect(uris).toContain(interactiveModeUri);
		expect(uris.some(uri => uri.includes("/src/src/"))).toBe(false);
	});

	it("links the edit header to the absolute details.path even when the arg path is relative", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = (await getThemeByName("dark"))!;
		const editPath = path.resolve("/tmp/omp-project/src/a.ts");
		const rendered = editToolRenderer
			.renderResult(
				{
					content: [{ type: "text", text: "Updated src/a.ts" }],
					details: { diff: "+1|// x", op: "update", path: editPath },
				},
				{ expanded: false, isPartial: false, renderContext: { editMode: "hashline" } },
				theme,
				{ path: "src/a.ts" },
			)
			.render(200)
			.join("\n");
		const editUri = url.pathToFileURL(path.resolve(editPath)).href;
		const rootAnchoredArgUri = url.pathToFileURL(path.resolve("/src/a.ts")).href;
		const uris = extractLinkUris(rendered);
		expect(uris).toContain(editUri);
		// A relative arg path must not leak into a root-anchored file URI.
		expect(uris).not.toContain(rootAnchoredArgUri);
	});
});
