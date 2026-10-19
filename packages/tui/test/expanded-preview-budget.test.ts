/**
 * Expanded previews keep their own line budget. Both preview builders dropped it
 * for the expanded case, so Ctrl+O on a long log or a multi-line agent message
 * pushed the whole body into the transcript instead of the capped view the
 * collapsed card promises. The elision marker that names the hidden lines must
 * survive too: a preview that cuts lines without saying so reads as if the body
 * ended there.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { renderProcRead, renderProcWrite } from "@oh-my-pi/pi-tui/tools/proc-render";
import { createIrcMessageCard, waitToolRenderer } from "@oh-my-pi/pi-tui/tools/wait";
import { PREVIEW_LIMITS } from "@oh-my-pi/pi-tui/render/render-utils";

describe("expanded preview line budget", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("caps an expanded proc/job card at EXPANDED_LINES and reports the elision", () => {
		// The job branch of renderProcRead calls its preview with no width, which is
		// the path that lost the budget. Each row below is short enough to survive
		// the card's column cap, so a missing budget shows up as extra rows rather
		// than as truncation.
		const log = Array.from({ length: 40 }, (_, index) => `logline-${index}`);
		const component = renderProcRead(
			"job-1",
			{ content: [{ type: "text", text: "ok" }] },
			{
				job: { id: "job-1", type: "bash", status: "completed", label: "job-1", durationMs: 10 },
				log: log.join("\n"),
			},
			{ expanded: true, isPartial: false },
			theme,
		);
		const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
		const shown = log.filter(line => output.includes(line));
		expect(shown).toHaveLength(PREVIEW_LIMITS.EXPANDED_LINES);
		expect(shown[0]).toBe("logline-0");
		// The cap is silent without the marker: the card then reads as if the log
		// had only twelve lines.
		expect(output).toContain(`+${log.length - PREVIEW_LIMITS.EXPANDED_LINES} more lines`);
	});

	it("caps an expanded agent message body at EXPANDED_LINES while still wrapping it", () => {
		const body = Array.from({ length: 30 }, (_, index) => `message line ${index}`).join("\n");
		const component = waitToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: { op: "wait", waited: { id: "7", from: "Peer", to: "Main", body, ts: Date.now() } },
			},
			{ expanded: true, isPartial: false },
			theme,
		);
		const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
		const shown = body.split("\n").filter(line => output.includes(line));
		expect(shown).toHaveLength(PREVIEW_LIMITS.EXPANDED_LINES);
		expect(output).toContain(`+${30 - PREVIEW_LIMITS.EXPANDED_LINES} more lines`);
	});

	it("still soft-wraps a long single expanded body line to the card width", () => {
		// The wrapping this PR added has to survive the budget: one long line is one
		// source line, so it wraps instead of counting against the budget.
		const component = createIrcMessageCard(
			{ kind: "incoming", from: "Peer", body: "word ".repeat(40).trim() },
			() => true,
			theme,
		);
		const lines = component.render(120) as readonly string[];
		const stripped = lines.map(line => Bun.stripANSI(line));
		const bodyLines = stripped.filter(line => line.includes("word"));
		expect(bodyLines.length).toBeGreaterThanOrEqual(2);
		expect(
			bodyLines
				.join(" ")
				.split(/\s+/)
				.filter(w => w === "word"),
		).toHaveLength(40);
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
		}
	});
});
