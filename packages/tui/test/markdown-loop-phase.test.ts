import { describe, expect, it } from "bun:test";
import { Markdown } from "@pk-nerdsaver-ai/pi-tui/components/markdown";
import { currentLoopPhase, takeRecentLoopPhase } from "@pk-nerdsaver-ai/pi-utils";
import { defaultMarkdownTheme } from "./test-themes.js";

describe("Markdown loop-phase attribution", () => {
	it("tags the lex+render path as ui.markdown and pops it afterwards", () => {
		takeRecentLoopPhase();
		const md = new Markdown("# Heading\n\nSome **bold** prose with `code`.", 0, 0, defaultMarkdownTheme);
		const lines = md.render(80);
		expect(lines.length).toBeGreaterThan(0);
		expect(currentLoopPhase()).toBeUndefined();
		expect(takeRecentLoopPhase()).toBe("ui.markdown");
	});

	it("does not enter the phase on an L1 cache hit", () => {
		const md = new Markdown("cached body", 0, 0, defaultMarkdownTheme);
		const first = md.render(80);
		takeRecentLoopPhase();
		const second = md.render(80);
		expect(second).toBe(first);
		expect(takeRecentLoopPhase()).toBeUndefined();
	});
});
