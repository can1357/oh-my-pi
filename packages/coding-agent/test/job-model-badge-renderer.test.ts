import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { snapshotJobs } from "../src/async/job-control";
import { AsyncJobManager } from "../src/async/job-manager";
import { resetSettingsForTest, Settings, settings } from "../src/config/settings";
import type { SingleResult, TaskToolDetails } from "../src/task/task-details";
import { cfgTaskShowResolvedModelBadge } from "../src/task/settings";
import type { ToolSession } from "../src/tools";
import type { EvalToolDetails } from "../src/tools/details/eval";
import type { CoordinationDetails, JobSnapshot } from "../src/tools/details/wait";
import { thinkingLevelGlyph } from "../src/ui/tools/agent-common";
import { toolText } from "./helpers/tool-text";

const symbol = (key: string): string => currentTheme().symbols.symbol(key);
const thinking = (level: string): string => thinkingLevelGlyph(symbol, level);
const advisorIcon = (): string => symbol("icon.advisor");

/** A wait card listing `jobs`, expanded (model badges live on its job-tree rows). */
function waitText(jobs: readonly unknown[], options: { width?: number; live?: boolean } = {}): string {
	const details = { op: "wait", jobs } as unknown as CoordinationDetails;
	return toolText({
		name: "wait",
		args: {},
		result: { content: [{ type: "text", text: "Listed background jobs" }], details },
		partial: options.live === true,
		expanded: true,
		width: options.width ?? 160,
	});
}

/** The row of the job whose id or label contains `needle`. */
function rowWith(text: string, needle: string): string {
	const row = text.split("\n").find(line => line.includes(needle));
	if (row === undefined) throw new Error(`no row with ${needle} in:\n${text}`);
	return row;
}

function badgeOn(enabled: boolean): void {
	cfgTaskShowResolvedModelBadge.override(settings, enabled);
}

