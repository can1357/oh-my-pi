import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { RenderResultOptions } from "@pk-nerdsaver-ai/pi-agent-core";
import type { SettingPath, SettingValue } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { getThemeByName, setThemeInstance } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import type { SubagentModelRoutingDecision } from "@pk-nerdsaver-ai/pi-coding-agent/orchestration/subagent-model-routing";
import { taskToolRenderer } from "@pk-nerdsaver-ai/pi-coding-agent/task/render";
import type { AgentProgress, SingleResult, TaskToolDetails } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";

function runningProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "KeySettingsHotPaths",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "investigate hot paths",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function finishedResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "Agent",
		agent: "task",
		agentSource: "bundled",
		task: "investigate hot paths",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

function detailsFor(progress: AgentProgress): TaskToolDetails {
	return { projectAgentsDir: null, results: [], totalDurationMs: 0, progress: [progress] };
}

function findRow(component: { render: (w: number) => readonly string[] }, needle: string): string {
	const row = component
		.render(120)
		.join("\n")
		.split("\n")
		.find(line => Bun.stripANSI(line).includes(needle));
	expect(row).toBeDefined();
	return row!;
}

describe("task progress rendering", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});
	it("renders running task rows static with the agent dot", async () => {
		const theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const progress = runningProgress({ id: "CountPackages", description: "List workspace packages" });

		const renderRow = (timeMs: number): string => {
			vi.spyOn(Date, "now").mockReturnValue(timeMs);
			return findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details: detailsFor(progress) },
					options,
					theme,
				),
				"CountPackages",
			);
		};

		const rawRow0 = renderRow(0);
		const rawRow1 = renderRow(700);
		const strippedRow = Bun.stripANSI(rawRow0);

		expect(strippedRow).toContain(`${theme.status.done} CountPackages: List workspace packages`);
		expect(strippedRow).not.toContain(theme.symbol("tool.task"));
		expect(strippedRow).not.toContain(theme.status.running);
		expect(strippedRow).not.toContain(theme.getSpinnerFrames("status")[0]);
		expect(rawRow0).toBe(rawRow1);
	});

	it("keeps the agent dot when shimmer is disabled", async () => {
		const theme = (await getThemeByName("dark"))!;
		const settings = Settings.instance;
		const readSetting: Settings["get"] = settings.get.bind(settings);
		vi.spyOn(settings, "get").mockImplementation(<P extends SettingPath>(path: P): SettingValue<P> => {
			if (path === "display.shimmer") return "disabled" as SettingValue<P>;
			return readSetting(path);
		});
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };

		const strippedRow = Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details: detailsFor(runningProgress()) },
					options,
					theme,
				),
				"KeySettingsHotPaths",
			),
		);

		expect(strippedRow).toContain(`${theme.status.done} KeySettingsHotPaths`);
		expect(strippedRow).not.toContain(theme.status.running);
		expect(strippedRow).not.toContain(theme.getSpinnerFrames("status")[0]);
	});

	it("renders pending task rows with the agent dot, not the pending glyph", async () => {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const progress = runningProgress({
			id: "BestGpt",
			status: "pending",
			description: "Combine winners for gpt",
		});

		const renderRow = (timeMs: number): string => {
			vi.spyOn(Date, "now").mockReturnValue(timeMs);
			return findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details: detailsFor(progress) },
					options,
					theme,
				),
				"BestGpt",
			);
		};

		const rawRow0 = renderRow(0);
		const rawRow1 = renderRow(700);
		const strippedRow = Bun.stripANSI(rawRow0);

		expect(strippedRow).toContain(`${theme.status.done} BestGpt: Combine winners for gpt`);
		expect(strippedRow).not.toContain(theme.status.pending);
		expect(rawRow0).toBe(rawRow1);
	});

	it("settles completed rows to the foreground color with the same dot", async () => {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const progress = runningProgress({
			id: "DonePkg",
			status: "completed",
			description: "List workspace packages",
		});

		const row = findRow(
			taskToolRenderer.renderResult(
				{ content: [{ type: "text", text: "" }], details: detailsFor(progress) },
				options,
				theme,
			),
			"DonePkg",
		);

		const stripped = Bun.stripANSI(row);
		expect(stripped).toContain(`${theme.status.done} DonePkg: List workspace packages`);
		expect(stripped).not.toContain(theme.symbol("tool.task"));
		// Same dot as live rows; completion reads as the label settling from
		// accent to the plain foreground color.
		const titlePart = `${theme.bold("DonePkg")}: List workspace packages`;
		expect(row).toContain(theme.fg("text", titlePart));
		expect(row).not.toContain(theme.fg("accent", titlePart));
	});

	it("shows the dispatch glyph in the header while agents run, not a spinner", async () => {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const header = findRow(
			taskToolRenderer.renderResult(
				{ content: [{ type: "text", text: "" }], details: detailsFor(runningProgress()) },
				options,
				theme,
			),
			"Task",
		);

		const stripped = Bun.stripANSI(header);
		expect(stripped).toContain(`${theme.symbol("tool.task")} Task`);
		expect(stripped).not.toContain(theme.status.running);
		expect(stripped).not.toContain(theme.getSpinnerFrames("status")[0]);
	});

	it("renders the assignment markdown inside the result frame", async () => {
		const theme = (await getThemeByName("dark"))!;
		setThemeInstance(theme);
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const progress = runningProgress({ id: "BestGpt", status: "pending", description: "Combine winners" });

		const rendered = Bun.stripANSI(
			taskToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: "Spawned agent BestGpt..." }], details: detailsFor(progress) },
					options,
					theme,
					{ agent: "task", id: "BestGpt", assignment: "# Target\nCombine the winning patches." },
				)
				.render(120)
				.join("\n"),
		);

		// The brief stays visible for the whole task lifecycle, not just while
		// the call args stream in.
		expect(rendered).toContain("Target");
		expect(rendered).toContain("Combine the winning patches.");
	});

	it("pins unfinished tasks below finished ones, finished sorted by runtime asc", async () => {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [
				runningProgress({ index: 0, id: "FirstRunning", status: "running", durationMs: 9000 }),
				runningProgress({ index: 1, id: "DoneSlow", status: "completed", durationMs: 5000 }),
				runningProgress({ index: 2, id: "StillPending", status: "pending" }),
				runningProgress({ index: 3, id: "FailedFast", status: "failed", durationMs: 1000 }),
			],
		};

		const rendered = Bun.stripANSI(
			taskToolRenderer
				.renderResult({ content: [{ type: "text", text: "" }], details }, options, theme)
				.render(120)
				.join("\n"),
		);

		// Finished agents sorted by runtime ascending; pending/running stay at the
		// bottom in dispatch order.
		const positions = ["FailedFast", "DoneSlow", "FirstRunning", "StillPending"].map(id => rendered.indexOf(id));
		expect(positions.every(p => p >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	it("orders finalized results by runtime asc, matching the live view", async () => {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: false };
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				finishedResult({ index: 0, id: "SlowFinish", durationMs: 9000 }),
				finishedResult({ index: 1, id: "FastFinish", durationMs: 1000 }),
				finishedResult({ index: 2, id: "MidFinish", durationMs: 4000 }),
			],
			totalDurationMs: 9000,
		};

		const rendered = Bun.stripANSI(
			taskToolRenderer
				.renderResult({ content: [{ type: "text", text: "" }], details }, options, theme)
				.render(120)
				.join("\n"),
		);

		const positions = ["FastFinish", "MidFinish", "SlowFinish"].map(id => rendered.indexOf(id));
		expect(positions.every(p => p >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	it("folds collapsed progress lists to the live edge with a status summary", async () => {
		const theme = (await getThemeByName("dark"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [
				runningProgress({ index: 0, id: "DoneOne", status: "completed", durationMs: 1000 }),
				runningProgress({ index: 1, id: "DoneTwo", status: "completed", durationMs: 2000 }),
				runningProgress({ index: 2, id: "DoneThree", status: "completed", durationMs: 3000 }),
				runningProgress({ index: 3, id: "LiveOne", status: "running" }),
				runningProgress({ index: 4, id: "LiveTwo", status: "running" }),
				runningProgress({ index: 5, id: "LiveThree", status: "pending" }),
				runningProgress({ index: 6, id: "LiveFour", status: "pending" }),
			],
		};
		const result = { content: [{ type: "text", text: "" }], details };

		const collapsed = Bun.stripANSI(
			taskToolRenderer
				.renderResult(result, { expanded: false, isPartial: true, spinnerFrame: 0 }, theme)
				.render(120)
				.join("\n"),
		);
		// Finished rows fold into the summary; the live edge stays visible.
		for (const id of ["LiveOne", "LiveTwo", "LiveThree", "LiveFour"]) {
			expect(collapsed).toContain(id);
		}
		for (const id of ["DoneOne", "DoneTwo", "DoneThree"]) {
			expect(collapsed).not.toContain(id);
		}
		expect(collapsed).toContain("… 3 more agents (3 done)");
		// The summary line sits above the visible rows (live edge at the bottom).
		expect(collapsed.indexOf("more agents")).toBeLessThan(collapsed.indexOf("LiveOne"));

		const expanded = Bun.stripANSI(
			taskToolRenderer
				.renderResult(result, { expanded: true, isPartial: true, spinnerFrame: 0 }, theme)
				.render(120)
				.join("\n"),
		);
		for (const id of ["DoneOne", "DoneTwo", "DoneThree", "LiveOne", "LiveFour"]) {
			expect(expanded).toContain(id);
		}
		expect(expanded).not.toContain("more agents");
	});

	it("keeps problem rows visible when the collapsed result list folds", async () => {
		const theme = (await getThemeByName("dark"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				finishedResult({ index: 0, id: "FastOne", durationMs: 1000 }),
				finishedResult({ index: 1, id: "FastTwo", durationMs: 2000 }),
				finishedResult({ index: 2, id: "FastThree", durationMs: 3000 }),
				finishedResult({ index: 3, id: "SlowOne", durationMs: 8000 }),
				finishedResult({ index: 4, id: "SlowTwo", durationMs: 9000 }),
				finishedResult({ index: 5, id: "SlowFailed", exitCode: 1, error: "boom", durationMs: 10000 }),
			],
			totalDurationMs: 10000,
		};

		const collapsed = Bun.stripANSI(
			taskToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: "" }], details },
					{ expanded: false, isPartial: false },
					theme,
				)
				.render(120)
				.join("\n"),
		);
		// The failed agent claims a slot even though it finished last; the
		// slowest successes fold away instead.
		expect(collapsed).toContain("SlowFailed");
		for (const id of ["FastOne", "FastTwo", "FastThree"]) {
			expect(collapsed).toContain(id);
		}
		expect(collapsed).not.toContain("SlowOne");
		expect(collapsed).not.toContain("SlowTwo");
		expect(collapsed).toContain("… 2 more agents");
		// The run summary footer still counts the full batch.
		expect(collapsed).toContain("5 succeeded");
		expect(collapsed).toContain("1 failed");
	});
});

