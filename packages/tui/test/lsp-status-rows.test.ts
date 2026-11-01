import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "../src/theme";
import { lspToolRenderer } from "../src/tools/lsp";

let theme: Theme;

beforeAll(async () => {
	theme = (await getThemeByName("dark"))!;
	setThemeInstance(theme);
});

function renderRequestResult(text: string): string {
	return lspToolRenderer
		.renderResult({ content: [{ type: "text", text }] }, { expanded: false, isPartial: false }, theme, {
			action: "request",
		})
		.render(100)
		.map(row => Bun.stripANSI(row))
		.join("\n");
}

describe("LSP status rows", () => {
	// A status glyph can be plain text (ASCII `[-]`), so only a row that starts with one is a status row.
	it("keeps a response that mentions the error glyph mid-line as a response, not diagnostics", () => {
		const text = renderRequestResult(`{"items": ["a ${theme.status.error} b"]}\nsecond line`);

		expect(text).not.toContain("No issues");
		expect(text).toContain(`{"items": ["a ${theme.status.error} b"]}`);
		expect(text).toContain("second line");
	});
});
