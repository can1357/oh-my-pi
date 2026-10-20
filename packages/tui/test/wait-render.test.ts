/**
 * The job tool's TUI preview must not leak the model-facing `<task-result>`
 * envelope (prompts/tools/task-summary.md): a settled task job previews the
 * inner <output>/<preview> body, while non-envelope result text (bash jobs)
 * passes through unchanged.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { prompt } from "@oh-my-pi/pi-utils";
import taskSummaryTemplate from "../../coding-agent/src/prompts/tools/task-summary.md" with { type: "text" };
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { type CoordinationDetails, createIrcMessageCard, waitToolRenderer } from "@oh-my-pi/pi-tui/tools/wait";
import { decodeBench } from "./fixtures/job-widget-views";

/** Every described node under `children`, depth first. */
function flatten(children: readonly NativeChild[] | undefined): NativeNode[] {
	return (children ?? []).flatMap(child => ("k" in child ? [child, ...flatten(child.c)] : []));
}

/** The first node under `root` with `role`. */
function byRole(root: NativeChild | undefined, role: string): NativeNode | undefined {
	return flatten(root ? [root] : []).find(node => node.p && Reflect.get(node.p, "role") === role);
}

function renderLines(resultText: string): string {
	const result = {
		content: [{ type: "text", text: "" }],
		details: {
			op: "wait" as const,
			jobs: [
				{
					id: "SpawnProbe",
					type: "task" as const,
					status: "completed" as const,
					label: "SpawnProbe",
					durationMs: 8_700,
					resultText,
				},
			],
		},
	};
	const component = waitToolRenderer.renderResult(
		result,
		{ expanded: true } as Parameters<typeof waitToolRenderer.renderResult>[1],
		theme,
	);
	return (component.render(120) as readonly string[]).join("\n");
}

