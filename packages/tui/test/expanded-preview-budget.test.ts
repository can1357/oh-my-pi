/**
 * Expanded IRC previews soft-wrap to the card instead of clipping at a fixed
 * column cap, and every clipped preview advertises the key that reveals what it
 * hid. The budget alone is not enough: a card narrower than the fixed cap clips
 * rows the cap never sees, and a silent clip reads as if the body ended there.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { renderAgentWrite, renderProcRead, renderProcWrite } from "@oh-my-pi/pi-tui/tools/proc-render";
import { createIrcMessageCard, waitToolRenderer } from "@oh-my-pi/pi-tui/tools/wait";
import { expandKeyHint, PREVIEW_LIMITS } from "@oh-my-pi/pi-tui/render/render-utils";

describe("expanded preview line budget", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("wraps an expanded outgoing agent write to the card width and keeps the line budget", () => {
		// Twenty long lines: the expanded budget keeps twelve, and each kept line
		// soft-wraps instead of being clipped at the fixed 110-column cap.
		const body = Array.from({ length: 20 }, (_, index) => `${"word ".repeat(30)}END-${index}`).join("\n");
		const component = renderAgentWrite(
			"peer",
			body,
			undefined,
			undefined,
			{ expanded: true, isPartial: false },
			theme,
		);
		const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
		expect(output).toContain(`+${20 - PREVIEW_LIMITS.EXPANDED_LINES} more lines`);
		// The tail sentinel of the first kept line survives the wrap; the
		// thirteenth source line is outside the budget.
		expect(output).toContain("END-0");
		expect(output).toContain("END-11");
		expect(output).not.toContain("END-12");
	});

	it("wraps an expanded outgoing agent write to a narrow card width", () => {
		const longLine = "word ".repeat(40).trim();
		const component = renderAgentWrite(
			"peer",
			longLine,
			undefined,
			undefined,
			{ expanded: true, isPartial: false },
			theme,
		);
		const lines = component.render(60) as readonly string[];
		for (const line of lines) expect(Bun.stringWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(60);
		const words = Bun.stripANSI(lines.join("\n"))
			.split(/\s+/)
			.filter(w => w === "word");
		expect(words).toHaveLength(40);
	});

	it("shows the expand hint when a collapsed card is cut by the card width", () => {
		// One long line has no hidden lines: only the card's own width clips it,
		// below the 100/110-column caps the previews truncate at.
		const longLine = "cut ".repeat(30).trim();
		const previews = [
			renderAgentWrite("peer", longLine, undefined, undefined, { expanded: false, isPartial: false }, theme),
			createIrcMessageCard({ kind: "incoming", from: "Peer", body: longLine }, () => false, theme),
			waitToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: { op: "wait", waited: [{ id: "1", from: "Peer", to: "Main", body: longLine, ts: Date.now() }] },
				},
				{ expanded: false, isPartial: false },
				theme,
			),
		];
		for (const preview of previews) {
			const output = Bun.stripANSI((preview.render(90) as readonly string[]).join("\n"));
			for (const line of output.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(90);
			expect(output).toContain("…");
			expect(output).toContain(`${expandKeyHint()}: Expand`);
		}
		// A row that fits is not advertised as expandable.
		const shortOutput = Bun.stripANSI(
			(
				createIrcMessageCard({ kind: "incoming", from: "Peer", body: "short" }, () => false, theme).render(
					90,
				) as readonly string[]
			).join("\n"),
		);
		expect(shortOutput).not.toContain("Expand");
	});

	it("names the hidden lines of a collapsed preview that passes no card width", () => {
		// The stdin write, the job log and the plain result fallback all render
		// through the width-less path, so none of them may hide lines silently.
		const body = Array.from({ length: 20 }, (_, index) => `payload line ${index}`).join("\n");
		const job = { id: "job-1", type: "bash" as const, status: "completed" as const, label: "job-1", durationMs: 10 };
		const previews = [
			renderProcWrite("job-1", "stdin", body, undefined, undefined, { expanded: false, isPartial: false }, theme),
			renderProcRead(
				"job-1",
				{ content: [{ type: "text", text: "ok" }] },
				{ job, log: body },
				{ expanded: false, isPartial: false },
				theme,
			),
			renderProcRead(
				"job-1",
				{ content: [{ type: "text", text: body }] },
				undefined,
				{ expanded: false, isPartial: false },
				theme,
			),
		];
		for (const preview of previews) {
			const output = Bun.stripANSI((preview.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("more lines");
			expect(output).toContain(`${expandKeyHint()}: Expand`);
		}
	});
});
