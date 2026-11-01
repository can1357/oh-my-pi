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
	// A status glyph can be plain text (ASCII `[-]`), and a `request` response is the server's text
	// verbatim, so only the diagnostics action's rows that start with a glyph are status rows.
	it("keeps a response that mentions the error glyph mid-line as a response, not diagnostics", () => {
		const text = renderRequestResult(`{"items": ["a ${theme.status.error} b"]}\nsecond line`);

		expect(text).not.toContain("No issues");
		expect(text).toContain(`{"items": ["a ${theme.status.error} b"]}`);
		expect(text).toContain("second line");
	});

	it("keeps a request response whose line starts with the error glyph as a response", () => {
		const text = renderRequestResult(`server ← custom/method:\n${theme.status.error} literal\nkeep-me`);

		expect(text).not.toContain("No issues");
		expect(text).toContain(`${theme.status.error} literal`);
		expect(text).toContain("keep-me");
	});
});
