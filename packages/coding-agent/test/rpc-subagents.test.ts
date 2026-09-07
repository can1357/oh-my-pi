import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
	handleRpcSessionChange,
	type RpcSessionChangeCommand,
	type RpcSessionChangeResult,
	type RpcSessionChangeSession,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import {
	type AgentProgress,
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const tempPaths: string[] = [];

afterEach(() => {
	for (const tempPath of tempPaths.splice(0)) {
		removeSyncWithRetries(tempPath);
	}
});

function createProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "SubagentA",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Do work",
		assignment: "Implement work",
		description: "Worker",
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

function createRegistryWithSnapshot(): RpcSubagentRegistry {
	const eventBus = new EventBus();
	const registry = new RpcSubagentRegistry(eventBus, () => {});
	eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: "SubagentA",
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "started",
		sessionFile: "/tmp/subagent.jsonl",
	} satisfies SubagentLifecyclePayload);
	expect(registry.getSubagents()).toHaveLength(1);
	return registry;
}

type SessionChangeStubOptions = {
	newSession?: boolean;
	switchSession?: boolean;
	branch?: { selectedText: string; selectedImages: ImageContent[]; cancelled: boolean };
};

function createSessionChangeSession(options: SessionChangeStubOptions): RpcSessionChangeSession {
	return {
		newSession: async (_options?: unknown) => options.newSession ?? true,
		switchSession: async (_sessionPath: string) => options.switchSession ?? true,
		branch: async (_entryId: string) =>
			options.branch ?? { selectedText: "branched text", selectedImages: [], cancelled: false },
	};
}

