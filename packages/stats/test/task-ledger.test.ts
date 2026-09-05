import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { syncAllSessions } from "@pk-nerdsaver-ai/omp-stats/aggregator";
import { closeDb } from "@pk-nerdsaver-ai/omp-stats/db";
import {
	aggregateTasks,
	getRecentTaskStats,
	getTaskEconomicsByModel,
} from "@pk-nerdsaver-ai/omp-stats/task-aggregator";
import type { MessageStats, UserMessageStats } from "@pk-nerdsaver-ai/omp-stats/types";
import { getAgentDir, getSessionsDir, setAgentDir, TempDir } from "@pk-nerdsaver-ai/pi-utils";

function usage(input: number, output: number, total: number) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}

function request(overrides: Partial<MessageStats> & { entryId: string }): MessageStats {
	return {
		sessionFile: "s1.jsonl",
		folder: "/work",
		model: "gpt-4o",
		provider: "openai",
		api: "openai-completions",
		timestamp: 0,
		duration: null,
		ttft: null,
		stopReason: "stop",
		errorMessage: null,
		usage: usage(0, 0, 0),
		agentType: "main",
		...overrides,
	};
}

function user(overrides: Partial<UserMessageStats> & { entryId: string; timestamp: number }): UserMessageStats {
	return {
		sessionFile: "s1.jsonl",
		folder: "/work",
		model: null,
		provider: null,
		chars: 10,
		words: 2,
		yelling: 0,
		profanity: 0,
		anguish: 0,
		negation: 0,
		repetition: 0,
		blame: 0,
		...overrides,
	};
}

describe("aggregateTasks", () => {
	it("groups by anchor and excludes idle time from wallMs", () => {
		const users = [user({ entryId: "u1", timestamp: 1000 }), user({ entryId: "u2", timestamp: 200000 })];
		const requests = [
			request({ entryId: "a1", timestamp: 1500, duration: 500, ttft: 200, usage: usage(100, 50, 0.03) }),
			// ~98s idle gap: a later timestamp must not inflate wallMs.
			request({ entryId: "a2", timestamp: 99000, duration: 800, ttft: 150, usage: usage(200, 100, 0.06) }),
			request({
				entryId: "a3",
				timestamp: 201000,
				duration: 400,
				ttft: 100,
				model: "claude-3-7",
				provider: "anthropic",
				usage: usage(150, 80, 0.045),
			}),
		];

		const tasks = aggregateTasks(requests, users);
		expect(tasks).toHaveLength(2);

		const first = tasks[0];
		expect(first.taskId).toBe("s1.jsonl#u1");
		expect(first.startedAt).toBe(1000);
		expect(first.completedAt).toBe(99000);
		expect(first.wallMs).toBe(1300);
		expect(first.ttftMs).toBe(200);
		expect(first.inputTokens).toBe(300);
		expect(first.outputTokens).toBe(150);
		expect(first.requestCount).toBe(2);
		expect(first.costUsd).toBeCloseTo(0.09, 9);

		const second = tasks[1];
		expect(second.taskId).toBe("s1.jsonl#u2");
		expect(second.model).toBe("claude-3-7");
		expect(second.provider).toBe("anthropic");
		expect(second.wallMs).toBe(400);
		expect(second.requestCount).toBe(1);
	});

	it("keeps post-tool assistant requests in the same task span", () => {
		// a2's parent in the session log is a tool result, not u1 — grouping
		// keys on the confirmed anchor (timestamp order), never parent chains.
		const users = [user({ entryId: "u1", timestamp: 1000 })];
		const requests = [
			request({ entryId: "a1", timestamp: 1500, duration: 500, stopReason: "toolUse" }),
			request({ entryId: "a2", timestamp: 3500, duration: 800 }),
		];
		const tasks = aggregateTasks(requests, users);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].requestCount).toBe(2);
		expect(tasks[0].stopReason).toBe("stop");
	});

	it("excludes orphan requests with no preceding user message", () => {
		const users = [user({ entryId: "u1", timestamp: 5000 })];
		const requests = [
			request({ entryId: "a0", timestamp: 1000, duration: 100 }),
			request({ entryId: "a1", timestamp: 6000, duration: 200 }),
		];
		const tasks = aggregateTasks(requests, users);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].taskId).toBe("s1.jsonl#u1");
		expect(tasks[0].requestCount).toBe(1);
	});

	it("groups per sessionFile independently and returns [] for empty input", () => {
		const users = [
			user({ sessionFile: "s1.jsonl", entryId: "u1", timestamp: 1000 }),
			user({ sessionFile: "s2.jsonl", entryId: "u1", folder: "/other", timestamp: 1000 }),
		];
		const requests = [
			request({ sessionFile: "s1.jsonl", entryId: "a1", timestamp: 1500, duration: 100 }),
			request({ sessionFile: "s2.jsonl", entryId: "b1", folder: "/other", timestamp: 1500, duration: 200 }),
		];
		const tasks = aggregateTasks(requests, users);
		expect(tasks.map(task => task.taskId).sort()).toEqual(["s1.jsonl#u1", "s2.jsonl#u1"]);
		expect(aggregateTasks([], [])).toEqual([]);
	});
});

