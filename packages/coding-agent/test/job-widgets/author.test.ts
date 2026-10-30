import { describe, expect, it } from "bun:test";
import { buildPromptSources, redactWidgetSample, renderJobWidgetPrompt } from "../../src/job-widgets";

const TOKEN = "ghp_Abcdefghijklmnopqrstuvwxyz0123456789AB";

describe("job widget author prompt", () => {
	it("never sends a credential in the brief or the samples to the author model", () => {
		const text = renderJobWidgetPrompt(
			{
				jobId: "bg_1",
				brief: { kind: "bash", command: `GH_TOKEN=${TOKEN} ./bench.sh | tail -5` },
				sources: [
					{
						id: "pipe:1",
						label: "./bench.sh → tail -5",
						size: 120,
						lines: 2,
						head: [`auth ${TOKEN}`, "req 1 rps=40"],
						tail: [],
					},
				],
			},
			line => redactWidgetSample(line),
		);
		expect(text).not.toContain(TOKEN);
		expect(text).toContain("req 1 rps=40");
	});

	it("keeps three lines of each shape in the head and the tail, so repeated progress lines do not crowd out the rest", () => {
		const progress = (from: number, count: number) =>
			Array.from(
				{ length: count },
				(_, index) => `step ${from + index}/1000 | loss ${(2 / (from + index)).toFixed(4)}`,
			);
		const [source] = buildPromptSources(
			[
				{
					id: "out",
					label: "out",
					size: 1,
					lines: 400,
					head: ["loading model", ...progress(1, 29)],
					tail: [...progress(300, 30), "[eval] step 330 val_loss 0.2100", ...progress(331, 29)],
				},
			],
			line => line,
		);
		expect(source.head).toEqual(["loading model", ...progress(1, 3)]);
		// The tail keeps the newest of each shape, oldest first, and the one-off eval line.
		expect(source.tail).toEqual(["[eval] step 330 val_loss 0.2100", ...progress(357, 3)]);
		expect(source.omitted).toBe(400 - 4 - 4);
	});

	it("caps samples at 12 KB, sharing the budget across sources and keeping each source's newest lines", () => {
		const long = (prefix: string, count: number) =>
			Array.from({ length: count }, (_, index) => `${prefix} ${index} ${"x".repeat(400)}`);
		const sources = buildPromptSources(
			[
				{ id: "out", label: "out", size: 1, lines: 500, head: long("head", 30), tail: long("tail", 60) },
				{ id: "pipe:1", label: "p", size: 1, lines: 3, head: ["a", "b", "c"], tail: [] },
			],
			line => line,
		);
		const bytes = sources
			.flatMap(source => [...source.head, ...source.tail])
			.reduce((sum, line) => sum + line.length + 1, 0);
		expect(bytes).toBeLessThanOrEqual(12 * 1024);
		// Lines are cut at 300 chars.
		expect(Math.max(...sources[0].head.map(line => line.length))).toBe(300);
		// The busy source's share ends on its newest line; the quiet source still gets all of its lines.
		expect(sources[0].tail.at(-1)?.startsWith("tail 59 ")).toBe(true);
		expect(sources[1].head).toEqual(["a", "b", "c"]);
	});
});