describe("job renderer task-result preview", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders the consumed peer message as a sender card", () => {
		const component = waitToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "[42] Worker: file unlocked" }],
				details: {
					op: "wait",
					waited: { id: "42", from: "Worker", to: "Main", body: "file unlocked", ts: Date.now() },
				},
			},
			{ expanded: true, isPartial: false },
			theme,
		);
		const output = Bun.stripANSI(component.render(120).join("\n"));
		expect(output).toContain("Worker");
		expect(output).toContain("file unlocked");
	});

	it("previews the envelope body, not the wrapper markup", () => {
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: "sonic",
			id: "SpawnProbe",
			status: "completed",
			duration: "8.7s",
			preview: "Probe finished: spawned worker, ping ok.",
			truncated: false,
			meta: { lineCount: 3, charSize: "120 B" },
			mergeSummary: "",
		});
		const deliveryText = `${summary}\n\nSpawnProbe is now idle — message it via \`write agent://SpawnProbe\` to follow up; transcript at history://SpawnProbe`;

		const output = renderLines(deliveryText);
		expect(output).toContain("Probe finished: spawned worker, ping ok.");
		expect(output).not.toContain("<task-result");
		expect(output).not.toContain("<output>");
	});

	it("previews the truncated <preview> body the same way", () => {
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: "task",
			id: "BigOne",
			status: "completed",
			duration: "2m",
			preview: "first line of long output",
			truncated: true,
			mergeSummary: "",
		});

		const output = renderLines(summary);
		expect(output).toContain("first line of long output");
		expect(output).not.toContain("<task-result");
	});

	it("flattens a pretty-printed JSON body instead of previewing a lone brace", () => {
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: "sonic",
			id: "EchoAlpha",
			status: "completed",
			duration: "11.6s",
			preview: '{\n  "echo": "alpha",\n  "ok": true\n}',
			truncated: false,
			mergeSummary: "",
		});

		const output = Bun.stripANSI(renderLines(summary));
		expect(output).toContain('{ "echo": "alpha", "ok": true }');
		expect(output.split("\n").some(line => line.trim() === "{")).toBe(false);
	});

	it("passes non-envelope result text through unchanged", () => {
		const output = renderLines("42 pass, 0 fail (18.4s)");
		expect(output).toContain("42 pass, 0 fail (18.4s)");
	});

	it("drops the id column when the label repeats it", () => {
		// Task jobs label themselves with their agent id; rendering both columns
		// stutters ("SpawnProbe ⟨task⟩ SpawnProbe").
		const output = Bun.stripANSI(renderLines("done"));
		const header = output.split("\n").find(line => line.includes("SpawnProbe"));
		expect(header).toBeDefined();
		expect(header!.match(/SpawnProbe/g)).toHaveLength(1);
	});

	describe("live and sealed waiting snapshots", () => {
		const jobsData = [
			{
				id: "Job1",
				type: "task" as const,
				status: "running" as const,
				label: "Job1 running",
				durationMs: 1200,
			},
			{
				id: "Job2",
				type: "task" as const,
				status: "completed" as const,
				label: "Job2 completed",
				durationMs: 3400,
				resultText: "Job2 result",
			},
			{
				id: "Job3",
				type: "task" as const,
				status: "running" as const,
				label: "Job3 running",
				durationMs: 500,
			},
		];

		it("shows all jobs when isPartial is true", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: jobsData },
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: true } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Job1 running");
			expect(output).toContain("Job2 completed");
			expect(output).toContain("Job3 running");
			expect(output).toContain("waiting on 2 of 3 jobs");
		});

		it("retains running and settled jobs after a poll is sealed", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: jobsData },
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Job1 running");
			expect(output).toContain("Job2 completed");
			expect(output).toContain("Job3 running");
			expect(output).toContain("waiting on 2 of 3 jobs");
		});

		it("retains the worker identity in a sealed all-running poll", () => {
			const runningJobsOnly = [
				{
					id: "Job1",
					type: "task" as const,
					status: "running" as const,
					label: "Job1 running",
					durationMs: 1200,
				},
			];
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: runningJobsOnly },
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const lines = component.render(120) as readonly string[];
			expect(Bun.stripANSI(lines.join("\n"))).toContain("Job1 running");
		});

		it("collapses to one row per settled job instead of re-printing the job tree", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: jobsData },
			};
			const component = waitToolRenderer.renderResult(result, { expanded: false, isPartial: false }, theme);
			const lines = (component.render(120) as readonly string[]).map(line => Bun.stripANSI(line));
			// Job2 settled: one completion row. The running jobs collapse into a count,
			// so the next poll's card does not repeat them.
			expect(lines).toHaveLength(2);
			expect(lines[0]).toContain("Job2 done");
			expect(lines[1]!.trim()).toBe("2 still running");
			expect(lines.join("\n")).not.toContain("waiting on");
		});

		it("keeps the waiting header while nothing has settled", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: [jobsData[0]!, jobsData[2]!] },
			};
			const component = waitToolRenderer.renderResult(result, { expanded: false, isPartial: true }, theme);
			const lines = (component.render(120) as readonly string[]).map(line => Bun.stripANSI(line));
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("waiting on 2 jobs");
		});

		it("keeps a failed job's outcome visible when its id overflows the row", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: {
					op: "wait" as const,
					jobs: [
						{
							id: "long-agent-assignment-identifier-1234567890",
							type: "bash" as const,
							status: "failed" as const,
							label: "make",
							durationMs: 62_000,
							exitCode: 2,
						},
					],
				},
			};
			const component = waitToolRenderer.renderResult(result, { expanded: false, isPartial: false }, theme);
			const [row] = (component.render(40) as readonly string[]).map(line => Bun.stripANSI(line));
			expect(row).toContain("failed · exit 2 · 1m2s");
			expect(Bun.stringWidth(row!)).toBeLessThanOrEqual(40);
		});

		it("retains the running job in the sealed native wait card", () => {
			const result = {
				content: [{ type: "text" as const, text: "Still Running" }],
				details: { op: "wait" as const, jobs: [jobsData[0]] },
			};
			const view = waitToolRenderer.describeResult!(result, { expanded: true, isPartial: false });
			expect(view?.head).toEqual(expect.arrayContaining([expect.objectContaining({ t: "waiting on 1 job" })]));
			// A subagent's tile goes by the subagent's name.
			expect(JSON.stringify(view?.body)).toContain('{"t":"Job1"}');
		});

		it.each([true, false])("animates running native tiles only while the poll is live (%s)", isPartial => {
			const result = {
				content: [{ type: "text" as const, text: "Still Running" }],
				details: {
					op: "wait" as const,
					jobs: [jobsData[0], jobsData[1]],
					agents: [{ id: "Worker", ageMs: 1_000, live: true }],
				},
			};
			const view = waitToolRenderer.describeResult!(result, { expanded: true, isPartial });
			const [strip, agent] = view!.body!;
			expect(strip).toMatchObject({ k: "row", p: { role: "omp.job.tiles" } });
			const [running] = (strip as NativeNode).c ?? [];
			expect(byRole(running, "omp.job.tile.dot")?.p).toMatchObject({
				spans: [isPartial ? { t: "●", fx: "pulse" } : { t: "●" }],
			});
			expect(flatten(byRole(running, "omp.job.tile.head")?.c).find(node => node.k === "elapsed")).toMatchObject({
				p: isPartial ? { age: 1200 } : { age: 1200, stopped: 1200 },
			});
			expect(agent).toMatchObject({
				c: [
					expect.any(Object),
					expect.any(Object),
					{ k: "elapsed", p: isPartial ? { age: 1000 } : { age: 1000, stopped: 1000 } },
				],
			});
			if (!isPartial) expect(JSON.stringify(view)).not.toContain('"fx":"pulse"');
			else {
				expect(JSON.stringify(running)).not.toContain('"stopped"');
				expect(JSON.stringify(agent)).not.toContain('"stopped"');
			}
		});

		it("keeps a settled native job to its tile: output and errors fill the call's own card", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: {
					op: "wait" as const,
					jobs: [
						{
							id: "bg_2",
							type: "bash" as const,
							status: "failed" as const,
							label: "hyperfine --runs 30 bench",
							durationMs: 61_000,
							exitCode: 1,
							resultText: "Benchmark 1: calc_ir",
							errorText: "Command exited with code 1",
							meta: { artifactError: "write" as const },
						},
					],
				},
			};
			const view = waitToolRenderer.describeResult!(result, { expanded: true, isPartial: false });
			const tile = byRole(view!.body![0], "omp.job.tile");
			expect(tile).toMatchObject({ k: "col", p: { tone: "error" } });
			expect(byRole(tile, "omp.job.tile.lead")?.p).toMatchObject({ spans: [{ t: "exit 1", s: "error" }] });
			const json = JSON.stringify(view);
			expect(json).toContain("hyperfine --runs 30 bench");
			expect(json).not.toContain("Benchmark 1");
			expect(json).not.toContain("exited with code 1");
			expect(json).not.toContain("artifact write failed");
		});

		it("keeps a job's artifact capture failure on its collapsed row", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: {
					op: "wait" as const,
					jobs: [
						{
							id: "bg_2",
							type: "bash" as const,
							status: "completed" as const,
							label: "bench",
							durationMs: 1_000,
							meta: { artifactError: "write" as const },
						},
					],
				},
			};
			const component = waitToolRenderer.renderResult(result, { expanded: false, isPartial: false }, theme);
			const lines = (component.render(100) as readonly string[]).map(line => Bun.stripANSI(line));
			expect(lines[0]).toContain("bg_2 done");
			expect(lines[1]).toContain("artifact write failed");
		});

		it("caps a large recovered batch on the collapsed card, failures first", () => {
			const jobs = Array.from({ length: 12 }, (_, i) => ({
				id: `bg_${i}`,
				type: "bash" as const,
				status: i === 11 ? ("failed" as const) : ("completed" as const),
				label: `job ${i}`,
				durationMs: 1_000,
			}));
			const result = { content: [{ type: "text" as const, text: "" }], details: { op: "wait" as const, jobs } };
			const component = waitToolRenderer.renderResult(result, { expanded: false, isPartial: false }, theme);
			const lines = (component.render(100) as readonly string[]).map(line => Bun.stripANSI(line));
			expect(lines).toHaveLength(9);
			expect(lines[0]).toContain("bg_11 failed");
			expect(lines.at(-1)!.trim()).toBe("… 4 more settled");
		});

		it("caps live widget tiles on the collapsed card and counts the rest", () => {
			const jobs = Array.from({ length: 10 }, (_, i) => ({
				id: `bg_${i}`,
				type: "bash" as const,
				status: "running" as const,
				label: `bench ${i}`,
				durationMs: 1_000,
				widget: decodeBench,
			}));
			const result = { content: [{ type: "text" as const, text: "" }], details: { op: "wait" as const, jobs } };
			const component = waitToolRenderer.renderResult(result, { expanded: false, isPartial: false }, theme);
			const text = (component.render(100) as readonly string[]).map(line => Bun.stripANSI(line)).join("\n");
			expect(text).toContain("bg_7");
			expect(text).not.toContain("bg_8");
			expect(text).toContain("2 still running");
		});

		it("renders agent rows for running agents outside job control", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: {
					op: "wait" as const,
					jobs: [],
					agents: [{ id: "Worker", parentId: "Main", activity: "grepping the tree", ageMs: 65_000, live: true }],
				},
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("1 running agent — no jobs");
			expect(output).toContain("Worker");
			expect(output).toContain("grepping the tree");
		});

		it("keeps a sealed bare-poll result visible when it carries an agent roster", () => {
			const result = {
				content: [{ type: "text" as const, text: "No running background jobs to wait for." }],
				details: { op: "wait" as const, jobs: [], agents: [{ id: "Worker", ageMs: 1_000, live: false }] },
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Worker");
			// A ref claiming `running` with no turn in flight is flagged, not shown
			// as live work.
			expect(output).toContain("no turn");
		});
	});

	describe("job widgets", () => {
		const widgetResult = (stage?: string) => ({
			content: [{ type: "text" as const, text: "" }],
			details: {
				op: "wait" as const,
				jobs: [
					{
						id: "bg_3",
						type: "bash" as const,
						status: "running" as const,
						label: "bun run bench:decode",
						durationMs: 42_000,
						widget: decodeBench,
					},
					{
						id: "Bencher",
						type: "task" as const,
						status: "running" as const,
						label: "Bencher",
						durationMs: 60_000,
						...(stage ? { stage } : {}),
					},
				],
			} satisfies CoordinationDetails,
		});
		it("draws every job as a tile of one strip: the widget inside its job's tile, a task's stage in its own", () => {
			const view = waitToolRenderer.describeResult!(widgetResult("profiling the decode loop"), {
				expanded: true,
				isPartial: true,
			});
			const [strip] = view!.body! as NativeNode[];
			const tiles = (strip!.c ?? []) as NativeNode[];
			expect(tiles.map(tile => byRole(tile, "omp.job.tile.title")?.p)).toMatchObject([
				{ spans: [{ t: "Bencher" }] },
				{ spans: [{ t: "verb-bench · decode throughput" }] },
			]);
			const bench = tiles[1]!;
			expect(byRole(bench, "omp.job.tile.chart")).toBeDefined();
			expect(JSON.stringify(tiles[0])).toContain("profiling the decode loop");
		});

		it("re-describes a memoized result when a widget's data moves", () => {
			const result = widgetResult();
			const first = waitToolRenderer.describeResult!(result, { expanded: true, isPartial: true });
			expect(waitToolRenderer.describeResult!(result, { expanded: true, isPartial: true })).toBe(first);
			result.details.jobs[0]!.widget = {
				...decodeBench,
				updatedAt: decodeBench.updatedAt + 1_000,
				headline: { text: "191 tok/s" },
			};
			const next = waitToolRenderer.describeResult!(result, { expanded: true, isPartial: true });
			expect(next).not.toBe(first);
			expect(JSON.stringify(next)).toContain('{"t":"191"}');
		});

		it("draws a widget job's ANSI row as its tile and keeps it on a sealed card", () => {
			for (const isPartial of [true, false]) {
				const component = waitToolRenderer.renderResult(widgetResult(), { expanded: false, isPartial }, theme);
				const lines = (component.render(100) as readonly string[]).map(line => Bun.stripANSI(line));
				const row = lines.findIndex(line => line.includes("bg_3"));
				expect(row).toBeGreaterThan(0);
				expect(lines[row]).toContain("verb-bench · decode throughput bg_3");
				expect(lines[row]).toMatch(/decode 186 tok\/s ▲ 15% {2}42\.0s$/);
				expect(lines[row + 1]).toMatch(/[▁▂▃▄▅▆▇█]+ {2}186 tok\/s {2}┄ target 200 tok\/s/);
				for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(100);
			}
		});
	});
});