describe("resolved-model badge routing context", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function withBadgeEnabled(enabled: boolean): void {
		const settings = Settings.instance;
		const readSetting: Settings["get"] = settings.get.bind(settings);
		vi.spyOn(settings, "get").mockImplementation(<P extends SettingPath>(path: P): SettingValue<P> => {
			if (path === "task.showResolvedModelBadge") return enabled as SettingValue<P>;
			return readSetting(path);
		});
	}

	async function renderRowFor(progress: AgentProgress): Promise<string> {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		return Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details: detailsFor(progress) },
					options,
					theme,
				),
				progress.id,
			),
		);
	}

	it("stays off by default even when routing metadata is present", async () => {
		const row = await renderRowFor(
			runningProgress({
				id: "BadgeOffDefault",
				status: "completed",
				resolvedModel: "anthropic/claude-opus-4-5",
				modelRouting: {
					requestedDifficulty: "high",
					source: "difficulty-profile",
					profileName: "balanced",
					role: "slow",
					candidateSelectors: ["anthropic/claude-opus-4-5"],
				},
			}),
		);
		expect(row).not.toContain("anthropic/claude-opus-4-5");
		expect(row).not.toContain("profile:balanced");
	});

	it("renders legacy resolved-model badge unchanged when routing metadata is absent", async () => {
		withBadgeEnabled(true);
		const row = await renderRowFor(
			runningProgress({
				id: "LegacyBadge",
				status: "completed",
				resolvedModel: "anthropic/claude-3-5-haiku",
			}),
		);
		expect(row).toContain("anthropic/claude-3-5-haiku");
		expect(row).not.toContain("→");
	});

	it("shows difficulty + profile context ahead of the resolved model", async () => {
		withBadgeEnabled(true);
		const row = await renderRowFor(
			runningProgress({
				id: "RouteHighProfile",
				status: "completed",
				resolvedModel: "anthropic/claude-opus-4-5",
				modelRouting: {
					requestedDifficulty: "high",
					source: "difficulty-profile",
					profileName: "balanced",
					role: "slow",
					candidateSelectors: ["anthropic/claude-opus-4-5"],
				},
			}),
		);
		expect(row).toContain("high/profile:balanced → anthropic/claude-opus-4-5");
	});

	const sourceCases: Array<{ name: string; routing: SubagentModelRoutingDecision; expected: string }> = [
		{
			name: "difficulty-profile without an active profile name",
			routing: { requestedDifficulty: "low", source: "difficulty-profile", role: "smol", candidateSelectors: [] },
			expected: "low/difficulty",
		},
		{
			name: "explicit model alone (no difficulty requested)",
			routing: { source: "explicit", requestedModel: "anthropic/claude-opus-4-5", candidateSelectors: [] },
			expected: undefined as unknown as string,
		},
		{
			name: "explicit model coexisting with a requested difficulty",
			routing: {
				requestedDifficulty: "high",
				source: "explicit",
				requestedModel: "anthropic/claude-opus-4-5",
				candidateSelectors: [],
			},
			expected: "high/explicit",
		},
		{
			name: "per-agent override",
			routing: { source: "agent-override", role: "task", candidateSelectors: [] },
			expected: "override",
		},
		{
			name: "agent definition default",
			routing: { source: "agent-definition", role: "task", candidateSelectors: [] },
			expected: "agent-default",
		},
		{
			name: "parent's active model",
			routing: { source: "parent-active", candidateSelectors: [] },
			expected: "parent",
		},
		{
			name: "session default (no extra context)",
			routing: { source: "session-default", candidateSelectors: [] },
			expected: undefined as unknown as string,
		},
	];

	it.each(sourceCases)("selection source: $name", async ({ routing, expected }) => {
		withBadgeEnabled(true);
		const row = await renderRowFor(
			runningProgress({
				id: "RouteSource",
				status: "completed",
				resolvedModel: "anthropic/claude-opus-4-5",
				modelRouting: routing,
			}),
		);
		if (expected) {
			expect(row).toContain(`${expected} → anthropic/claude-opus-4-5`);
		} else {
			expect(row).toContain("anthropic/claude-opus-4-5");
			expect(row).not.toContain("→");
		}
	});

	it("truncates a long routing context + model without unbounded growth", async () => {
		withBadgeEnabled(true);
		const row = await renderRowFor(
			runningProgress({
				id: "RouteLongSelector",
				status: "completed",
				resolvedModel: "some-provider/an-extremely-long-model-identifier-string-that-keeps-going-on",
				modelRouting: {
					requestedDifficulty: "high",
					source: "difficulty-profile",
					profileName: "an-unusually-long-profile-name-for-testing-truncation",
					role: "slow",
					candidateSelectors: [],
				},
			}),
		);
		expect(row).toContain("…");
		expect(row).not.toContain("an-unusually-long-profile-name-for-testing-truncation");
		expect(row).not.toContain("some-provider/an-extremely-long-model-identifier-string-that-keeps-going-on");
	});

	it("never renders candidate selectors, raw model assignments, or diagnostic detail", async () => {
		withBadgeEnabled(true);
		const row = await renderRowFor(
			runningProgress({
				id: "RouteNoSecrets",
				status: "completed",
				resolvedModel: "anthropic/claude-opus-4-5",
				modelRouting: {
					requestedDifficulty: "high",
					source: "difficulty-profile",
					profileName: "balanced",
					role: "slow",
					candidateSelectors: ["anthropic/claude-opus-4-5", "openai/gpt-5", "sk-secret-token-should-not-appear"],
				},
			}),
		);
		expect(row).not.toContain("candidateSelectors");
		expect(row).not.toContain("sk-secret-token-should-not-appear");
		expect(row).not.toContain("openai/gpt-5");
	});

	it("shows the same routing context on a finalized SingleResult row", async () => {
		const theme = (await getThemeByName("dark"))!;
		withBadgeEnabled(true);
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			totalDurationMs: 0,
			results: [
				finishedResult({
					id: "FinalRouteHigh",
					resolvedModel: "anthropic/claude-opus-4-5",
					modelRouting: {
						requestedDifficulty: "high",
						source: "difficulty-profile",
						profileName: "balanced",
						role: "slow",
						candidateSelectors: ["anthropic/claude-opus-4-5"],
					},
				}),
			],
		};
		const row = Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details },
					{ expanded: false, isPartial: false },
					theme,
				),
				"FinalRouteHigh",
			),
		);
		expect(row).toContain("high/profile:balanced → anthropic/claude-opus-4-5");
	});
});

