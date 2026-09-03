import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDefault } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
	ReadToolGroupComponent,
	readArgsCollapseIntoGroup,
} from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

function extractLinkTexts(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;[^\x1b]+\x1b\\([\s\S]*?)\x1b\]8;;\x1b\\/g)].map(match =>
		Bun.stripANSI(match[1]!),
	);
}

describe("ReadToolGroupComponent", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	afterEach(() => {
		settings.clearOverride("tui.hyperlinks");
		vi.restoreAllMocks();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("keeps inline read previews disabled by default", () => {
		expect(getDefault("read.toolResultPreview")).toBe(false);

		const component = new ReadToolGroupComponent();
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: examplePath }, "read-0");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4" }],
			},
			false,
			"read-0",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(rendered).toContain(`Read ${examplePath}`);
		expect(rendered).not.toContain("line 1");
		expect(rendered.toLowerCase()).not.toContain("ctrl+o");
	});

	it("uses the enabled dot for completed reads", () => {
		const component = new ReadToolGroupComponent();
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: examplePath }, "read-success");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 1" }],
			},
			false,
			"read-success",
		);

		const rendered = component.render(120).join("\n");
		const plain = Bun.stripANSI(rendered);

		expect(plain).toContain(themeModule.theme.status.enabled);
		expect(plain).not.toContain(themeModule.theme.status.success);
		expect(rendered).toContain(themeModule.theme.fg("text", themeModule.theme.status.enabled));
		expect(rendered).not.toContain(themeModule.theme.fg("success", themeModule.theme.status.enabled));
	});

	it("omits duplicate success marks from multi-read child rows", () => {
		const component = new ReadToolGroupComponent();
		const onePath = path.resolve("/tmp/one.ts");
		const twoPath = path.resolve("/tmp/two.ts");
		component.updateArgs({ path: onePath }, "read-one");
		component.updateArgs({ path: twoPath }, "read-two");
		component.updateResult({ content: [{ type: "text", text: "one" }] }, false, "read-one");
		component.updateResult({ content: [{ type: "text", text: "two" }] }, false, "read-two");

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain("Read (2)");
		expect(plain).toContain(`${themeModule.theme.tree.branch} ${onePath}`);
		expect(plain).toContain(`${themeModule.theme.tree.last} ${twoPath}`);
		expect(plain).not.toContain(`${themeModule.theme.tree.branch} ${themeModule.theme.status.enabled}`);
		expect(plain).not.toContain(`${themeModule.theme.tree.last} ${themeModule.theme.status.enabled}`);
	});

	it("nests one usage row beneath the last path from each read-only turn", () => {
		const component = new ReadToolGroupComponent();
		const onePath = path.resolve("/tmp/one.ts");
		const twoPath = path.resolve("/tmp/two.ts");
		const threePath = path.resolve("/tmp/three.ts");
		component.updateArgs({ path: onePath }, "read-one");
		component.updateArgs({ path: `${twoPath}:1-2,${threePath}:1-2` }, "read-two");
		component.updateArgs({ path: `${twoPath}:3-4` }, "read-three");
		component.updateResult({ content: [{ type: "text", text: "one" }] }, false, "read-one");
		component.updateResult({ content: [{ type: "text", text: "two" }] }, false, "read-two");
		component.updateResult({ content: [{ type: "text", text: "three" }] }, false, "read-three");

		const firstUsage = {
			input: 1111,
			output: 11,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1122,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const parallelUsage = {
			input: 2222,
			output: 22,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2244,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		component.attachUsage(["read-one"], firstUsage, 1000, 500, new Date(2026, 0, 2, 3, 4, 5).getTime());
		component.attachUsage(
			["read-two", "read-three"],
			parallelUsage,
			2000,
			600,
			new Date(2026, 0, 2, 3, 4, 6).getTime(),
		);

		const lines = Bun.stripANSI(component.render(120).join("\n")).split("\n");
		const onePathIndex = lines.findIndex(line => line.includes(onePath));
		const twoPathIndex = lines.findIndex(line => line.includes(twoPath));
		const threePathIndex = lines.findIndex(line => line.includes(threePath));
		const firstUsageIndex = lines.findIndex(line => line.includes("2026-01-02 03:04:05"));
		const parallelUsageIndices = lines
			.map((line, index) => (line.includes("2026-01-02 03:04:06") ? index : -1))
			.filter(index => index >= 0);

		expect(firstUsageIndex).toBe(onePathIndex + 1);
		expect(lines[firstUsageIndex]?.startsWith(`   ${themeModule.theme.tree.vertical}  `)).toBe(true);
		expect(twoPathIndex).toBeGreaterThan(firstUsageIndex);
		expect(threePathIndex).toBeGreaterThan(twoPathIndex);
		expect(parallelUsageIndices).toEqual([threePathIndex + 1]);
		expect(lines[parallelUsageIndices[0]!]?.startsWith("      ")).toBe(true);
	});

	it("splits a single selector-delimited read argument into child rows", () => {
		const component = new ReadToolGroupComponent();
		const onePath = path.resolve("/tmp/one.ts");
		const twoPath = path.resolve("/tmp/two.ts");
		const threePath = path.resolve("/tmp/three.ts");
		component.updateArgs({ path: `${onePath}:1-2,${twoPath}:3-4;${threePath}:5-6` }, "read-many");
		component.updateResult({ content: [{ type: "text", text: "combined" }] }, false, "read-many");

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain("Read (3)");
		expect(plain).toContain(`${themeModule.theme.tree.branch} ${onePath}:1-2`);
		expect(plain).toContain(`${themeModule.theme.tree.branch} ${twoPath}:3-4`);
		expect(plain).toContain(`${themeModule.theme.tree.last} ${threePath}:5-6`);
	});

	it("merges multi-range selectors into one file row", () => {
		const component = new ReadToolGroupComponent();
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: `${examplePath}:5-10,20-30` }, "read-ranges");
		component.updateResult({ content: [{ type: "text", text: "ranges" }] }, false, "read-ranges");

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain(`Read ${examplePath}:5-10,20-30`);
		expect(plain).not.toContain("Read (2)");
		expect(plain).not.toContain("full file");
	});

	it("merges repeated same-file ranges and truncates long selector lists", () => {
		const component = new ReadToolGroupComponent();
		const renderPath = path.resolve("/tmp/render.ts");
		component.updateArgs({ path: `${renderPath}:507-605` }, "read-one");
		component.updateArgs({ path: `${renderPath}:1070-1194,1210-1240,1270-1274` }, "read-more");
		component.updateResult({ content: [{ type: "text", text: "one" }] }, false, "read-one");
		component.updateResult({ content: [{ type: "text", text: "more" }] }, false, "read-more");

		const plain = Bun.stripANSI(component.render(120).join("\n"));
		const pathMatches = plain.split(renderPath).length - 1;

		expect(pathMatches).toBe(1);
		expect(plain).toContain(`${renderPath}:507-605,1070-1194,…,1270-1274`);
		expect(plain).not.toContain("1210-1240");
	});

	it("uses result-provided recovered targets for delimited reads", () => {
		const component = new ReadToolGroupComponent();
		const onePath = path.resolve("/tmp/one.ts");
		const twoPath = path.resolve("/tmp/two.ts");
		component.updateArgs({ path: `${onePath} ${twoPath}` }, "read-recovered");
		component.updateResult(
			{
				content: [{ type: "text", text: "combined" }],
				details: { displayReadTargets: [onePath, twoPath] },
			},
			false,
			"read-recovered",
		);

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain("Read (2)");
		expect(plain).toContain(`${themeModule.theme.tree.branch} ${onePath}`);
		expect(plain).toContain(`${themeModule.theme.tree.last} ${twoPath}`);
	});

	it("renders warning previews with warning styling instead of success styling", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: examplePath }, "read-1");
		component.updateResult(
			{
				content: [{ type: "text", text: "const a = 1;\nconst b = 2;\nconst c = 3;" }],
				details: { suffixResolution: { from: path.resolve("/tmp/exampl.ts"), to: examplePath } },
			},
			false,
			"read-1",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(rendered).toContain(themeModule.theme.status.warning);
		expect(rendered).not.toContain(themeModule.theme.status.success);
		expect(rendered).toContain("corrected from");
	});

	it("highlights only the collapsed preview lines", () => {
		const highlightSpy = vi.spyOn(themeModule, "highlightCode");
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: examplePath }, "read-2");
		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: "line 1\nline 2\nline 3\nline 4\nline 5",
					},
				],
			},
			false,
			"read-2",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		const highlightedInput = highlightSpy.mock.calls[0]?.[0];

		expect(highlightedInput).toBe("line 1\nline 2\nline 3");
		expect(rendered).toContain("line 1");
		expect(rendered).not.toContain("line 4");
		expect(rendered.toLowerCase()).toContain("ctrl+o");
	});

	it("does not render a duplicate summary row when inline previews are enabled", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: `${examplePath}:L10-L20` }, "read-3");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4" }],
			},
			false,
			"read-3",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		const matches = rendered.split(`Read ${examplePath}:L10-L20`).length - 1;

		expect(matches).toBe(1);
	});

	it("keeps usage below an inline preview when the summary row is suppressed", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		const examplePath = path.resolve("/tmp/example.ts");
		component.updateArgs({ path: examplePath }, "read-preview");
		component.updateResult({ content: [{ type: "text", text: "line 1\nline 2" }] }, false, "read-preview");
		component.attachUsage(
			["read-preview"],
			{
				input: 1234,
				output: 7,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1241,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			1000,
			500,
			new Date(2026, 0, 2, 3, 4, 5).getTime(),
		);

		const lines = Bun.stripANSI(component.render(120).join("\n")).split("\n");
		const previewIndex = lines.findIndex(line => line.includes("line 2"));
		const usageIndices = lines
			.map((line, index) => (line.includes("2026-01-02 03:04:05") ? index : -1))
			.filter(index => index >= 0);
		expect(usageIndices).toHaveLength(1);
		expect(usageIndices[0]).toBeGreaterThan(previewIndex);
	});

	it("links grouped summary paths to resolved filesystem paths and selector lines", () => {
		settings.override("tui.hyperlinks", "always");
		const component = new ReadToolGroupComponent();
		const examplePath = path.resolve("/workspace/src/example.ts");
		component.updateArgs({ path: "src/example.ts:7-9" }, "read-link");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 7" }],
				details: { meta: { source: { type: "path", value: examplePath } } },
			},
			false,
			"read-link",
		);

		const rendered = component.render(120).join("\n");

		const exampleUri = new URL(url.pathToFileURL(path.resolve(examplePath)).href);
		exampleUri.searchParams.set("line", "7");
		expect(Bun.stripANSI(rendered)).toContain("Read src/example.ts:7-9");
		expect(extractLinkUris(rendered)).toContain(exampleUri.href);
		expect(extractLinkTexts(rendered)).toContain("src/example.ts");
		expect(extractLinkTexts(rendered)).not.toContain("src/example.ts:7-9");
	});

	it("links inline preview titles when the summary row is suppressed", () => {
		settings.override("tui.hyperlinks", "always");
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		const previewPath = path.resolve("/workspace/src/preview.ts");
		component.updateArgs({ path: "src/preview.ts:20-22" }, "read-preview-link");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 20\nline 21\nline 22" }],
				details: { resolvedPath: previewPath },
			},
			false,
			"read-preview-link",
		);

		const rendered = component.render(120).join("\n");

		const previewUri = new URL(url.pathToFileURL(path.resolve(previewPath)).href);
		previewUri.searchParams.set("line", "20");
		expect(Bun.stripANSI(rendered)).toContain("Read src/preview.ts:20-22");
		expect(extractLinkUris(rendered)).toContain(previewUri.href);
		expect(extractLinkTexts(rendered)).toContain("src/preview.ts");
		expect(extractLinkTexts(rendered)).not.toContain("src/preview.ts:20-22");
	});
});

