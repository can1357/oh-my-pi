import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TbStore } from "../src/tb/store";
import type { TrialRow } from "../src/tb/types";

function row(overrides: Partial<TrialRow> = {}): TrialRow {
	return {
		epoch: 1,
		model: "provider/model-a",
		task: "task-a",
		attempt: 1,
		status: "fail",
		reward: 0,
		agentTimedOut: false,
		inputTokens: 100,
		outputTokens: 20,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0.1,
		turns: 2,
		agentMs: 60_000,
		verifierMs: 1_000,
		wallMs: 61_000,
		error: null,
		trialDir: "trials/e1/provider_model-a/task-a-a1",
		startedAt: 1,
		finishedAt: 2,
		...overrides,
	};
}

describe("TbStore", () => {
	let directory: string;
	let store: TbStore;

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "tb-store-"));
		store = new TbStore(path.join(directory, "trials.sqlite"));
	});

	afterEach(() => {
		store.close();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test("tracks unfinished and completed epochs", () => {
		expect(store.resumeEpoch()).toBeNull();
		const first = store.beginEpoch();
		expect(first).toBe(1);
		expect(store.resumeEpoch()).toBe(1);
		store.finishEpoch(first);
		expect(store.resumeEpoch()).toBeNull();
		expect(store.beginEpoch()).toBe(2);
	});

	test("upserts duplicate trial keys and records completed keys", () => {
		const epoch = store.beginEpoch();
		store.insertTrial(row({ epoch, status: "fail", reward: 0 }));
		store.insertTrial(row({ epoch, status: "pass", reward: 1, costUsd: 0.25 }));

		expect(store.completedKeys(epoch)).toEqual(new Set(["provider/model-a\u0000task-a\u00001"]));
		const summary = store.epochSummary(epoch);
		expect(summary).toHaveLength(1);
		expect(summary[0]?.trials).toBe(1);
		expect(summary[0]?.passed).toBe(1);
		expect(summary[0]?.meanReward).toBe(1);
		expect(store.epochSpend(epoch)).toBeCloseTo(0.25);
	});

	test("aggregates mixed outcomes by model", () => {
		const epoch = store.beginEpoch();
		store.insertTrial(
			row({ epoch, model: "provider/model-a", task: "pass", status: "pass", reward: 1, costUsd: 0.1 }),
		);
		store.insertTrial(
			row({ epoch, model: "provider/model-a", task: "fail", status: "fail", reward: 0, costUsd: 0.2 }),
		);
		store.insertTrial(
			row({
				epoch,
				model: "provider/model-b",
				task: "error",
				status: "error",
				reward: null,
				agentTimedOut: true,
				costUsd: 0.05,
				error: "vm failed",
			}),
		);
		store.insertTrial(
			row({ epoch, model: "provider/model-b", task: "pass", status: "pass", reward: 1, costUsd: 0.15 }),
		);

		const summary = store.epochSummary(epoch);
		expect(summary).toHaveLength(2);
		expect(summary[0]).toMatchObject({
			model: "provider/model-a",
			trials: 2,
			passed: 1,
			errors: 0,
			meanReward: 0.5,
		});
		expect(summary[0]?.costUsd).toBeCloseTo(0.3);
		expect(summary[1]).toMatchObject({
			model: "provider/model-b",
			trials: 2,
			passed: 1,
			errors: 1,
			agentTimeouts: 1,
			meanReward: 0.5,
		});
		expect(summary[1]?.costUsd).toBeCloseTo(0.2);
		expect(store.epochSpend(epoch)).toBeCloseTo(0.5);
		expect(store.overallSummary().map(item => item.model)).toEqual(["provider/model-a", "provider/model-b"]);
	});
});
