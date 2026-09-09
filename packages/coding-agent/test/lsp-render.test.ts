import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { renderResult } from "@oh-my-pi/pi-coding-agent/lsp/render";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LSP render", () => {
	it("renders hover code through the cached theme highlighter", () => {
		const highlightSpy = vi.spyOn(themeModule, "highlightCode").mockReturnValue(["CACHED_HIGHLIGHT"]);
		const component = renderResult(
			{ content: [{ type: "text", text: "```ts\nconst value = 1;\n```" }] },
			{ expanded: true, isPartial: false },
			themeModule.theme,
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(highlightSpy).toHaveBeenCalledTimes(1);
		expect(highlightSpy).toHaveBeenCalledWith("const value = 1;", "ts", themeModule.theme);
		expect(rendered).toContain("CACHED_HIGHLIGHT");
	});
});