describe("RPC subagent registry", () => {
	test("defaults subagent frame emission to off while tracking snapshots", () => {
		const frames: RpcSubagentFrame[] = [];
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		const lifecycle: SubagentLifecyclePayload = {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "Worker",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
			parentToolCallId: "toolu_parent",
		};
		const progressPayload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Implement work",
			parentToolCallId: "toolu_parent",
			sessionFile: "/tmp/subagent.jsonl",
			progress: createProgress(),
		};
		const eventPayload: SubagentEventPayload = {
			id: "SubagentA",
			event: { type: "agent_start" },
		};

		expect(registry.getSubscriptionLevel()).toBe("off");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);

		expect(frames).toHaveLength(0);
		expect(registry.getSubagents()).toMatchObject([
			{
				id: "SubagentA",
				status: "running",
				sessionFile: "/tmp/subagent.jsonl",
			},
		]);
		registry.dispose();
	});

	test("emits progress frames after explicit progress subscription and snapshots tracked subagents", () => {
		const frames: RpcSubagentFrame[] = [];
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		registry.setSubscriptionLevel("progress");
		const lifecycle: SubagentLifecyclePayload = {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "Worker",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
			parentToolCallId: "toolu_parent",
		};
		const progressPayload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Implement work",
			parentToolCallId: "toolu_parent",
			sessionFile: "/tmp/subagent.jsonl",
			progress: createProgress(),
		};

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);

		expect(frames.map(frame => frame.type)).toEqual(["subagent_lifecycle", "subagent_progress"]);
		expect(registry.getSubagents()).toMatchObject([
			{
				id: "SubagentA",
				status: "running",
				task: "Do work",
				assignment: "Implement work",
				sessionFile: "/tmp/subagent.jsonl",
				parentToolCallId: "toolu_parent",
			},
		]);

		registry.dispose();
	});

	test("clears stale snapshots when the active RPC session changes", () => {
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, () => {});
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(1);
		registry.clear();

		expect(registry.getSubagents()).toHaveLength(0);
		registry.dispose();
	});

	test("clears stale snapshots after successful RPC session changes", async () => {
		const cases: Array<{
			command: RpcSessionChangeCommand;
			session: RpcSessionChangeSession;
			expected: RpcSessionChangeResult;
		}> = [
			{
				command: { type: "new_session", parentSession: "/tmp/parent.jsonl" },
				session: createSessionChangeSession({ newSession: true }),
				expected: { type: "new_session", data: { cancelled: false } },
			},
			{
				command: { type: "switch_session", sessionPath: "/tmp/next.jsonl" },
				session: createSessionChangeSession({ switchSession: true }),
				expected: { type: "switch_session", data: { cancelled: false } },
			},
			{
				command: { type: "branch", entryId: "entry-1" },
				session: createSessionChangeSession({
					branch: { selectedText: "Branch text", selectedImages: [], cancelled: false },
				}),
				expected: { type: "branch", data: { text: "Branch text", cancelled: false } },
			},
		];

		for (const testCase of cases) {
			const registry = createRegistryWithSnapshot();
			try {
				const result = await handleRpcSessionChange(testCase.session, testCase.command, registry);

				expect(result).toEqual(testCase.expected);
				expect(registry.getSubagents()).toHaveLength(0);
				expect(() => registry.resolveSessionFile({ subagentId: "SubagentA" })).toThrow(
					/Unknown subagent or session file unavailable/,
				);
			} finally {
				registry.dispose();
			}
		}
	});

	test("keeps stale snapshots when RPC session changes are cancelled", async () => {
		const cases: Array<{
			command: RpcSessionChangeCommand;
			session: RpcSessionChangeSession;
			expected: RpcSessionChangeResult;
		}> = [
			{
				command: { type: "new_session", parentSession: "/tmp/parent.jsonl" },
				session: createSessionChangeSession({ newSession: false }),
				expected: { type: "new_session", data: { cancelled: true } },
			},
			{
				command: { type: "switch_session", sessionPath: "/tmp/next.jsonl" },
				session: createSessionChangeSession({ switchSession: false }),
				expected: { type: "switch_session", data: { cancelled: true } },
			},
			{
				command: { type: "branch", entryId: "entry-1" },
				session: createSessionChangeSession({ branch: { selectedText: "", selectedImages: [], cancelled: true } }),
				expected: { type: "branch", data: { text: "", cancelled: true } },
			},
		];

		for (const testCase of cases) {
			const registry = createRegistryWithSnapshot();
			try {
				const result = await handleRpcSessionChange(testCase.session, testCase.command, registry);

				expect(result).toEqual(testCase.expected);
				expect(registry.getSubagents()).toMatchObject([{ id: "SubagentA" }]);
				expect(registry.resolveSessionFile({ subagentId: "SubagentA" })).toBe("/tmp/subagent.jsonl");
			} finally {
				registry.dispose();
			}
		}
	});

	test("prunes terminal lifecycle snapshots while retaining transcript selectors", () => {
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, () => {});
		const sessionFile = "/tmp/subagent.jsonl";
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile,
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(1);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			sessionFile,
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(0);
		expect(registry.resolveSessionFile({ subagentId: "SubagentA" })).toBe(sessionFile);
		expect(registry.resolveSessionFile({ sessionFile })).toBe(sessionFile);
		registry.dispose();
	});

	test("gates raw subagent events behind the events subscription level", () => {
		const frames: RpcSubagentFrame[] = [];
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		const eventPayload: SubagentEventPayload = {
			id: "SubagentA",
			event: { type: "agent_start" },
		};

		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);
		expect(frames).toHaveLength(0);

		registry.setSubscriptionLevel("events");
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);

		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({ type: "subagent_event", payload: eventPayload });
		registry.dispose();
	});
});

