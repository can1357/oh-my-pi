import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { TERMINAL, setTerminalHyperlinks } from "@oh-my-pi/pi-tui";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import { writeToolRenderer } from "@oh-my-pi/pi-tui/tools/write";

const ORIGINAL_HYPERLINKS = TERMINAL.hyperlinks;
const ORIGINAL_TERMINAL_ID = Object.getOwnPropertyDescriptor(TERMINAL, "id");

afterEach(() => {
	applyHyperlinkSetting("auto");
	if (ORIGINAL_TERMINAL_ID) Object.defineProperty(TERMINAL, "id", ORIGINAL_TERMINAL_ID);
	setTerminalHyperlinks(ORIGINAL_HYPERLINKS);
});

describe("pending write path rendering", () => {
	it("links a relative path before the write result exists", async () => {
		applyHyperlinkSetting("always");
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		const relativePath = ".tricky/reports/pending/interval.json";
		const component = writeToolRenderer.renderCall(
			{ path: relativePath, content: '{"status":"pending"}' },
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			uiTheme,
		);
		if (!component) throw new Error("expected a rendered component for a non-xdev write path");

		const rendered = component.render(120).join("\n");
		const target = rendered.match(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/)?.[1];
		expect(target).toBeDefined();
		expect(target).toMatch(/^file:/);
		expect(decodeURIComponent(new URL(target!).pathname)).toEndWith(`/${relativePath}`);
	});

	it("uses the absolute filesystem target in VS Code", async () => {
		applyHyperlinkSetting("always");
		Object.defineProperty(TERMINAL, "id", { value: "vscode", configurable: true });
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		const relativePath = ".tricky/reports/pending/interval.json";
		const component = writeToolRenderer.renderCall(
			{ path: relativePath, content: "ready" },
			{ expanded: false, isPartial: true },
			uiTheme,
		);
		const rendered = component?.render(120).join("\n");
		expect(rendered).toContain(`vscode://file${path.resolve(relativePath)}`);
	});

	it("links archive members, database rows, and home paths to their files", async () => {
		applyHyperlinkSetting("always");
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		for (const [input, containingFile] of [
			["reports.zip:entries/data.json", "reports.zip"],
			["records.sqlite:users:42", "records.sqlite"],
			["~/notes/todo.md", path.join(os.homedir(), "notes/todo.md")],
		]) {
			const component = writeToolRenderer.renderCall(
				{ path: input, content: "ready" },
				{ expanded: false, isPartial: true },
				uiTheme,
			);
			const target = component
				?.render(120)
				.join("\n")
				.match(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/)?.[1];
			expect(target).toBeDefined();
			expect(decodeURIComponent(new URL(target!).pathname)).toBe(path.resolve(containingFile));
		}
	});

	it("does not link an unfinished streamed path", async () => {
		applyHyperlinkSetting("always");
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		const partial = writeToolRenderer.renderCall(
			{ path: "reports/incom" },
			{ expanded: false, isPartial: true },
			uiTheme,
		);
		expect(partial?.render(120).join("\n")).not.toContain("\x1b]8;");
		const settled = writeToolRenderer.renderCall(
			{ path: "reports/incomplete.txt", content: "" },
			{ expanded: false, isPartial: true },
			uiTheme,
		);
		expect(settled?.render(120).join("\n")).toContain("\x1b]8;");
	});
});
