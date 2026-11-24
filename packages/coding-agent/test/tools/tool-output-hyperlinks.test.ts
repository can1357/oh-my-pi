import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { signal } from "@oh-my-pi/pi-tui";
import "../../src/ui/styles/figures";
import "../../src/ui/styles/messages";
import "../../src/ui/styles/transcript/exec-run";
import "../../src/ui/styles/transcript/read-group";
import { printRows } from "../../src/ui/print-rows";
import { lspPresenter } from "../../src/ui/tools/lsp";
import { ExecRun, ExecRunBlock } from "../../src/ui/transcript/exec-run";
import { EmbedFigure } from "../../src/ui/transcript/figures";
import { setImageBlobWriter } from "../../src/ui/transcript/image-links";
import { AssistantMessageBlock } from "../../src/ui/transcript/messages/assistant-message";
import { SkillMessage } from "../../src/ui/transcript/messages/skill-message";
import { UserMessage } from "../../src/ui/transcript/messages/user-message";
import { ReadGroup, ReadGroupBlock } from "../../src/ui/transcript/read-group";
import { ToolBlock } from "../../src/ui/transcript/tool-block";
import { type ToolTextInput, toolCall } from "../helpers/tool-text";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

// 1x1 PNG so the read tool takes its image branch.
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b\x07]+)(?:\x1b\\|\x07)/g)].map(match => match[1]!);
}

/** A tool card's rows on a terminal that draws OSC 8 hyperlinks (or, with `hyperlinks: false`, one that does not). */
function linkedRows(input: ToolTextInput, hyperlinks = true): string {
	const call = toolCall(input);
	return printRows(() => ToolBlock({ call }), input.width ?? 200, { hyperlinks }).join("\n");
}

/** `file://` URI of an absolute path. */
function fileUri(filePath: string): string {
	return url.pathToFileURL(path.resolve(filePath)).href;
}

const PROJECT = path.resolve("/tmp/omp-project");

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
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

describe("tool output OSC 8 file:// hyperlinks", () => {
	it("links plain text and image read titles to the resolved filesystem path", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-link-read-"));
		try {
			const textPath = path.join(dir, "task.txt");
			fs.writeFileSync(textPath, "hello\nworld\n");
			const imgPath = path.join(dir, "task.png");
			fs.writeFileSync(imgPath, Buffer.from(TINY_PNG_BASE64, "base64"));

			const tool = new ReadTool(createTestToolSession(dir));
			const textRes = await tool.execute("t", { path: textPath });
			const imgRes = await tool.execute("i", { path: imgPath });

			const textRender = linkedRows({ name: "read", args: { path: textPath }, result: textRes });
			const imgRender = linkedRows({ name: "read", args: { path: imgPath }, result: imgRes });

			expect(extractLinkUris(textRender)).toContain(url.pathToFileURL(path.resolve(textPath)).href);
			expect(extractLinkUris(imgRender)).toContain(url.pathToFileURL(path.resolve(imgPath)).href);
		} finally {
			removeSyncWithRetries(dir);
		}
	});

	it("links the write header to the absolute path it wrote", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-link-write-"));
		try {
			const filePath = path.join(dir, "out.ts");
			const tool = new WriteTool(createTestToolSession(dir));
			const res = await tool.execute("w", { path: filePath, content: "export const x = 1;\n" });
			const rendered = linkedRows({ name: "write", args: { path: filePath }, result: res });
			expect(extractLinkUris(rendered)).toContain(url.pathToFileURL(path.resolve(filePath)).href);
		} finally {
			removeSyncWithRetries(dir);
		}
	});

	it("resolves scoped search links against cwd, not the (sub)scope path", async () => {
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
				displayContent: ["# src/", "## interactive-mode.ts#ABCD", "*12│const needle = true;"].join("\n"),
			},
		};
		const rendered = linkedRows({
			name: "grep",
			args: { pattern: "needle" },
			result: result as never,
			expanded: true,
			width: 240,
		});
		const interactiveModeUri = url.pathToFileURL(path.resolve(interactiveModePath)).href;
		const uris = extractLinkUris(rendered);
		expect(uris.filter(uri => uri === interactiveModeUri)).toHaveLength(2);
		expect(uris.some(uri => uri.includes("/src/src/"))).toBe(false);
	});

	it("resolves scoped ast-grep links against cwd, not the (sub)scope path", async () => {
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
		const rendered = linkedRows({
			name: "ast_grep",
			args: { pat: "needle" },
			result: result as never,
			expanded: true,
			width: 240,
		});
		const interactiveModeUri = url.pathToFileURL(path.resolve(interactiveModePath)).href;
		const uris = extractLinkUris(rendered);
		expect(uris).toContain(interactiveModeUri);
		expect(uris.some(uri => uri.includes("/src/src/"))).toBe(false);
	});

	it("links the edit header to the absolute details.path even when the arg path is relative", async () => {
		const editPath = path.resolve("/tmp/omp-project/src/a.ts");
		const rendered = linkedRows({
			name: "edit",
			args: { path: "src/a.ts" },
			result: {
				content: [{ type: "text", text: "Updated src/a.ts" }],
				details: { diff: "+1|// x", op: "update", path: editPath },
			},
			renderContext: { editMode: "hashline" },
		});
		const editUri = url.pathToFileURL(path.resolve(editPath)).href;
		const rootAnchoredArgUri = url.pathToFileURL(path.resolve("/src/a.ts")).href;
		const uris = extractLinkUris(rendered);
		expect(uris).toContain(editUri);
		// A relative arg path must not leak into a root-anchored file URI.
		expect(uris).not.toContain(rootAnchoredArgUri);
	});
});

