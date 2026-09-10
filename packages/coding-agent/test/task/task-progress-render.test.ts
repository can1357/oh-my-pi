import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type RenderResultOptions, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { SettingPath, SettingValue } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { taskToolRenderer } from "@oh-my-pi/pi-coding-agent/task/renderer";
import { subprocessToolRegistry } from "@oh-my-pi/pi-coding-agent/task/subprocess-tool-registry";
import type { AgentProgress, SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import { FEED_MODEL_BADGE_WIDTH } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { visibleWidth } from "@oh-my-pi/pi-tui";

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

	it("places the model and advisor before the live agent title without displacing stats", async () => {
		Settings.instance.set("task.showResolvedModelBadge", true);
		const theme = (await getThemeByName("dark"))!;
		const progress = runningProgress({
			id: "BadgeWorker",
			agent: "scout",
			description: "Inspect rendering",
			resolvedModel: "openai/gpt-5:high",
			resolvedModelIdentity: "openai/gpt-5",
			resolvedThinkingLevel: ThinkingLevel.High,
			advisor: true,
			requests: 3,
			cost: 0.25,
		});
		const row = Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{ content: [], details: detailsFor(progress) },
					{ expanded: false, isPartial: true },
					theme,
				),
				"BadgeWorker",
			),
		);
		expect(row).toContain(`openai/gpt-5 ${theme.icon.advisor} BadgeWorker: Inspect rendering`);
		expect(row).not.toContain(":high");
		expect(row).toContain(`${theme.thinking.high.split(" ")[0]} openai/gpt-5`);
		expect(row.indexOf(theme.status.done)).toBeLessThan(row.indexOf("openai/gpt-5"));
		expect(row).toContain(`${theme.format.bracketLeft}scout${theme.format.bracketRight}`);
		expect(row.indexOf("3 req")).toBeGreaterThan(row.indexOf("BadgeWorker"));
		expect(row).toContain("$0.25");
	});

	it("keeps the settled model before the name and only marks an enabled advisor", async () => {
		Settings.instance.set("task.showResolvedModelBadge", true);
		const theme = (await getThemeByName("dark"))!;
		const renderRow = (advisor: boolean): string =>
			Bun.stripANSI(
				findRow(
					taskToolRenderer.renderResult(
						{
							content: [],
							details: {
								projectAgentsDir: null,
								totalDurationMs: 1000,
								results: [
									finishedResult({
										id: "SettledWorker",
										description: "Inspect rendering",
										resolvedModel: "openai/gpt-5:high",
										resolvedModelIdentity: "openai/gpt-5",
										resolvedThinkingLevel: ThinkingLevel.High,
										advisor,
										durationMs: 1000,
										requests: 3,
									}),
								],
							},
						},
						{ expanded: false, isPartial: false },
						theme,
					),
					"SettledWorker",
				),
			);
		const withoutAdvisor = renderRow(false);
		expect(withoutAdvisor).toContain("openai/gpt-5 SettledWorker: Inspect rendering");
		expect(withoutAdvisor).not.toContain(theme.icon.advisor);
		expect(withoutAdvisor).not.toContain(":high");
		expect(withoutAdvisor.indexOf("3 req")).toBeGreaterThan(withoutAdvisor.indexOf("SettledWorker"));
		expect(renderRow(true)).toContain(`openai/gpt-5 ${theme.icon.advisor} SettledWorker`);
	});

	it("keeps the name and status on the first row at 40 columns across resizes", async () => {
		Settings.instance.set("task.showResolvedModelBadge", true);
		const theme = (await getThemeByName("dark"))!;
		const metadata = {
			id: "ArchitectureScout",
			agent: "scout",
			description: "Inspect rendering boundaries",
			resolvedModelIdentity: "openai/custom-architecture-model:high",
			resolvedThinkingLevel: ThinkingLevel.High,
			advisor: true,
		};
		const snapshots: { details: TaskToolDetails; status?: string }[] = [
			{ details: detailsFor(runningProgress(metadata)) },
			{ details: detailsFor(runningProgress({ ...metadata, status: "completed" })) },
			{ details: detailsFor(runningProgress({ ...metadata, status: "failed" })), status: "failed" },
			{
				details: { projectAgentsDir: null, totalDurationMs: 0, results: [finishedResult(metadata)] },
				status: "done",
			},
			{
				details: {
					projectAgentsDir: null,
					totalDurationMs: 0,
					results: [finishedResult({ ...metadata, exitCode: 1 })],
				},
				status: "failed",
			},
		];
		for (const { details, status } of snapshots) {
			const component = taskToolRenderer.renderResult(
				{ content: [], details },
				{ expanded: false, isPartial: !!details.progress },
				theme,
			);
			for (const width of [160, 40, 160]) {
				const rows = component.render(width);
				for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
				const plainRows = rows.map(row => Bun.stripANSI(row));
				const firstStatusRow = plainRows.find(row => row.startsWith(theme.boxRound.vertical));
				expect(firstStatusRow).toBeDefined();
				expect(firstStatusRow).toContain(metadata.id);
				expect(firstStatusRow).toContain(`${theme.format.bracketLeft}scout${theme.format.bracketRight}`);
				if (status) {
					expect(firstStatusRow).toContain(`${theme.format.bracketLeft}${status}${theme.format.bracketRight}`);
				}
				expect(plainRows.join("\n")).toContain(metadata.description);
				if (width === 160) {
					const thinkingGlyph = theme.thinking.high.split(" ")[0];
					expect(firstStatusRow).toContain("openai/");
					expect(firstStatusRow).toContain(":high");
					expect(firstStatusRow).toContain(thinkingGlyph);
					const badge = firstStatusRow!
						.slice(firstStatusRow!.indexOf(thinkingGlyph), firstStatusRow!.indexOf(metadata.id))
						.trimEnd();
					expect(visibleWidth(badge)).toBeLessThanOrEqual(FEED_MODEL_BADGE_WIDTH);
					expect(firstStatusRow).toContain(theme.icon.advisor);
				}
			}
		}
	});

	it("hides model and advisor metadata together on progress and settled rows", async () => {
		Settings.instance.set("task.showResolvedModelBadge", false);
		const theme = (await getThemeByName("dark"))!;
		const metadata = {
			id: "HiddenBadge",
			resolvedModel: "openai/gpt-5:high",
			resolvedModelIdentity: "openai/gpt-5",
			resolvedThinkingLevel: ThinkingLevel.High,
			advisor: true,
		};
		const snapshots: TaskToolDetails[] = [
			detailsFor(runningProgress(metadata)),
			{ projectAgentsDir: null, totalDurationMs: 0, results: [finishedResult(metadata)] },
		];
		for (const details of snapshots) {
			const row = Bun.stripANSI(
				findRow(
					taskToolRenderer.renderResult(
						{ content: [], details },
						{ expanded: false, isPartial: !!details.progress },
						theme,
					),
					"HiddenBadge",
				),
			);
			expect(row).toContain(`${theme.status.done} HiddenBadge`);
			expect(row).not.toContain("openai/gpt-5");
			expect(row).not.toContain(theme.icon.advisor);
		}
	});

	it("preserves nested subprocess IDs and status when no width is known during row construction", async () => {
		const theme = (await getThemeByName("dark"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			totalDurationMs: 0,
			results: [finishedResult({ id: "UnknownWidthWorker", agent: "scout", exitCode: 1 })],
		};
		const component = subprocessToolRegistry.getHandler("task")!.renderFinal!([details], theme, false);
		const text = Bun.stripANSI(component.render(120).join("\n"));
		expect(text).toContain("UnknownWidthWorker");
		expect(text).toContain(`${theme.format.bracketLeft}scout${theme.format.bracketRight}`);
		expect(text).toContain(`${theme.format.bracketLeft}failed${theme.format.bracketRight}`);
	});

	it("renders model-bearing progress and results before settings initialization", async () => {
		const theme = (await getThemeByName("dark"))!;
		resetSettingsForTest();
		const metadata = { id: "ColdStart", resolvedModelIdentity: "provider/model", advisor: true };
		for (const details of [
			detailsFor(runningProgress(metadata)),
			{ projectAgentsDir: null, totalDurationMs: 0, results: [finishedResult(metadata)] },
		]) {
			const text = Bun.stripANSI(
				taskToolRenderer
					.renderResult({ content: [], details }, { expanded: false, isPartial: false }, theme)
					.render(60)
					.join("\n"),
			);
			expect(text).toContain("ColdStart");
			expect(text).not.toContain("provider/model");
			expect(text).not.toContain(theme.icon.advisor);
		}
	});

	it("preserves long descriptions below bounded IDs and required status with badges on or off", async () => {
		const theme = (await getThemeByName("dark"))!;
		const description = "First distinctive description section followed by every remaining detail and final marker";
		const metadata = {
			id: `LongWorker${"界".repeat(30)}`,
			agent: `custom-role-${"extended-".repeat(10)}`,
			description,
			resolvedModelIdentity: "provider/model",
			advisor: true,
		};
		for (const enabled of [true, false]) {
			Settings.instance.override("task.showResolvedModelBadge", enabled);
			for (const details of [
				detailsFor(runningProgress({ ...metadata, status: "failed" })),
				{ projectAgentsDir: null, totalDurationMs: 0, results: [finishedResult({ ...metadata, exitCode: 1 })] },
			]) {
				const component = taskToolRenderer.renderResult(
					{ content: [], details },
					{ expanded: false, isPartial: false },
					theme,
				);
				for (const width of [40, 160, 40]) {
					const rows = component.render(width).map(row => Bun.stripANSI(row));
					for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
					const statusRow = rows.find(row => row.includes("LongWorker"))!;
					expect(statusRow).toContain("LongWorker");
					expect(statusRow).toContain(`${theme.format.bracketLeft}failed${theme.format.bracketRight}`);
					const text = rows.join("").replaceAll(theme.boxRound.vertical, "").replace(/\s+/g, "");
					expect(text).toContain(description.replace(/\s+/g, ""));
				}
			}
		}
	});

	it("preserves old snapshot selectors without inventing thinking glyphs", async () => {
		Settings.instance.set("task.showResolvedModelBadge", true);
		const theme = (await getThemeByName("dark"))!;
		const metadata = { id: "LegacyWorker", resolvedModel: "custom/model:high" };
		const snapshots: TaskToolDetails[] = [
			detailsFor(runningProgress(metadata)),
			{ projectAgentsDir: null, totalDurationMs: 0, results: [finishedResult(metadata)] },
		];
		for (const details of snapshots) {
			const row = Bun.stripANSI(
				findRow(
					taskToolRenderer.renderResult(
						{ content: [], details },
						{ expanded: false, isPartial: !!details.progress },
						theme,
					),
					"LegacyWorker",
				),
			);
			expect(row).toContain(`${theme.status.done} custom/model:high LegacyWorker`);
			expect(row).not.toContain(theme.thinking.high.split(" ")[0]);
		}
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

	// Regression: the ⟨agent⟩ type badge must survive past the streaming call
	// preview — it stays on live progress rows and on finished result rows, and
	// the generic `task` worker stays bare.
	it("keeps the agent type badge on progress and result rows", async () => {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const badge = `${theme.format.bracketLeft}sonic${theme.format.bracketRight}`;

		const progressRow = Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{
						content: [{ type: "text", text: "" }],
						details: detailsFor(runningProgress({ id: "SonicCount", agent: "sonic" })),
					},
					options,
					theme,
				),
				"SonicCount",
			),
		);
		expect(progressRow).toContain(badge);

		const resultDetails: TaskToolDetails = {
			projectAgentsDir: null,
			results: [finishedResult({ id: "SonicCount", agent: "sonic" })],
			totalDurationMs: 0,
		};
		const resultRow = Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details: resultDetails },
					{ expanded: false, isPartial: false },
					theme,
				),
				"SonicCount",
			),
		);
		expect(resultRow).toContain(badge);

		const genericRow = Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{
						content: [{ type: "text", text: "" }],
						details: detailsFor(runningProgress({ id: "PlainWorker", agent: "task" })),
					},
					options,
					theme,
				),
				"PlainWorker",
			),
		);
		expect(genericRow).not.toContain(`${theme.format.bracketLeft}task${theme.format.bracketRight}`);
	});

	it("shows the spawn count without a joined agent-type list in the header", async () => {
		const theme = (await getThemeByName("dark"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [
				runningProgress({ index: 0, id: "ScoutProbe", agent: "scout" }),
				runningProgress({ index: 1, id: "SonicCount", agent: "sonic" }),
			],
		};
		const header = Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details },
					{ expanded: false, isPartial: true, spinnerFrame: 0 },
					theme,
				),
				"2 agents",
			),
		);
		expect(header).not.toContain("2 agents:");
		expect(header).not.toContain("scout, sonic");
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

	it("renders the task brief markdown inside the result frame", async () => {
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
					{ agent: "task", name: "BestGpt", task: "# Target\nCombine the winning patches." },
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
	it("expands tabs in task descriptions before measuring and rendering", async () => {
		const theme = (await getThemeByName("dark"))!;
		const description = "Inspect\trendering\tboundaries";
		const snapshots: TaskToolDetails[] = [
			detailsFor(runningProgress({ id: "TabWorker", description })),
			{ projectAgentsDir: null, totalDurationMs: 0, results: [finishedResult({ id: "TabWorker", description })] },
		];
		for (const details of snapshots) {
			const rows = taskToolRenderer
				.renderResult({ content: [], details }, { expanded: false, isPartial: !!details.progress }, theme)
				.render(120);
			for (const row of rows) expect(Bun.stripANSI(row)).not.toContain("\t");
			const text = rows.map(row => Bun.stripANSI(row)).join("\n");
			expect(text).toContain("TabWorker");
			expect(text).toContain("Inspect");
			expect(text).toContain("rendering");
		}
		const longDescription = `First\tsection with a tab followed by enough detail to force the continuation line at narrow widths`;
		const narrow: TaskToolDetails[] = [
			detailsFor(runningProgress({ id: "TabNarrow", description: longDescription })),
			{
				projectAgentsDir: null,
				totalDurationMs: 0,
				results: [finishedResult({ id: "TabNarrow", description: longDescription })],
			},
		];
		for (const details of narrow) {
			const rows = taskToolRenderer
				.renderResult({ content: [], details }, { expanded: false, isPartial: !!details.progress }, theme)
				.render(40);
			for (const row of rows) {
				expect(Bun.stripANSI(row)).not.toContain("\t");
				expect(visibleWidth(row)).toBeLessThanOrEqual(40);
			}
		}
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
		// The task-brief section renders markdown, which reads the active theme.
		setThemeInstance(theme);
		const options: RenderResultOptions = { expanded: false, isPartial: false };
		const component = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: 'Validation failed for tool "task": task: Invalid input' }],
				isError: true,
			},
			options,
			theme,
			{ agent: "scout", task: "Look around." },
		);
		const stripped = Bun.stripANSI(component.render(120).join("\n"));

		// A failed task must surface the error glyph and never the "done" bullet.
		expect(stripped).toContain(theme.status.error);
		expect(stripped).not.toContain(theme.status.done);
		expect(stripped).toContain("Task");
		expect(stripped).toContain("scout");
		expect(stripped).toContain("Validation failed");
	});

	it("renders a detail-less success with the accent bullet, not an error glyph", async () => {
		const theme = (await getThemeByName("dark"))!;
		setThemeInstance(theme);
		const options: RenderResultOptions = { expanded: false, isPartial: false };
		const component = taskToolRenderer.renderResult({ content: [{ type: "text", text: "done" }] }, options, theme, {
			agent: "scout",
			task: "Look around.",
		});
		const stripped = Bun.stripANSI(component.render(120).join("\n"));

		expect(stripped).toContain(theme.status.done);
		expect(stripped).not.toContain(theme.status.error);
	});
});
