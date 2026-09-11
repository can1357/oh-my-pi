import { describe, expect, it } from "bun:test";
import { formatTaskResultSummary } from "@oh-my-pi/pi-coding-agent/task/result-summary";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";

function settledResult(output: string): SingleResult {
	return {
		index: 0,
		id: "Scout",
		agent: "scout",
		agentSource: "bundled",
		task: "audit",
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 1200,
		tokens: 10,
		requests: 2,
		outputPath: "/tmp/Scout.md",
		outputMeta: {
			lineCount: output.split("\n").length,
			charCount: output.length,
		},
	};
}

describe("formatTaskResultSummary", () => {
	it("previews a pretty-printed structured yield past its opening brace", () => {
		// A schema-bearing subagent's artifact is `JSON.stringify(data, null, 2)`:
		// the first line is `{` and the second is one multi-KB string. Cutting the
		// preview at the last newline inside the budget used to leave the parent
		// with a lone `{` and no idea what the child found.
		const report = "# Port table\n\n| tool | file |\n|---|---|\n".repeat(400);
		const output = JSON.stringify({ summary: "Audit of 37 tools", report }, null, 2);
		const summary = formatTaskResultSummary(settledResult(output), {
			totalDurationMs: 1200,
		});

		expect(summary).toContain('<preview full-output="agent://Scout">');
		const preview = /<preview[^>]*>\n([\s\S]*?)\n<\/preview>/.exec(summary)?.[1] ?? "";
		expect(preview).toContain('"summary": "Audit of 37 tools"');
		expect(preview.length).toBeGreaterThan(2000);
		expect(preview.length).toBeLessThanOrEqual(5000);
	});

	it("keeps a markdown preview on a line boundary when one is in range", () => {
		const lines = Array.from({ length: 400 }, (_, i) => `- item ${i} ${"x".repeat(20)}`);
		const summary = formatTaskResultSummary(settledResult(lines.join("\n")), {
			totalDurationMs: 5,
		});
		const preview = /<preview[^>]*>\n([\s\S]*?)\n<\/preview>/.exec(summary)?.[1] ?? "";
		expect(preview.endsWith("\n")).toBe(false);
		expect(lines).toContain(preview.split("\n").at(-1) ?? "");
	});

	it("inlines short output without an artifact pointer", () => {
		const summary = formatTaskResultSummary(settledResult("done"), {
			totalDurationMs: 5,
		});
		expect(summary).toContain("<output>\ndone\n</output>");
		expect(summary).not.toContain("<preview");
	});
});