describe("tool output OSC 8 links: every tool family", () => {
	it("draws no links on a terminal without them", () => {
		const rendered = linkedRows(
			{
				name: "edit",
				args: { path: "src/a.ts" },
				result: {
					content: [{ type: "text", text: "Updated src/a.ts" }],
					details: { diff: "+1|// x", op: "update", path: path.join(PROJECT, "src/a.ts") },
				},
				renderContext: { editMode: "hashline" },
			},
			false,
		);
		expect(extractLinkUris(rendered)).toEqual([]);
	});

	it("links a pending read and write to the file their argument names", () => {
		const readPath = path.join(PROJECT, "src/a.ts");
		expect(extractLinkUris(linkedRows({ name: "read", args: { path: `${readPath}:5-9` } }))).toContain(
			fileUri(readPath),
		);
		const writePath = path.join(PROJECT, "out.ts");
		const write = linkedRows({ name: "write", args: { path: writePath, content: "x\n" }, partial: true });
		expect(extractLinkUris(write)).toContain(fileUri(writePath));
	});

	it("links both sides of an edit's move", () => {
		const from = path.join(PROJECT, "src/old.ts");
		const to = path.join(PROJECT, "src/new.ts");
		const rendered = linkedRows({
			name: "edit",
			args: { path: "src/old.ts", rename: "src/new.ts" },
			result: {
				content: [{ type: "text", text: "Moved" }],
				details: { op: "update", sourcePath: from, path: to, move: "src/new.ts" },
			},
		});
		const uris = extractLinkUris(rendered);
		expect(uris).toContain(fileUri(from));
		expect(uris).toContain(fileUri(to));
	});

	it("links a single-file grep's headerless rows to the searched file and its scope to the search path", () => {
		const file = path.join(PROJECT, "src/a.ts");
		const rendered = linkedRows({
			name: "grep",
			args: { pattern: "needle", path: "src/a.ts" },
			result: {
				content: [{ type: "text", text: "" }],
				details: {
					matchCount: 1,
					fileCount: 1,
					cwd: PROJECT,
					searchPath: file,
					scopePath: "src/a.ts",
					displayContent: "*12│const needle = true;",
				},
			} as never,
			expanded: true,
		});
		expect(extractLinkUris(rendered).filter(uri => uri === fileUri(file))).toHaveLength(2);
	});

	it("links ast_edit file rows against cwd", () => {
		const rendered = linkedRows({
			name: "ast_edit",
			args: { ops: [{ pat: "a", out: "b" }] },
			result: {
				content: [{ type: "text", text: "" }],
				details: {
					totalReplacements: 1,
					filesTouched: 1,
					filesSearched: 1,
					applied: true,
					cwd: PROJECT,
					searchPath: path.join(PROJECT, "src"),
					displayContent: ["# src/", "## a.ts (1 replacement)", "-3│a", "+3│b"].join("\n"),
				},
			} as never,
			expanded: true,
		});
		expect(extractLinkUris(rendered)).toContain(fileUri(path.join(PROJECT, "src/a.ts")));
	});

	it("links find hits and their passages under cwd, and a virtual hit to its URL", () => {
		const rendered = linkedRows({
			name: "find",
			args: { query: "retry" },
			result: {
				content: [{ type: "text", text: "" }],
				details: {
					cwd: PROJECT,
					hits: [
						{
							rel: "src/a.ts",
							contentScore: 0.9,
							linesSeen: 10,
							ranges: [{ start: 3, end: 5, p: 0.9, snippet: "x" }],
						},
						{ rel: "docs://guide.md", contentScore: 0.5, linesSeen: 4, ranges: [] },
					],
				},
			} as never,
		});
		const uris = extractLinkUris(rendered);
		expect(uris.filter(uri => uri === fileUri(path.join(PROJECT, "src/a.ts")))).toHaveLength(2);
		expect(uris).toContain("docs://guide.md");
	});

	it("links glob files (not directories) under cwd", () => {
		const rendered = linkedRows({
			name: "glob",
			args: { pattern: "*" },
			result: {
				content: [{ type: "text", text: "" }],
				details: { fileCount: 2, files: ["src/a.ts", "src/"], cwd: PROJECT },
			} as never,
		});
		expect(extractLinkUris(rendered)).toEqual([fileUri(path.join(PROJECT, "src/a.ts"))]);
	});

	it("gives an lsp head the native link of its absolute file", () => {
		const file = path.join(PROJECT, "src/a.ts");
		const view = lspPresenter.call?.(
			{ action: "definition", file },
			{
				expanded: false,
				isPartial: false,
				argsComplete: true,
				executionStarted: false,
			},
		);
		expect(view?.head?.href).toBe(fileUri(file));
	});

	it("links a URL read's head and final URL, and web search source titles", () => {
		const read = linkedRows({
			name: "read",
			args: { path: "https://example.com/docs" },
			result: {
				content: [{ type: "text", text: "body" }],
				details: {
					kind: "url",
					url: "https://example.com/docs",
					finalUrl: "https://example.com/final",
					contentType: "text/html",
					method: "GET",
					truncated: false,
					notes: [],
				},
			} as never,
		});
		const readUris = extractLinkUris(read);
		expect(readUris).toContain("https://example.com/final");
		const search = linkedRows({
			name: "web_search",
			args: { query: "omp" },
			result: {
				content: [{ type: "text", text: "" }],
				details: {
					response: {
						provider: "anthropic",
						answer: "An answer.",
						sources: [{ title: "Docs", url: "https://example.com/source" }],
					},
				},
			} as never,
		});
		expect(extractLinkUris(search)).toContain("https://example.com/source");
	});
});

