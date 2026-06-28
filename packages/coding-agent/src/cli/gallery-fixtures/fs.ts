// biome-ignore-all lint/suspicious/noTemplateCurlyInString: sample source-code strings (read fixtures) intentionally contain literal ${...}.
// Gallery fixtures for the filesystem tools (read, write, glob).
import { ReadToolGroupComponent } from "../../modes/components/read-tool-group";
import type { GalleryFixture, GalleryFixtureState, GalleryResult } from "./types";

const readSnippet = [
	"export const globToolRenderer = {",
	"\tinline: true,",
	"\trenderCall(args: GlobRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {",
	"\t\tconst meta: string[] = [];",
	"\t\tif (args.limit !== undefined) meta.push(`limit:${args.limit}`);",
	"",
	"\t\tconst text = renderStatusLine(",
	'\t\t\t{ icon: "pending", title: "Glob", description: formatGlobRenderPaths(args.paths) || "*", meta },',
	"\t\t\tuiTheme,",
	"\t\t);",
	"\t\treturn new Text(text, 0, 0);",
	"\t},",
].join("\n");

const writtenContent = [
	'import { describe, expect, it } from "bun:test";',
	'import { parseSel } from "../src/tools/read";',
	"",
	'describe("parseSel", () => {',
	'\tit("parses a single line range", () => {',
	'\t\texpect(parseSel("42-58")).toEqual({',
	'\t\t\tkind: "lines",',
	"\t\t\tranges: [{ startLine: 42, endLine: 58 }],",
	"\t\t});",
	"\t});",
	"",
	'\tit("treats raw as a verbatim selector", () => {',
	'\t\texpect(parseSel("raw")).toEqual({ kind: "raw" });',
	"\t});",
	"});",
	"",
].join("\n");

const groupedReadTargets = [
	"packages/coding-agent/test/streaming-preview-height.test.ts:301-409",
	"packages/coding-agent/test/tool-live-region-scrollback.test.ts:143-310",
	"packages/tui/test/streaming-scrollback-defer.test.ts:89-464",
];

const groupedReadDelimitedPath = groupedReadTargets.join(",");
const groupedReadRepeatedFile = "packages/coding-agent/src/task/render.ts";
const groupedReadRepeatedRanges = `${groupedReadRepeatedFile}:507-605,1070-1194,1210-1240,1270-1274`;

function textResult(text: string, details?: unknown, isError?: boolean): GalleryResult {
	return { content: [{ type: "text", text }], details, isError };
}

function addGroupedReadArgs(component: ReadToolGroupComponent): void {
	component.updateArgs({ path: groupedReadDelimitedPath }, "read-delimited");
	component.updateArgs({ path: groupedReadRepeatedRanges }, "read-ranges");
}

function renderReadGroupFixtureState(state: GalleryFixtureState, width: number, expanded: boolean): readonly string[] {
	const component = new ReadToolGroupComponent();
	component.setExpanded(expanded);

	if (state === "streaming") {
		component.updateArgs(
			{
				path: [
					"packages/coding-agent/test/streaming-preview-height.test.ts:301-409",
					"packages/coding-agent/test/tool-live-region-scrollback.test.ts:143-",
				].join(","),
			},
			"read-delimited",
		);
		return component.render(width);
	}

	addGroupedReadArgs(component);
	if (state === "progress") return component.render(width);

	component.updateResult(
		textResult("Read three focused test ranges.", { displayReadTargets: groupedReadTargets }),
		false,
		"read-delimited",
	);

	if (state === "error") {
		component.updateResult(
			textResult("Error: selector 1270-1274 is outside the file", undefined, true),
			false,
			"read-ranges",
		);
		return component.render(width);
	}

	component.updateResult(textResult("Read four render.ts ranges."), false, "read-ranges");
	return component.render(width);
}

export const fsFixtures: Record<string, GalleryFixture> = {
	read: {
		label: "Read",
		// Streaming: path still being typed, selector not yet appended.
		streamingArgs: { path: "packages/coding-agent/src/tools/glob" },
		args: { path: "packages/coding-agent/src/tools/glob.ts:437-448" },
		result: {
			content: [
				{
					type: "text",
					text: [
						"[packages/coding-agent/src/tools/glob.ts#E48E]",
						"437:export const globToolRenderer = {",
						"438:\tinline: true,",
						"439:\trenderCall(args: GlobRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {",
						"440:\t\tconst meta: string[] = [];",
						"441:\t\tif (args.limit !== undefined) meta.push(`limit:${args.limit}`);",
						"442:",
						"443:\t\tconst text = renderStatusLine(",
						'444:\t\t\t{ icon: "pending", title: "Glob", description: formatGlobRenderPaths(args.paths) || "*", meta },',
						"445:\t\t\tuiTheme,",
						"446:\t\t);",
						"447:\t\treturn new Text(text, 0, 0);",
						"448:\t},",
					].join("\n"),
				},
			],
			details: {
				kind: "file",
				resolvedPath: "/Users/dev/Projects/pi/packages/coding-agent/src/tools/glob.ts",
				contentType: "text/typescript",
				displayContent: { text: readSnippet, startLine: 437 },
			},
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: "Error: ENOENT: no such file or directory, open 'packages/coding-agent/src/tools/glob.ts'",
				},
			],
		},
	},

	read_group: {
		label: "Read Groups",
		args: {},
		result: textResult("Rendered grouped read calls."),
		errorResult: textResult("Rendered grouped read errors.", undefined, true),
		renderState: renderReadGroupFixtureState,
	},

	write: {
		label: "Write",
		// Streaming: path known, content still arriving (only the imports so far).
		streamingArgs: {
			path: "packages/coding-agent/test/parse-sel.test.ts",
			content: 'import { describe, expect, it } from "bun:test";\nimport { parseSel } from "../src/tools/read";\n',
		},
		args: {
			path: "packages/coding-agent/test/parse-sel.test.ts",
			content: writtenContent,
		},
		result: {
			content: [
				{
					type: "text",
					text: "Created packages/coding-agent/test/parse-sel.test.ts (17 lines, 412 bytes).",
				},
			],
			details: {},
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: "Error: EACCES: permission denied, open 'packages/coding-agent/test/parse-sel.test.ts'",
				},
			],
		},
	},

	glob: {
		label: "Glob",
		// Streaming: glob half-typed, no limit yet.
		streamingArgs: { paths: ["packages/coding-agent/src/tools/*-render"] },
		args: { paths: ["packages/coding-agent/src/**/*.test.ts"], limit: 50 },
		result: {
			content: [
				{
					type: "text",
					text: [
						"packages/coding-agent/src/tools/read.test.ts",
						"packages/coding-agent/src/tools/write.test.ts",
						"packages/coding-agent/src/tools/glob.test.ts",
						"packages/coding-agent/src/cli/gallery-cli.test.ts",
						"packages/coding-agent/src/edit/edit.test.ts",
					].join("\n"),
				},
			],
			details: {
				scopePath: "packages/coding-agent/src",
				cwd: "/Users/dev/Projects/pi",
				fileCount: 5,
				truncated: false,
				files: [
					"packages/coding-agent/src/cli/gallery-cli.test.ts",
					"packages/coding-agent/src/edit/edit.test.ts",
					"packages/coding-agent/src/tools/glob.test.ts",
					"packages/coding-agent/src/tools/read.test.ts",
					"packages/coding-agent/src/tools/write.test.ts",
				],
			},
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Glob failed: invalid glob pattern '[unclosed'." }],
			details: { error: "invalid glob pattern '[unclosed'" },
		},
	},
};
