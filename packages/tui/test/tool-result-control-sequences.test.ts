import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

/**
 * Tool `details` carry raw file text (grep/read `displayContent`) straight to
 * renderers, both live and when a resumed session replays the transcript. File
 * bytes such as `ESC[?1049h ESC[?1003h` must never reach the terminal as live
 * sequences, or a grep over captured terminal fixtures leaves the pane stuck in
 * the alternate screen with mouse reporting on (#15963).
 */

const FILE_ESCAPES = "\x1b[?1049h\x1b[?1000h\x1b[?1003h\x1b[?1006h";
const LINE = `needle ${FILE_ESCAPES}`;

/** DEC private mode toggles: the file's payload; renderer styling never emits these. */
function privateModeSequences(text: string): string[] {
	return text.match(/\x1b\[\?[\d;]*[hl]/g) ?? [];
}

afterEach(() => {
	applyHyperlinkSetting("auto");
});

describe("tool result details with raw control sequences", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("grep match previews render the file text without its escape sequences", () => {
		const component = new ToolExecutionComponent(
			"grep",
			{ pattern: "needle" },
			{ useBuiltInRenderer: true },
			undefined,
			{ requestRender: vi.fn(), requestComponentRender: vi.fn(), resetDisplay: vi.fn() },
			"/repo",
		);
		const details = {
			matchCount: 1,
			fileCount: 1,
			displayContent: ["# fixture.txt", `*1│${LINE}`].join("\n"),
		};
		component.updateResult({ content: [{ type: "text", text: "*1|needle" }], details }, false);

		for (const expanded of [false, true]) {
			component.setExpanded(expanded);
			const rendered = component.render(120).join("\n");
			expect(rendered).toContain("needle");
			expect(privateModeSequences(rendered)).toEqual([]);
		}
		// The caller's result is left intact for persistence and the model.
		expect(details.displayContent).toContain(FILE_ESCAPES);
	});

	it("grouped read previews render the file text without its escape sequences", () => {
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		group.updateArgs({ path: "fixture.txt" }, "a");
		group.updateResult(
			{ content: [{ type: "text", text: "needle" }], details: { displayContent: { text: LINE, startLine: 1 } } },
			false,
			"a",
		);
		group.setExpanded(true);

		const rendered = group.render(120).join("\n");
		expect(rendered).toContain("needle");
		expect(privateModeSequences(rendered)).toEqual([]);
	});

	// Windows rejects control characters in filenames.
	it.skipIf(process.platform === "win32")(
		"keeps a control-byte filename as the hyperlink target while cleaning its label",
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-link-"));
			const filename = path.join(dir, `fixture${FILE_ESCAPES}.txt`);
			try {
				await Bun.write(filename, "needle");
				const cases: Array<[string, ReadToolDetails]> = [
					[
						"target",
						{
							displayTarget: filename,
							resolvedPath: "/wrong",
							meta: { source: { type: "path", value: "/wrong" } },
						},
					],
					["resolved", { resolvedPath: filename, meta: { source: { type: "path", value: "/wrong" } } }],
					["source", { meta: { source: { type: "path", value: filename } } }],
				];
				for (const [id, details] of cases) {
					const group = new ReadToolGroupComponent({ showContentPreview: true });
					group.updateArgs({ path: filename }, id);
					group.updateResult(
						{
							content: [{ type: "text", text: "needle" }],
							details: { ...details, displayContent: { text: LINE, startLine: 1 } },
						},
						false,
						id,
					);
					const view = group.describe({
						cols: 120,
						reduceMotion: false,
						dark: true,
						supports: kind => kind === "tool",
						feature: () => true,
					});
					if (view.k !== "tool") throw new Error("Expected read tool node");
					const href = view.p?.href;
					expect(href).toBe(pathToFileURL(filename).href);
					expect(view.p?.target).not.toContain("\x1b");
					expect(group.render(120).join("\n")).not.toContain(FILE_ESCAPES);
					if (!href) throw new Error("Missing file link");
					expect(await Bun.file(new URL(href)).text()).toBe("needle");
				}
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"standalone read cards keep the original file hyperlink target",
		async () => {
			applyHyperlinkSetting("always");
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-single-link-"));
			const filename = path.join(dir, `fixture${FILE_ESCAPES}.txt`);
			try {
				await Bun.write(filename, "needle");
				const component = new ToolExecutionComponent(
					"read",
					{ path: filename },
					{ useBuiltInRenderer: true },
					undefined,
					{ requestRender: vi.fn(), requestComponentRender: vi.fn(), resetDisplay: vi.fn() },
					dir,
				);
				component.updateResult({
					content: [{ type: "text", text: "needle" }],
					details: { resolvedPath: filename, mediaPath: filename, displayContent: { text: LINE, startLine: 1 } },
				});
				const view = component.describe({
					cols: 120,
					reduceMotion: false,
					dark: true,
					supports: kind => kind === "tool" || kind === "media",
					feature: () => true,
				});
				if (view.k !== "tool") throw new Error("Expected read tool node");
				expect(view.p?.href).toBe(pathToFileURL(filename).href);
				expect(view.p?.target).not.toContain("\x1b");
				const media = (view.c ?? []).find(child => "k" in child && child.k === "media");
				expect(media?.p?.path).toBe(filename);
				const rendered = component.render(120).join("\n");
				expect(rendered).toContain(pathToFileURL(filename).href);
				expect(rendered).not.toContain(FILE_ESCAPES);
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);

	it("write cards link to the original control-byte filename without displaying its controls", () => {
		applyHyperlinkSetting("always");
		const filename = `/tmp/fixture\x1b[?1049h.txt`;
		const href = pathToFileURL(filename).href;
		const component = new ToolExecutionComponent(
			"write",
			{ file_path: filename, content: "needle" },
			{ useBuiltInRenderer: true },
			undefined,
			{ requestRender: vi.fn(), requestComponentRender: vi.fn(), resetDisplay: vi.fn() },
			"/tmp",
		);
		component.updateResult({
			content: [{ type: "text", text: "Wrote file" }],
			details: { resolvedPath: filename },
		});
		const view = component.describe({
			cols: 120,
			reduceMotion: false,
			dark: true,
			supports: kind => kind === "tool",
			feature: () => true,
		});
		if (view.k !== "tool") throw new Error("Expected write tool node");
		expect(view.p?.href).toBe(href);
		expect(view.p?.target).not.toContain("\x1b");
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain(href);
		expect(privateModeSequences(rendered)).toEqual([]);
	});

	it("keeps each grouped read target link on its original control-byte filename", () => {
		const first = `/tmp/a${FILE_ESCAPES}.txt`;
		const second = `/tmp/b${FILE_ESCAPES}.txt`;
		const group = new ReadToolGroupComponent();
		group.updateArgs({ path: `${first}\n${second}` }, "a");
		group.updateResult(
			{
				content: [{ type: "text", text: "needle" }],
				details: {
					displayReadTargets: [first, second],
					displayReadTargetLinks: [first, second],
					displayContent: { text: LINE, startLine: 1 },
				},
			},
			false,
			"a",
		);
		const view = group.describe({
			cols: 120,
			reduceMotion: false,
			dark: true,
			supports: kind => kind === "tool",
			feature: () => true,
		});
		if (view.k !== "tool") throw new Error("Expected read tool node");
		const rows = (view.c ?? []).filter(child => "k" in child && child.k === "row");
		const links = rows.flatMap(row =>
			(row.c ?? []).flatMap(child =>
				"k" in child && child.k === "text" ? (child.p?.spans ?? []).flatMap(span => span.href ?? []) : [],
			),
		);
		expect(links).toEqual([pathToFileURL(first).href, pathToFileURL(second).href]);
		expect(group.render(120).join("\n")).not.toContain(FILE_ESCAPES);
	});
});