describe("transcript OSC 8 links", () => {
	it("links read group rows to their files at the first selected line", () => {
		const group = new ReadGroup({ showContentPreview: false });
		const a = path.join(PROJECT, "src/a.ts");
		const b = path.join(PROJECT, "src/b.ts");
		group.updateArgs({ path: `${a}:5-9` }, "a");
		group.updateArgs({ path: b }, "b");
		const rendered = printRows(() => ReadGroupBlock({ group }), 120, { hyperlinks: true }).join("\n");
		const uris = extractLinkUris(rendered);
		expect(uris).toContain(fileUri(a));
		expect(uris).toContain(fileUri(b));
	});

	it("links a user prompt's skill chip and attachment chip, and a skill message's pill", () => {
		const skill = path.join(PROJECT, ".omp/skills/demo/SKILL.md");
		const image = path.join(PROJECT, "image.png");
		const user = printRows(
			() =>
				UserMessage({
					model: { text: "use ✦ demo on [Image #1]", imageLinks: [image], skillPath: () => skill },
				}),
			80,
			{ hyperlinks: true },
		).join("\n");
		expect(extractLinkUris(user)).toEqual(expect.arrayContaining([fileUri(skill), fileUri(image)]));
		const message = printRows(
			() =>
				SkillMessage({
					content: "Skill body",
					details: { name: "demo", path: skill, lineCount: 3 },
					expanded: signal(false),
				}),
			80,
			{ hyperlinks: true },
		).join("\n");
		expect(extractLinkUris(message)).toContain(fileUri(skill));
	});

	it("links an embed's note to its file, and a frame's [Visit] to its page", () => {
		const host = { cwd: () => PROJECT };
		const picture = printRows(
			() => EmbedFigure({ embed: { kind: "img", src: "out/pic.png", label: "chart" }, showImages: false, host }),
			80,
			{ hyperlinks: true },
		).join("\n");
		expect(extractLinkUris(picture)).toContain(fileUri(path.join(PROJECT, "out/pic.png")));
		const page = printRows(
			() =>
				EmbedFigure({
					embed: { kind: "iframe", src: "https://example.com/app", label: "app" },
					showImages: false,
					host,
				}),
			80,
			{ hyperlinks: true },
		).join("\n");
		expect(extractLinkUris(page)).toContain("https://example.com/app");
	});
});