describe("readRpcSubagentTranscript", () => {
	test("returns complete JSONL entries and byte cursor", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const headerLine = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n`;
		const messageLine = `${JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-06-09T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		})}\n`;
		await Bun.write(sessionFile, `${headerLine}${messageLine}{"type":"message"`);

		const result = await readRpcSubagentTranscript(sessionFile);

		expect(result.entries).toHaveLength(2);
		expect(result.messages).toHaveLength(1);
		expect(result.nextByte).toBe(Buffer.byteLength(`${headerLine}${messageLine}`, "utf8"));
		expect(result.reset).toBe(false);
	});

	test("returns empty cursor result for missing transcript files", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-missing-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "missing.jsonl");

		const result = await readRpcSubagentTranscript(sessionFile, 42);

		expect(result).toEqual({
			sessionFile,
			fromByte: 42,
			nextByte: 42,
			reset: false,
			entries: [],
			messages: [],
		});
	});

	test("caps reads by bytes without splitting lines or code points", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-capped-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const headerLine = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n`;
		// Multi-byte content means a naive byte cut can split a code point; every
		// line stays well under the cap so each window always contains a newline.
		const lines = [headerLine];
		for (let i = 0; i < 12; i++) {
			lines.push(
				`${JSON.stringify({
					type: "message",
					id: `m${i}`,
					parentId: "s1",
					timestamp: "2026-06-09T00:00:00.000Z",
					message: { role: "user", content: [{ type: "text", text: `🌍📖 ${(i + 1).toString().repeat(40)}` }] },
				})}\n`,
			);
		}
		await Bun.write(sessionFile, lines.join(""));

		const full = await readRpcSubagentTranscript(sessionFile);
		let fromByte = 0;
		const seen = [];
		for (let window = 0; window < 200; window++) {
			const read = await readRpcSubagentTranscript(sessionFile, fromByte, { maxBytes: 512 });
			if (read.nextByte === fromByte) break;
			expect(read.messages.length).toBeGreaterThan(0);
			seen.push(...read.messages);
			fromByte = read.nextByte;
			expect(fromByte).toBeLessThanOrEqual(full.nextByte);
		}

		expect(seen).toEqual(full.messages);
		expect(fromByte).toBe(full.nextByte);
	});

	test("covers continuation past nextByte after the transcript grows", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-append-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const headerLine = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n`;
		const firstLine = `${JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-06-09T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "first" }] },
		})}\n`;
		await Bun.write(sessionFile, `${headerLine}${firstLine}`);

		const first = await readRpcSubagentTranscript(sessionFile);
		expect(first.nextByte).toBe(Buffer.byteLength(`${headerLine}${firstLine}`, "utf8"));

		const secondLine = `${JSON.stringify({
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: "2026-06-09T00:00:01.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "🌍 final" }] },
		})}\n`;
		fs.appendFileSync(sessionFile, secondLine);

		const resumed = await readRpcSubagentTranscript(sessionFile, first.nextByte);
		expect(resumed.messages).toHaveLength(1);
		expect(resumed.nextByte).toBe(first.nextByte + Buffer.byteLength(secondLine, "utf8"));
	});

	test("delivers an oversized record whole by spanning past the byte cap", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-oversized-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const headerLine = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n`;
		const giantText = "x".repeat(2000);
		const giantLine = `${JSON.stringify({
			type: "message",
			id: "giant",
			parentId: "s1",
			timestamp: "2026-06-09T00:00:00.000Z",
			message: { role: "assistant", content: [{ type: "text", text: giantText }] },
		})}\n`;
		const tailLine = `${JSON.stringify({
			type: "message",
			id: "tail",
			parentId: "giant",
			timestamp: "2026-06-09T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "after" }] },
		})}\n`;
		await Bun.write(sessionFile, `${headerLine}${giantLine}${tailLine}`);

		const full = await readRpcSubagentTranscript(sessionFile);
		let fromByte = 0;
		const seen = [];
		for (let window = 0; window < 100; window++) {
			const read = await readRpcSubagentTranscript(sessionFile, fromByte, { maxBytes: 512 });
			if (read.nextByte === fromByte) break;
			seen.push(...read.messages);
			fromByte = read.nextByte;
		}

		// The >512 KiB—well, >512-byte—record ships WHOLE inside a capped stream,
		// and polling never reports silent completion while data remains.
		expect(seen).toEqual(full.messages);
		expect(fromByte).toBe(full.nextByte);
		// Header yields no messages; the oversized record and the tail ride
		// together in the spanning window: [giant, tail].
		const giantSeen = seen[0] as { content: Array<{ text?: string }> };
		expect(giantSeen.content[0]?.text).toBe(giantText);
		expect(seen).toHaveLength(2);
	});

	test("reports pendingOversizedRecord instead of stalling silently", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-flag-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const headerLine = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n`;
		await Bun.write(sessionFile, `${headerLine}${"a".repeat(400)}\n`);

		// First window consumes the header normally.
		const first = await readRpcSubagentTranscript(sessionFile, 0, { maxBytes: 128 });
		expect(first.pendingOversizedRecord).toBeUndefined();
		expect(first.nextByte).toBe(Buffer.byteLength(headerLine, "utf8"));

		// The remaining record exceeds the caller-declared ceiling of 128:
		// unchanged cursor + explicit flag beats a fake completion signal.
		const stalled = await readRpcSubagentTranscript(sessionFile, first.nextByte, {
			maxBytes: 64,
			oversizedRecordCeilingBytes: 128,
		});
		expect(stalled.nextByte).toBe(first.nextByte);
		expect(stalled.messages).toEqual([]);
		expect(stalled.pendingOversizedRecord).toBe(true);

		// Reads without a cap keep returning plain results (flag absent).
		const uncapped = await readRpcSubagentTranscript(sessionFile, first.nextByte);
		expect(uncapped.messages).toHaveLength(0);
		expect(uncapped.pendingOversizedRecord).toBeUndefined();
		expect(uncapped.reset).toBe(false);
	});

	test("ordinary pages carry no oversized marker", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-plain-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const headerLine = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n`;
		const messageLine = `${JSON.stringify({
			type: "message",
			id: "m1",
			parentId: "s1",
			timestamp: "2026-06-09T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "small" }] },
		})}\n`;
		await Bun.write(sessionFile, `${headerLine}${messageLine}`);

		const page = await readRpcSubagentTranscript(sessionFile, 0, { maxBytes: 512 });

		expect(page.messages).toHaveLength(1);
		// A window ending on a complete line must not speculate about the next
		// record (no lookahead read ⇒ no premature flag key on the wire).
		expect("pendingOversizedRecord" in page).toBe(false);
	});
	test("degenerate finite budgets are floored and still make progress", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-floor-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const headerLine = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n`;
		const messageLine = `${JSON.stringify({
			type: "message",
			id: "m1",
			parentId: "s1",
			timestamp: "2026-06-09T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "small" }] },
		})}\n`;
		await Bun.write(sessionFile, `${headerLine}${messageLine}`);

		// A paginator feeding any validly-typed budget must observe cursor
		// movement: zero/negative/fractional values floor to a 1-byte minimum,
		// so polling terminates instead of seeing an unchanged nextByte forever.
		for (const maxBytes of [0, -5, 0.4]) {
			const read = await readRpcSubagentTranscript(sessionFile, 0, { maxBytes });
			expect(read.nextByte).toBe(Buffer.byteLength(headerLine, "utf8"));
			expect(read.reset).toBe(false);
			expect(read.pendingOversizedRecord).toBeUndefined();
		}
		// Non-finite budgets keep their documented meaning: the cap is off.
		const uncapped = await readRpcSubagentTranscript(sessionFile, 0, { maxBytes: Number.NaN });
		expect(uncapped.messages).toHaveLength(1);
		expect(uncapped.nextByte).toBe(Buffer.byteLength(`${headerLine}${messageLine}`, "utf8"));
	});
});

describe("RpcClient subagent frames", () => {
	test("dispatches subagent frames and session-specific events", async () => {
		const scriptPath = path.join(os.tmpdir(), `omp-rpc-subagent-client-${Date.now()}.js`);
		tempPaths.push(scriptPath);
		await Bun.write(
			scriptPath,
			`
let buffer = "";
function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}
const progress = {
	index: 0,
	id: "SubagentA",
	agent: "task",
	agentSource: "bundled",
	status: "running",
	task: "Do work",
	assignment: "Implement work",
	recentTools: [],
	recentOutput: [],
	toolCount: 0,
	tokens: 0,
	cost: 0,
	durationMs: 0
};
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});
function handle(frame) {
	if (frame.type === "set_subagent_subscription") {
		write({ id: frame.id, type: "response", command: "set_subagent_subscription", success: true, data: { level: frame.level } });
		return;
	}
	if (frame.type === "get_subagents") {
		write({ id: frame.id, type: "response", command: "get_subagents", success: true, data: { subagents: [{ id: "SubagentA", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1 }] } });
		return;
	}
	if (frame.type === "get_subagent_messages") {
		write({ id: frame.id, type: "response", command: "get_subagent_messages", success: true, data: { sessionFile: frame.sessionFile || "/tmp/subagent.jsonl", fromByte: frame.fromByte || 0, nextByte: 0, reset: false, entries: [], messages: [] } });
		return;
	}
	if (frame.type === "prompt") {
		write({ id: frame.id, type: "response", command: "prompt", success: true });
		write({ type: "notice", level: "info", message: "subagent test" });
		write({ type: "subagent_lifecycle", payload: { id: "SubagentA", index: 0, agent: "task", agentSource: "bundled", status: "started", sessionFile: "/tmp/subagent.jsonl" } });
		write({ type: "subagent_progress", payload: { index: 0, agent: "task", agentSource: "bundled", task: "Do work", assignment: "Implement work", sessionFile: "/tmp/subagent.jsonl", progress } });
		write({ type: "subagent_event", payload: { id: "SubagentA", event: { type: "agent_start" } } });
		write({ type: "agent_end", messages: [] });
	}
}
`,
		);

		using client = new RpcClient({ cliPath: scriptPath });
		const lifecycleIds: string[] = [];
		const progressTasks: string[] = [];
		const rawEventTypes: string[] = [];
		const sessionEventTypes: string[] = [];
		client.onSubagentLifecycle(payload => lifecycleIds.push(payload.id));
		client.onSubagentProgress(payload => progressTasks.push(payload.task));
		client.onSubagentEvent(payload => rawEventTypes.push(payload.event.type));
		client.onSessionEvent(event => sessionEventTypes.push(event.type));

		await client.start();
		await expect(client.setSubagentSubscription("events")).resolves.toBe("events");
		await client.promptAndWait("Trigger subagent frames");
		expect(await client.getSubagents()).toHaveLength(1);
		expect(await client.getSubagentMessages({ sessionFile: "/tmp/subagent.jsonl" })).toMatchObject({
			sessionFile: "/tmp/subagent.jsonl",
		});

		expect(lifecycleIds).toEqual(["SubagentA"]);
		expect(progressTasks).toEqual(["Do work"]);
		expect(rawEventTypes).toEqual(["agent_start"]);
		expect(sessionEventTypes).toContain("notice");
	});

	test("forwards nested subagent frames published on the shared observability bus", () => {
		const frames: RpcSubagentFrame[] = [];
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		registry.setSubscriptionLevel("events");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "Kid",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			parentToolCallId: "call-1",
			index: 1,
		} satisfies SubagentLifecyclePayload);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "Kid.Grandkid",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			parentToolCallId: "call-2",
			index: 2,
		} satisfies SubagentLifecyclePayload);
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			id: "Kid.Grandkid",
			event: { type: "agent_start" } as SubagentEventPayload["event"],
		} satisfies SubagentEventPayload);
		expect(frames.map(frame => frame.type)).toEqual(["subagent_lifecycle", "subagent_lifecycle", "subagent_event"]);
		expect((frames[1] as { payload: SubagentLifecyclePayload }).payload.id).toBe("Kid.Grandkid");
		expect((frames[2] as { payload: SubagentEventPayload }).payload.id).toBe("Kid.Grandkid");
		registry.dispose();
	});

	test("scopes observability to each root session — another tree's bus stays invisible", () => {
		const busA = new EventBus();
		const busB = new EventBus();
		const framesA: RpcSubagentFrame[] = [];
		const framesB: RpcSubagentFrame[] = [];
		const registryA = new RpcSubagentRegistry(busA, frame => framesA.push(frame));
		const registryB = new RpcSubagentRegistry(busB, frame => framesB.push(frame));
		registryA.setSubscriptionLevel("events");
		registryB.setSubscriptionLevel("events");
		busB.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "Kid",
			agent: "task",
			agentSource: "bundled",
			status: "started",
			index: 1,
		} satisfies SubagentLifecyclePayload);
		expect(framesA).toEqual([]);
		expect(framesB).toHaveLength(1);
		registryA.dispose();
		registryB.dispose();
	});
});