describe("resolved model badges", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		cfgTaskShowResolvedModelBadge.clearOverride(settings);
	});

	describe("wait card job rows", () => {
		it("keeps a literal thinking suffix in a completed task's identity with a separate thinking glyph", () => {
			badgeOn(true);
			const identity = "p/model:high";
			const text = waitText([
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
			]);

			expect(text).toContain(`${thinking("high")} ${identity} Architect`);
			expect(text.split(identity).length - 1).toBe(1);
			expect(text).not.toContain(`${identity}:high`);
			expect(text).not.toContain(advisorIcon());
		});

		it("fits a long model badge around the agent name and duration at 60 columns", () => {
			badgeOn(true);
			const text = waitText(
				[
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
				{ width: 60, live: true },
			);
			const row = rowWith(text, "Architect");

			expect(row).toContain(`${advisorIcon()} Architect`);
			expect(row).toContain(thinking("high"));
			expect(row).toContain("…");
			expect(row.trimEnd()).toEndWith("1.2s");
			for (const line of text.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		});

		it("draws a running job snapshot's model and advisor and keeps them once it settles", async () => {
			badgeOn(true);
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
			const prefix = `${thinking("max")} ${identity} ${advisorIcon()} Architect`;
			try {
				const live = waitText(snapshotJobs(session, manager.getAllJobs()), { live: true });
				expect(live).toContain(prefix);
				expect(live.split(identity).length - 1).toBe(1);
				expect(live).not.toContain(`${identity}:max`);

				finish.resolve("finished architecture review");
				await manager.getJob(id)?.promise;
				expect(waitText(snapshotJobs(session, manager.getAllJobs()))).toContain(prefix);
			} finally {
				finish.resolve("done");
				await manager.getJob(id)?.promise;
			}
		});

		it("shows a legacy selector as given without inferring a thinking glyph", () => {
			badgeOn(true);
			const text = waitText([
				{
					id: "Legacy",
					type: "task",
					status: "completed",
					label: "Legacy",
					durationMs: 0,
					resolvedModel: "p/model:high",
				},
			]);

			expect(text).toContain("p/model:high Legacy");
			expect(text).not.toContain(thinking("high"));
		});

		it("hides a task job's model when the badge setting is off", () => {
			badgeOn(false);
			const text = waitText([
				{
					id: "Architect",
					type: "task",
					status: "completed",
					label: "Architect",
					durationMs: 1_234,
					resultText: "done",
					resolvedModel: "p/model:high",
					resolvedThinkingLevel: ThinkingLevel.High,
					advisor: true,
				},
			]);

			expect(text).toContain("Architect");
			expect(text).not.toContain("p/model");
			expect(text).not.toContain(thinking("high"));
			expect(text).not.toContain(advisorIcon());
		});

		it("never badges bash job rows", () => {
			badgeOn(true);
			const text = waitText([
				{
					id: "shell-1",
					type: "bash",
					status: "completed",
					label: "bun test",
					durationMs: 1_234,
					resultText: "ok",
					resolvedModel: "p/model:high",
					advisor: true,
				},
			]);

			expect(text).toContain("shell-1");
			expect(text).not.toContain("p/model");
			expect(text).not.toContain(advisorIcon());
		});

		it("draws model-bearing task jobs without a badge before settings load", async () => {
			resetSettingsForTest();
			try {
				const text = waitText([
					{
						id: "ColdStart",
						type: "task",
						status: "failed",
						label: "ColdStart",
						durationMs: 0,
						resolvedModelIdentity: "provider/model",
						advisor: true,
					},
				]);
				expect(text).toContain("ColdStart");
				expect(text).not.toContain("provider/model");
				expect(text).not.toContain(advisorIcon());
			} finally {
				await Settings.init({ inMemory: true });
			}
		});

		it("keeps long ids, the type badge and the duration within the width with badges on or off", () => {
			for (const enabled of [true, false]) {
				badgeOn(enabled);
				for (const width of [40, 120]) {
					const id = `LongWorker${"界".repeat(40)}`;
					const text = waitText(
						[
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
						{ width },
					);
					const row = rowWith(text, "LongWorker");
					expect(row.trimEnd()).toEndWith(formatDuration(1000));
					expect(row).toContain("task");
					for (const line of text.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		});

		it("draws no badge from missing or malformed model metadata", () => {
			badgeOn(true);
			const jobs: Partial<Record<keyof JobSnapshot, unknown>>[] = [
				{ id: "NoModel", type: "task", status: "completed", label: "missing model metadata", durationMs: 0 },
				{
					id: "NumericModel",
					type: "task",
					status: "completed",
					label: "numeric model metadata",
					durationMs: 0,
					resolvedModel: 9_001,
				},
				{
					id: "ObjectModel",
					type: "task",
					status: "completed",
					label: "object model metadata",
					durationMs: 0,
					resolvedModel: { selector: "not-a-renderable-selector" },
				},
			];
			const text = waitText(jobs);

			expect(text).toContain("missing model metadata");
			expect(text).toContain("numeric model metadata");
			expect(text).toContain("object model metadata");
			expect(text).not.toContain("9001");
			expect(text).not.toContain("[object Object]");
			expect(text).not.toContain("not-a-renderable-selector");
		});
	});

	describe("task card agent rows", () => {
		function result(overrides: Partial<SingleResult>): SingleResult {
			return {
				index: 0,
				id: "Architect",
				agent: "task",
				agentSource: "bundled",
				task: "Design the cache",
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 1_234,
				tokens: 0,
				requests: 1,
				...overrides,
			};
		}

		function taskText(results: SingleResult[]): string {
			const details: TaskToolDetails = { projectAgentsDir: null, results, totalDurationMs: 1_234 };
			return toolText({
				name: "task",
				args: { tasks: results.map(entry => ({ id: entry.id, assignment: entry.task })) },
				result: { content: [{ type: "text", text: "done" }], details },
				width: 160,
			});
		}

		it("leads a settled agent's name with its thinking glyph, model and advisor while the setting is on", () => {
			const settled = result({
				resolvedModel: "p/model:high",
				resolvedModelIdentity: "p/model",
				resolvedThinkingLevel: ThinkingLevel.High,
				advisor: true,
			});
			badgeOn(true);
			expect(rowWith(taskText([settled]), "Architect")).toContain(
				`${thinking("high")} p/model ${advisorIcon()} Architect`,
			);

			badgeOn(false);
			const off = taskText([settled]);
			expect(off).toContain("Architect");
			expect(off).not.toContain("p/model");
			expect(off).not.toContain(advisorIcon());
		});
	});

	describe("eval agent rows", () => {
		function evalText(): string {
			const details: EvalToolDetails = {
				cells: [
					{
						index: 0,
						code: "await agent('Scout')",
						language: "js",
						output: "",
						status: "complete",
						durationMs: 1_000,
						statusEvents: [
							{
								op: "agent",
								id: "Scout",
								status: "completed",
								resolvedModelIdentity: "p/scout",
								resolvedThinkingLevel: ThinkingLevel.Low,
								advisor: true,
								durationMs: 1_000,
							},
						],
					},
				],
			};
			return toolText({
				name: "eval",
				args: { cells: [{ code: "await agent('Scout')", language: "js" }] },
				result: { content: [{ type: "text", text: "" }], details },
				width: 160,
			});
		}

		it("leads an agent() row with its resolved model only while the setting is on", () => {
			badgeOn(true);
			// The agent rows hang under the cell box.
			expect(rowWith(evalText(), symbol("tree.last"))).toContain(
				`${thinking("low")} p/scout ${advisorIcon()} Scout`,
			);

			badgeOn(false);
			const off = evalText();
			expect(off).toContain("Scout");
			expect(off).not.toContain("p/scout");
		});
	});
});
