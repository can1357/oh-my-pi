import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { AsyncJobManager } from "../src/async/job-manager";
import { resetSettingsForTest, Settings, settings } from "../src/config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "../src/modes/theme/theme";
import type { ToolSession } from "../src/tools";
import { jobsRenderResult, snapshotJobs } from "../src/tools/hub/jobs";
import type { CoordinationDetails } from "../src/tools/hub/types";
import { formatDuration, thinkingLevelGlyph } from "../src/tools/render-utils";

const ansiPattern = /\x1b\[[0-9;]*m/g;
const hyperlinkPattern = /\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g;

let uiTheme: Theme;
let priorShowResolvedModelBadge = false;

function renderJobText(details: Omit<CoordinationDetails, "op">, expanded = false, live = false, width = 160): string {
	const component = jobsRenderResult(
		{ content: [{ type: "text", text: "Listed background jobs" }], details: { op: "jobs", ...details } },
		{ expanded, isPartial: live, spinnerFrame: live ? 0 : undefined },
		uiTheme,
		{ op: "jobs" },
	);
	let text = component.render(width).join("\n");
	text = text.replace(hyperlinkPattern, "");
	text = text.replace(ansiPattern, "");
	return text;
}

describe("hub jobs task model badges", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	beforeEach(() => {
		priorShowResolvedModelBadge = settings.get("task.showResolvedModelBadge");
	});

	afterEach(() => {
		settings.override("task.showResolvedModelBadge", priorShowResolvedModelBadge);
		settings.clearOverride("task.showResolvedModelBadge");
		vi.restoreAllMocks();
	});

	it("keeps a literal thinking suffix in a completed task's identity with a separate thinking glyph", () => {
		settings.override("task.showResolvedModelBadge", true);
		const identity = "p/model:high";
		const text = renderJobText({
			jobs: [
				{
					id: "Architect",
					type: "task",
					status: "completed",
					label: "Architect",
					durationMs: 1_234,
					resultText: "done",
					resolvedModel: `${identity}:high`,
					resolvedModelIdentity: identity,
					resolvedThinkingLevel: ThinkingLevel.High,
				},
			],
		});

		expect(text).toContain(`${thinkingLevelGlyph(ThinkingLevel.High, uiTheme)} ${identity} Architect`);
		expect(text.split(identity).length - 1).toBe(1);
		expect(text).not.toContain(`${identity}:high`);
		expect(text).not.toContain(uiTheme.icon.advisor);
	});

	it("fits a long model badge around the agent name and duration at 60 columns", () => {
		settings.override("task.showResolvedModelBadge", true);
		const text = renderJobText(
			{
				jobs: [
					{
						id: "Architect",
						type: "task",
						status: "running",
						label: "Architect",
						durationMs: 1_234,
						resolvedModel: "provider/a-very-long-model-name-with-a-distinctive-tail:high",
						resolvedModelIdentity: "provider/a-very-long-model-name-with-a-distinctive-tail",
						resolvedThinkingLevel: ThinkingLevel.High,
						advisor: true,
					},
				],
			},
			false,
			true,
			60,
		);
		const row = text.split("\n")[1]!;

		expect(row).toContain(`${uiTheme.icon.advisor} Architect`);
		expect(row).toContain(thinkingLevelGlyph(ThinkingLevel.High, uiTheme));
		expect(row).toContain("…");
		expect(row).toEndWith("1.2s");
		for (const line of text.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("keeps the ID and badge ahead of a long description and preserves expanded continuation", () => {
		settings.override("task.showResolvedModelBadge", true);
		const text = renderJobText(
			{
				jobs: [
					{
						id: "Architect",
						type: "task",
						status: "completed",
						label: `Architect ${"設計".repeat(40)}\nFollow-up design details`,
						durationMs: 1_234,
						resolvedModel: "provider/a-very-long-model-name-with-a-distinctive-tail:high",
						resolvedModelIdentity: "provider/a-very-long-model-name-with-a-distinctive-tail",
						resolvedThinkingLevel: ThinkingLevel.High,
						advisor: true,
					},
				],
			},
			true,
			false,
			60,
		);
		const row = text.split("\n")[1]!;

		expect(row).toContain(`${uiTheme.icon.advisor} Architect`);
		expect(row).toContain("task");
		expect(row).toEndWith("1.2s");
		expect(text.split("\n")[2]).toContain("Architect 設計");
		expect(text.split("\n")[3]).toContain("Follow-up design details");
		for (const line of text.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("renders a running task snapshot's advisor badge and keeps it on the settled result", async () => {
		settings.override("task.showResolvedModelBadge", true);
		const identity = "p/runtime:max";
		const reported = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<string>();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const id = manager.register(
			"task",
			"Architect",
			async ({ reportProgress }) => {
				await reportProgress("running", {
					progress: [
						{
							id: "Architect",
							resolvedModel: `${identity}:max`,
							resolvedModelIdentity: identity,
							resolvedThinkingLevel: ThinkingLevel.Max,
							advisor: true,
						},
					],
				});
				reported.resolve();
				return finish.promise;
			},
			{ id: "Architect" },
		);
		await reported.promise;

		const session = { asyncJobManager: manager } as unknown as ToolSession;
		try {
			const text = renderJobText({ jobs: snapshotJobs(session, manager.getAllJobs()) }, false, true);
			const prefix = `${thinkingLevelGlyph(ThinkingLevel.Max, uiTheme)} ${identity} ${uiTheme.icon.advisor} Architect`;
			expect(text).toContain(prefix);
			expect(text.split(identity).length - 1).toBe(1);
			expect(text).not.toContain(`${identity}:max`);

			finish.resolve("finished architecture review");
			await manager.getJob(id)?.promise;
			const settled = renderJobText({ jobs: snapshotJobs(session, manager.getAllJobs()) });
			expect(settled).toContain(prefix);
		} finally {
			finish.resolve("done");
			await manager.getJob(id)?.promise;
		}
	});

	it("preserves a legacy selector without inferring a thinking glyph", () => {
		settings.override("task.showResolvedModelBadge", true);
		const text = renderJobText({
			jobs: [
				{
					id: "Legacy",
					type: "task",
					status: "completed",
					label: "Legacy",
					durationMs: 0,
					resolvedModel: "p/model:high",
				},
			],
		});

		expect(text).toContain("p/model:high Legacy");
		expect(text).not.toContain(thinkingLevelGlyph(ThinkingLevel.High, uiTheme));
	});

	it("hides a task job's resolved model selector when the badge setting is disabled", () => {
		settings.override("task.showResolvedModelBadge", false);
		const selector = "p/model:high";
		const text = renderJobText({
			jobs: [
				{
					id: "Architect",
					type: "task",
					status: "completed",
					label: "Architect",
					durationMs: 1_234,
					resultText: "done",
					resolvedModel: selector,
					advisor: true,
				},
			],
		});

		expect(text).toContain("Architect");
		expect(text).not.toContain("p/model");
		expect(text).not.toContain(thinkingLevelGlyph(ThinkingLevel.High, uiTheme));
		expect(text).not.toContain(uiTheme.icon.advisor);
	});

	it("does not render resolved model metadata on bash job rows", () => {
		settings.override("task.showResolvedModelBadge", true);
		const selector = "p/model:high";
		const text = renderJobText({
			jobs: [
				{
					id: "shell-1",
					type: "bash",
					status: "completed",
					label: "bun test packages/coding-agent/src/tools/__tests__/job-render.test.ts",
					durationMs: 1_234,
					resultText: "ok",
					resolvedModel: selector,
					advisor: true,
				},
			],
		});

		expect(text).toContain("shell-1");
		expect(text).toContain("bash");
		expect(text).not.toContain("p/model");
		expect(text).not.toContain(uiTheme.icon.advisor);
	});

	it("renders model-bearing task jobs before settings initialization", async () => {
		resetSettingsForTest();
		try {
			const text = renderJobText({
				jobs: [
					{
						id: "ColdStart",
						type: "task",
						status: "failed",
						label: "ColdStart",
						durationMs: 0,
						resolvedModelIdentity: "provider/model",
						advisor: true,
					},
				],
			});
			expect(text).toContain("ColdStart");
			expect(text).toContain("task");
			expect(text).not.toContain("provider/model");
			expect(text).not.toContain(uiTheme.icon.advisor);
		} finally {
			await Settings.init({ inMemory: true });
		}
	});

	it("reserves custom tree prefixes and task status for long IDs with badges on or off", () => {
		const priorTree = Object.getOwnPropertyDescriptor(uiTheme, "tree");
		try {
			Object.defineProperty(uiTheme, "tree", {
				configurable: true,
				value: { ...uiTheme.tree, branch: "界├", last: "界界└", vertical: "界界│" },
			});
			for (const enabled of [true, false]) {
				settings.override("task.showResolvedModelBadge", enabled);
				for (const width of [40, 120]) {
					const id = `LongWorker${"界".repeat(40)}`;
					const text = renderJobText(
						{
							jobs: [
								{
									id,
									type: "task",
									status: "failed",
									label: id,
									durationMs: 1000,
									resolvedModelIdentity: "provider/model",
									advisor: true,
								},
							],
						},
						false,
						false,
						width,
					);
					const row = text.split("\n")[1]!;
					expect(row).toStartWith("界界└ ");
					expect(row).toEndWith(formatDuration(1000));
					expect(row).toContain("LongWorker");
					expect(row).toContain("task");
					for (const line of text.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		} finally {
			if (priorTree) Object.defineProperty(uiTheme, "tree", priorTree);
			else Reflect.deleteProperty(uiTheme, "tree");
		}
	});

	it("renders task rows with missing or malformed resolved model metadata without leaking bogus badges", () => {
		settings.override("task.showResolvedModelBadge", true);
		const text = renderJobText(
			{
				jobs: [
					{
						id: "NoModel",
						type: "task",
						status: "completed",
						label: "missing model metadata",
						durationMs: 0,
						resultText: "done",
					},
					{
						id: "NumericModel",
						type: "task",
						status: "completed",
						label: "numeric model metadata",
						durationMs: 0,
						resultText: "done",
						resolvedModel: 9_001,
					},
					{
						id: "ObjectModel",
						type: "task",
						status: "completed",
						label: "object model metadata",
						durationMs: 0,
						resultText: "done",
						resolvedModel: { selector: "not-a-renderable-selector" },
					},
				],
			} as unknown as Omit<CoordinationDetails, "op">,
			true,
		);

		expect(text).toContain("missing model metadata");
		expect(text).toContain("numeric model metadata");
		expect(text).toContain("object model metadata");
		expect(text).not.toContain("9001");
		expect(text).not.toContain("[object Object]");
		expect(text).not.toContain("not-a-renderable-selector");
	});
});
