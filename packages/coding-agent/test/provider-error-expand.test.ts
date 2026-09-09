import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});

function longError(n: number): string {
	return Array.from({ length: n }, (_, i) => `provider error detail line ${i}`).join("\n");
}

function makeErr(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "error",
		errorMessage,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("provider error expand", () => {
	it("wraps a long single-line error across rows instead of cutting it at a fixed column", () => {
		// Regression: a 200-cell body was cut at 110 cells with no expand hint,
		// leaving the tail unreachable even on a wide terminal.
		const body = `400 ${JSON.stringify({
			error: {
				message: "The requested model is not supported.",
				code: "model_not_supported",
				param: "model",
				type: "invalid_request_error",
			},
		})}\nraw-http-request=/home/user/.omp/logs/http-400-requests/1756800000000-abc123.json`;
		const component = new AssistantMessageComponent(makeErr(body));

		const rows = Bun.stripANSI(component.render(80).join("\n"))
			.split("\n")
			.filter(row => row.trim().length > 0);
		expect(rows[0]).toMatch(/^ Error: 400 /);
		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(80);
		const joined = rows.map(row => row.trim()).join("");
		expect(joined).toContain('"type":"invalid_request_error"}}');
		expect(joined).toContain("raw-http-request=/home/user/.omp/logs/http-400-requests/1756800000000-abc123.json");
		expect(joined).not.toContain("more line");
	});

	it("clamps a huge single-line error to the row budget with an expand hint", () => {
		const component = new AssistantMessageComponent(makeErr(`502 ${"<p>Bad Gateway</p> ".repeat(200)}`));

		const collapsed = Bun.stripANSI(component.render(100).join("\n"));
		const bodyRows = collapsed.split("\n").filter(row => row.includes("<p>"));
		expect(bodyRows.length).toBe(8);
		expect(collapsed).toMatch(/\+\d+ more lines \(.+ to expand\)/);

		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(100).join("\n"));
		expect(expanded.split("\n").filter(row => row.includes("<p>")).length).toBeGreaterThan(8);
		expect(expanded).not.toMatch(/more lines/);
	});

	it("caps a long error collapsed and reveals the full body when expanded", () => {
		const component = new AssistantMessageComponent(makeErr(longError(30)));

		const collapsed = Bun.stripANSI(component.render(120).join("\n"));
		const shown = collapsed.match(/provider error detail line \d+/g) ?? [];
		expect(shown.length).toBe(8);
		expect(collapsed).not.toContain("provider error detail line 29");
		expect(collapsed).toMatch(/\+22 more lines/);

		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(120).join("\n"));
		const shownExpanded = expanded.match(/provider error detail line \d+/g) ?? [];
		expect(shownExpanded.length).toBe(30);
		expect(expanded).toContain("provider error detail line 0");
		expect(expanded).toContain("provider error detail line 29");
		expect(expanded).not.toMatch(/more lines/);

		component.setExpanded(false);
		const recollapsed = Bun.stripANSI(component.render(120).join("\n"));
		expect(recollapsed).not.toContain("provider error detail line 29");
	});

	it("reveals the full body inline when expanded while the error is pinned", () => {
		const component = new AssistantMessageComponent(makeErr(longError(30)));

		// The banner above the editor mirrors the error, so the inline block is
		// suppressed while pinned (EventController does this at message_end).
		component.setErrorPinned(true);
		const pinned = Bun.stripANSI(component.render(120).join("\n"));
		expect(pinned).not.toContain("provider error detail line 0");

		// Ctrl+O while pinned must still reach the full body inline.
		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(120).join("\n"));
		const shown = expanded.match(/provider error detail line \d+/g) ?? [];
		expect(shown.length).toBe(30);
		expect(expanded).toContain("provider error detail line 29");

		// Collapsing again re-suppresses the pinned inline error.
		component.setExpanded(false);
		const recollapsed = Bun.stripANSI(component.render(120).join("\n"));
		expect(recollapsed).not.toContain("provider error detail line 0");
	});
});