describe("task result detail-less state", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("renders a validation failure with the error glyph, not a success bullet", async () => {
		const theme = (await getThemeByName("dark"))!;
		// The assignment section renders markdown, which reads the active theme.
		setThemeInstance(theme);
		const options: RenderResultOptions = { expanded: false, isPartial: false };
		const component = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: 'Validation failed for tool "task": assignment: Invalid input' }],
				isError: true,
			},
			options,
			theme,
			{ agent: "explore", assignment: "Look around." },
		);
		const stripped = Bun.stripANSI(component.render(120).join("\n"));

		// A failed task must surface the error glyph and never the "done" bullet.
		expect(stripped).toContain(theme.status.error);
		expect(stripped).not.toContain(theme.status.done);
		expect(stripped).toContain("Task");
		expect(stripped).toContain("explore");
		expect(stripped).toContain("Validation failed");
	});

	it("renders a detail-less success with the accent bullet, not an error glyph", async () => {
		const theme = (await getThemeByName("dark"))!;
		setThemeInstance(theme);
		const options: RenderResultOptions = { expanded: false, isPartial: false };
		const component = taskToolRenderer.renderResult({ content: [{ type: "text", text: "done" }] }, options, theme, {
			agent: "explore",
			assignment: "Look around.",
		});
		const stripped = Bun.stripANSI(component.render(120).join("\n"));

		expect(stripped).toContain(theme.status.done);
		expect(stripped).not.toContain(theme.status.error);
	});
});
