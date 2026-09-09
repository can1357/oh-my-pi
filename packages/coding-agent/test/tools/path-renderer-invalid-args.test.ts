import { beforeAll, describe, expect, it } from "bun:test";
import { editToolRenderer } from "@oh-my-pi/pi-coding-agent/edit/renderer";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { readToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/read";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { Component } from "@oh-my-pi/pi-tui";

interface InvalidPathCase {
	readonly name: string;
	readonly path: unknown;
}

const invalidPathCases: readonly InvalidPathCase[] = [
	{ name: "array path", path: ["src/example.ts"] },
	{ name: "object path", path: { value: "src/example.ts" } },
];

let uiTheme: Theme;

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme missing");
	uiTheme = theme;
});

function renderPlain(component: Component, width = 120): string {
	let rendered = "";
	expect(() => {
		rendered = Bun.stripANSI(component.render(width).join("\n"));
	}).not.toThrow();
	return rendered;
}

describe("tool path renderers with invalid provider arguments", () => {
	for (const invalid of invalidPathCases) {
		it(`read renderer does not throw for ${invalid.name}`, () => {
			let callComponent: Component | undefined;
			expect(() => {
				callComponent = readToolRenderer.renderCall(
					{ path: invalid.path },
					{ expanded: false, isPartial: true },
					uiTheme,
				);
			}).not.toThrow();
			expect(renderPlain(callComponent!)).toContain("Read");

			let resultComponent: Component | undefined;
			expect(() => {
				resultComponent = readToolRenderer.renderResult(
					{
						content: [{ type: "text", text: "hello from read" }],
						details: {
							displayContent: { text: "hello from read", startLine: 1 },
							contentType: "text/plain",
						},
					},
					{ expanded: false, isPartial: false },
					uiTheme,
					{ path: invalid.path },
				);
			}).not.toThrow();
			const rendered = renderPlain(resultComponent!);
			expect(rendered).toContain("Read");
			expect(rendered).toContain("hello from read");
		});

		it(`write renderer does not throw for ${invalid.name}`, () => {
			let callComponent: Component | undefined;
			expect(() => {
				callComponent = writeToolRenderer.renderCall(
					{ path: invalid.path, content: "first line\nsecond line" },
					{ expanded: false, isPartial: true, spinnerFrame: 0 },
					uiTheme,
				);
			}).not.toThrow();
			const callText = renderPlain(callComponent!);
			expect(callText).toContain("Write");
			expect(callText).toContain("second line");

			let resultComponent: Component | undefined;
			expect(() => {
				resultComponent = writeToolRenderer.renderResult(
					{
						content: [{ type: "text", text: "Wrote file" }],
						details: { resolvedPath: "/tmp/example.ts" },
					},
					{ expanded: false, isPartial: false },
					uiTheme,
					{ path: invalid.path, content: "first line\nsecond line" },
				);
			}).not.toThrow();
			const resultText = renderPlain(resultComponent!);
			expect(resultText).toContain("Write");
			expect(resultText).toContain("first line");
		});

		it(`edit renderer does not throw for ${invalid.name}`, () => {
			let callComponent: Component | undefined;
			expect(() => {
				callComponent = editToolRenderer.renderCall(
					{ path: invalid.path, oldText: "before", newText: "after" },
					{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "replace" } },
					uiTheme,
				);
			}).not.toThrow();
			expect(renderPlain(callComponent!)).toContain("Edit");

			let resultComponent: Component | undefined;
			expect(() => {
				resultComponent = editToolRenderer.renderResult(
					{
						content: [{ type: "text", text: "updated" }],
						details: { diff: "-before\n+after" },
					},
					{ expanded: false, isPartial: false, renderContext: { editMode: "replace" } },
					uiTheme,
					{ path: invalid.path, oldText: "before", newText: "after" },
				);
			}).not.toThrow();
			const rendered = renderPlain(resultComponent!);
			expect(rendered).toContain("Edit");
			expect(rendered).toContain("after");
		});
	}
});
