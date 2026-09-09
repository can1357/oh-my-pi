import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { renderStatusLine } from "@oh-my-pi/pi-coding-agent/tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";

beforeAll(async () => {
	await initTheme();
});

describe("renderStatusLine", () => {
	it("flattens newlines in description so a tool cannot break the header", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		expect(uiTheme).toBeDefined();
		const rendered = sanitizeText(
			renderStatusLine(
				{ icon: "success", title: "SSH", description: "[router] $ set -e\ncat > /etc/apt/sources.list" },
				uiTheme,
			),
		);
		expect(rendered).not.toContain("\n");
		expect(rendered).toContain("[router]");
		expect(rendered).toContain("set -e");
		expect(rendered).toContain("cat > /etc/apt/sources.list");
	});

	it("flattens newlines in meta entries", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		expect(uiTheme).toBeDefined();
		const rendered = sanitizeText(
			renderStatusLine({ icon: "success", title: "X", meta: ["first\nsecond", "third"] }, uiTheme),
		);
		expect(rendered).not.toContain("\n");
		expect(rendered).toContain("first second");
		expect(rendered).toContain("third");
	});

	it("flattens CRLF the same way as LF", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		expect(uiTheme).toBeDefined();
		const rendered = sanitizeText(
			renderStatusLine({ icon: "success", title: "X", description: "a\r\nb\rc" }, uiTheme),
		);
		expect(rendered).not.toContain("\r");
		expect(rendered).not.toContain("\n");
		expect(rendered).toContain("a b c");
	});
});