describe("image placeholder OSC 8 links", () => {
	const blobPath = path.join(PROJECT, "blobs/image.png");
	let writes = 0;
	let disposeWriter: (() => void) | undefined;
	beforeAll(() => {
		disposeWriter = setImageBlobWriter(() => {
			writes++;
			return { displayPath: blobPath };
		});
	});
	afterAll(() => disposeWriter?.());

	const image = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" };

	function hiddenImageRows(name: string, details: unknown, hyperlinks = true): string {
		const call = toolCall({
			name,
			args: name === "bash" ? { command: "shot" } : {},
			result: { content: [{ type: "text", text: "done" }, image], details } as never,
			expanded: true,
		});
		call.setShowImages(false);
		return printRows(() => ToolBlock({ call }), 120, { hyperlinks }).join("\n");
	}

	it("links a tool result's placeholder to a blob copy, or to the file the image was read from", () => {
		expect(extractLinkUris(hiddenImageRows("custom_tool", undefined))).toContain(fileUri(blobPath));
		const media = path.join(PROJECT, "shot.png");
		expect(extractLinkUris(hiddenImageRows("custom_tool", { mediaPath: media }))).toContain(fileUri(media));
		expect(extractLinkUris(hiddenImageRows("bash", undefined))).toContain(fileUri(blobPath));
	});

	it("writes no blob and draws no link on a terminal without links", () => {
		const before = writes;
		expect(extractLinkUris(hiddenImageRows("custom_tool", undefined, false))).toEqual([]);
		expect(writes).toBe(before);
	});

	it("links a user run's image placeholder", () => {
		const run = new ExecRun({ kind: "bash", source: "shot", excluded: false, now: () => 0 });
		run.setComplete(0, false, { images: [image], showImages: false });
		const rows = printRows(() => ExecRunBlock({ run }), 80, { hyperlinks: true }).join("\n");
		expect(extractLinkUris(rows)).toContain(fileUri(blobPath));
	});

	it("links an assistant image's placeholder where the terminal draws no images", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "Here:" }, image],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			provider: "p",
			model: "m",
			api: "x",
			timestamp: 0,
		} as never;
		const rows = printRows(
			() => AssistantMessageBlock({ model: { message: signal(message), finalized: signal(true), now: () => 0 } }),
			80,
			{ hyperlinks: true },
		).join("\n");
		expect(extractLinkUris(rows)).toContain(fileUri(blobPath));
	});
});