describe("task ledger queries", () => {
	const originalConfigDir = process.env.PI_CONFIG_DIR;
	const originalAgentDir = getAgentDir();
	let tempDir: TempDir | null = null;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-stats-ledger-");
		const configDir = path.relative(os.homedir(), tempDir.join("config"));
		process.env.PI_CONFIG_DIR = configDir;
		setAgentDir(path.join(os.homedir(), configDir, "agent"));
	});

	afterEach(() => {
		closeDb();
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		setAgentDir(originalAgentDir);
		try {
			tempDir?.removeSync();
		} catch {
			// leave it to the OS temp reaper
		}
		tempDir = null;
	});

	const base = Date.now() - 300000;
	const iso = (ms: number) => new Date(ms).toISOString();

	function userEntry(id: string, ms: number): Record<string, unknown> {
		return {
			type: "message",
			id,
			timestamp: iso(ms),
			message: { role: "user", content: [{ type: "text", text: `prompt ${id}` }] },
		};
	}

	function assistantEntry(opts: {
		id: string;
		parentId: string;
		model: string;
		provider: string;
		ms: number;
		duration: number;
		input: number;
		output: number;
		cost: number;
	}): Record<string, unknown> {
		return {
			type: "message",
			id: opts.id,
			parentId: opts.parentId,
			timestamp: iso(opts.ms),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "openai-completions",
				provider: opts.provider,
				model: opts.model,
				stopReason: "stop",
				timestamp: opts.ms,
				duration: opts.duration,
				ttft: opts.ttft,
				usage: {
					input: opts.input,
					output: opts.output,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: opts.input + opts.output,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: opts.cost },
				},
			},
		};
	}

	it("aggregates synced sessions into task spans end to end", async () => {
		const dir = path.join(getSessionsDir(), "--tmp--ledger");
		await fs.mkdir(dir, { recursive: true });
		const lines = [
			{ type: "session", version: 1, id: "s1", timestamp: iso(base), cwd: "/tmp/ledger" },
			userEntry("u1", base),
			assistantEntry({
				id: "a1",
				parentId: "u1",
				model: "gpt-4o",
				provider: "openai",
				ms: base + 1000,
				duration: 500,
				ttft: 200,
				input: 100,
				output: 50,
				cost: 0.03,
			}),
			// Post-tool assistant: parent is a tool result, must stay in task 1.
			assistantEntry({
				id: "a2",
				parentId: "tool-call-1",
				model: "gpt-4o",
				provider: "openai",
				ms: base + 99000,
				duration: 800,
				ttft: 150,
				input: 200,
				output: 100,
				cost: 0.06,
			}),
			userEntry("u2", base + 200000),
			assistantEntry({
				id: "a3",
				parentId: "u2",
				model: "claude-3-7",
				provider: "anthropic",
				ms: base + 201000,
				duration: 400,
				ttft: 100,
				input: 150,
				output: 80,
				cost: 0.045,
			}),
		];
		await fs.writeFile(path.join(dir, "01.jsonl"), `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);

		await syncAllSessions();

		const tasks = await getRecentTaskStats();
		expect(tasks).toHaveLength(2);
		expect(tasks[0].taskId.endsWith("#u2")).toBe(true);
		expect(tasks[0].wallMs).toBe(400);
		expect(tasks[1].taskId.endsWith("#u1")).toBe(true);
		expect(tasks[1].wallMs).toBe(1300);
		expect(tasks[1].requestCount).toBe(2);
		expect(tasks[1].costUsd).toBeCloseTo(0.09, 9);

		const economics = await getTaskEconomicsByModel();
		expect(economics).toHaveLength(2);
		const openai = economics.find(row => row.provider === "openai");
		expect(openai?.taskCount).toBe(1);
		expect(openai?.avgCostUsd).toBeCloseTo(0.09, 9);
		expect(openai?.avgWallMs).toBe(1300);
	});
});