describe("IRC body wrapping", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("soft-wraps a long body line to the card width when expanded", () => {
		const longLine = "word ".repeat(40).trim();
		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: {
				op: "wait" as const,
				waited: { id: "1", from: "Peer", to: "Main", body: longLine, ts: Date.now() },
			},
		};
		const component = waitToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme);
		const lines = component.render(120) as readonly string[];
		const stripped = lines.map(line => Bun.stripANSI(line));
		const bodyLines = stripped.filter(line => line.includes("word"));
		// A 200-char line wraps to multiple lines at the card width
		expect(bodyLines.length).toBeGreaterThanOrEqual(2);
		// Full content preserved across the wrap
		const words = bodyLines
			.join(" ")
			.split(/\s+/)
			.filter(w => w === "word");
		expect(words).toHaveLength(40);
	});

	it("shows an expand hint on a collapsed card with hidden lines", () => {
		const body = ["line one", "line two", "line three", "line four"].join("\n");
		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: {
				op: "wait" as const,
				waited: { id: "1", from: "Peer", to: "Main", body, ts: Date.now() },
			},
		};
		const component = waitToolRenderer.renderResult(result, { expanded: false, isPartial: false }, theme);
		const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
		expect(output).toContain("+2 more lines");
		expect(output).toContain("Expand");
	});

	it("preserves ANSI escape codes across a wrap boundary", () => {
		const longLine = `\x1b[31m${"red ".repeat(40)}\x1b[0m`;
		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: {
				op: "wait" as const,
				waited: { id: "1", from: "Peer", to: "Main", body: longLine, ts: Date.now() },
			},
		};
		const component = waitToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme);
		const lines = component.render(120) as readonly string[];
		const rawJoined = lines.join("\n");
		// ANSI codes preserved in raw output
		expect(rawJoined).toContain("\x1b[31m");
		expect(rawJoined).toContain("\x1b[0m");
		// Full visible content preserved after stripping
		const stripped = Bun.stripANSI(rawJoined);
		const words = stripped.split(/\s+/).filter(w => w === "red");
		expect(words).toHaveLength(40);
	});

	it("soft-wraps a long body in an expanded IRC message card", () => {
		const longLine = "word ".repeat(40).trim();
		const component = createIrcMessageCard({ kind: "incoming", from: "Peer", body: longLine }, () => true, theme);
		const lines = component.render(120) as readonly string[];
		const stripped = lines.map(line => Bun.stripANSI(line));
		const bodyLines = stripped.filter(line => line.includes("word"));
		expect(bodyLines.length).toBeGreaterThanOrEqual(2);
		const words = bodyLines
			.join(" ")
			.split(/\s+/)
			.filter(w => w === "word");
		expect(words).toHaveLength(40);
	});
});
