import { afterEach, describe, expect, it } from "bun:test";
import { setMarkdownLook } from "@oh-my-pi/pi-tui/text/markdown/look";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { sectionRows } from "../../../../src/ui/overlays/panels/plan-review-frame";
import { ensureTheme } from "../../../../src/ui/theme/service";

describe("plan review section rows", () => {
	afterEach(() => setMarkdownLook({ colorful: true, mermaid: true, linkUrls: true }));

	it("redraws a section's code block when tui.codeFrame flips, instead of serving the rows cached for the old look", () => {
		ensureTheme();
		const theme = currentTheme();
		const raw = "```ts\nconst x = 1;\n```\n";
		const rows = (): string[] => sectionRows(raw, 40, theme).map(row => Bun.stripANSI(row));

		expect(rows().some(row => row.includes("```ts"))).toBe(true);

		setMarkdownLook({ colorful: true, mermaid: true, linkUrls: true, codeFrame: true });
		const framed = rows();
		expect(framed.some(row => row.includes("```"))).toBe(false);
		expect(framed.some(row => row.includes("╌╌ ts ╌"))).toBe(true);

		setMarkdownLook({ colorful: true, mermaid: true, linkUrls: true, codeFrame: false });
		expect(rows().some(row => row.includes("```ts"))).toBe(true);
	});
});
