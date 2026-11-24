/**
 * The status line's background-job badge: running jobs beside the running
 * subagents, a task job counted once its subagent is not yet registered.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AsyncJobType } from "@oh-my-pi/pi-coding-agent/async";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { disposeStatusLines, statusLine, statusSession } from "./helpers/session-status-line";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	disposeStatusLines();
});

function runningJob(type: AsyncJobType, index: number): AsyncJobSnapshotItem {
	const id = `${type}-${index}`;
	return {
		id,
		type,
		status: "running",
		label: `${type} ${index}`,
		startTime: index,
		agentId: type === "task" ? id : undefined,
	};
}

function makeLine(running: AsyncJobSnapshotItem[]) {
	return statusLine(statusSession({ getAsyncJobSnapshot: () => ({ running }) }), {
		preset: "custom",
		leftSegments: [],
		rightSegments: [],
		separator: "none",
		transparent: true,
	});
}

describe("status-line background-job badge", () => {
	it("counts non-task jobs without duplicating running task subagents", () => {
		const line = makeLine([runningJob("task", 0), runningJob("bash", 1), runningJob("eval", 2)]);
		line.setRunningSubagents(["task-0"]);
		expect(line.facts().subagents).toBe(1);
		expect(line.facts().jobs).toBe(2);
	});

	it("counts queued task jobs before their subagent is registered", () => {
		const line = makeLine([runningJob("task", 0)]);
		line.setRunningSubagents([]);
		expect(line.facts().jobs).toBe(1);
	});

	it("counts every running non-task job", () => {
		const line = makeLine([runningJob("bash", 1), runningJob("eval", 2)]);
		expect(line.facts().jobs).toBe(2);
	});
});