describe("readArgsCollapseIntoGroup", () => {
	it.each([
		["skill://my-skill"],
		["skill://my-skill/file.md"],
		["omp://docs/tools/read.md"],
		["issue://123"],
		["pr://can1357/oh-my-pi/456"],
		["agent://abc"],
		["artifact://abc"],
		["memory://root"],
		["rule://name"],
		["mcp://server/resource"],
		["local://PLAN.md"],
	])("keeps %s as a full tool execution (not grouped)", target => {
		expect(readArgsCollapseIntoGroup({ path: target })).toBe(false);
		expect(readArgsCollapseIntoGroup({ file_path: target })).toBe(false);
	});

	it.each([
		[path.resolve("/tmp/example.ts")],
		["./relative/path.md"],
		["https://example.com/file"],
		["xd://"],
		["xd://generate_image"],
	])("collapses %s into the read group", target => {
		expect(readArgsCollapseIntoGroup({ path: target })).toBe(true);
		expect(readArgsCollapseIntoGroup({ file_path: target })).toBe(true);
	});

	it("returns false for non-record / missing arguments", () => {
		expect(readArgsCollapseIntoGroup(undefined)).toBe(false);
		expect(readArgsCollapseIntoGroup(null)).toBe(false);
		expect(readArgsCollapseIntoGroup("xd://x")).toBe(false);
		expect(readArgsCollapseIntoGroup(["xd://x"])).toBe(false);
		expect(readArgsCollapseIntoGroup({})).toBe(false);
		expect(readArgsCollapseIntoGroup({ path: 42 })).toBe(false);
	});
});
