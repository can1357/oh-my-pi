import { beforeAll, describe, expect, test } from "bun:test";
import {
	type EditRenderContext,
	editToolRenderer,
	type PerFileDiffPreview,
} from "@oh-my-pi/pi-coding-agent/edit/renderer";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

let uiTheme: themeModule.Theme;

beforeAll(async () => {
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	const loaded = await themeModule.getThemeByName("dark");
	if (!loaded) throw new Error("dark test theme is unavailable");
	uiTheme = loaded;
});

function render(previews: PerFileDiffPreview[]): string {
	const renderContext: EditRenderContext = { editMode: "apply_patch", perFileDiffPreview: previews };
	return Bun.stripANSI(
		editToolRenderer
			.renderCall({}, { expanded: false, isPartial: true, spinnerFrame: 0, renderContext }, uiTheme)
			.render(160)
			.join("\n"),
	);
}

describe("apply_patch streaming preview renderer", () => {
	test("renders each file from structured per-file diff previews", () => {
		const rendered = render([
			{ path: "src/a.ts", diff: "@@ -1,1 +1,1 @@\n-1|old a\n+1|new a", firstChangedLine: 1 },
			{ path: "src/b.ts", diff: "@@ -2,1 +2,1 @@\n-2|old b\n+2|new b", firstChangedLine: 2 },
		]);

		expect(rendered).toContain("src/a.ts");
		expect(rendered).toContain("new a");
		expect(rendered).toContain("src/b.ts");
		expect(rendered).toContain("new b");
	});

	test("renders a structured per-file preview error beside successful siblings", () => {
		const rendered = render([
			{ path: "src/good.ts", diff: "@@ -1,1 +1,1 @@\n-1|old\n+1|new", firstChangedLine: 1 },
			{ path: "src/missing.ts", error: "File not found: src/missing.ts" },
		]);

		expect(rendered).toContain("src/good.ts");
		expect(rendered).toContain("new");
		expect(rendered).toContain("src/missing.ts");
		expect(rendered).toContain("File not found: src/missing.ts");
	});
});
