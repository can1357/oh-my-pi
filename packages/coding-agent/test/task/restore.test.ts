import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getAgentTombstonePath } from "@oh-my-pi/pi-coding-agent/registry/agent-tombstone";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { recordSessionActivation } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: Date.now(),
		...fields,
	};
}

/** A turn the process died in, mid tool call (no result, no exit record). */
const cutOff: Message[] = [
	{ role: "user", content: "work", timestamp: Date.now() },
	assistant({
		content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }],
		stopReason: "toolUse",
	}),
];
/** A turn that ended on the model's own answer. */
const finished: Message[] = [
	{ role: "user", content: "work", timestamp: Date.now() },
	assistant({ content: [{ type: "text", text: "all done" }] }),
];

/** Writes subagent `id`'s transcript under the main session `mainFile`, with its spawn contract. */
async function writeSubagent(mainFile: string, cwd: string, id: string, messages: Message[]): Promise<string> {
	const file = path.join(mainFile.slice(0, -6), `${id}.jsonl`);
	const manager = await SessionManager.open(file, undefined, undefined, {
		initialCwd: cwd,
		parentSession: mainFile,
		suppressBreadcrumb: true,
	});
	manager.appendSessionInit({ systemPrompt: ["sub prompt"], task: `${id} task`, tools: ["read", "yield"] });
	for (const message of messages) manager.appendMessage(message);
	await manager.close();
	return file;
}

describe("restoreSession (omp --restore)", () => {
	const ids = ["Cut", "Done", "Killed", "Fresh"];
	let root: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;
	let manager: AsyncJobManager | undefined;

	afterEach(async () => {
		setSystemTime();
		vi.restoreAllMocks();
		await root?.dispose();
		root = undefined;
		authStorage?.close();
		authStorage = undefined;
		for (const id of ids) AgentRegistry.global().unregister(id);
		await manager?.dispose({ timeoutMs: 1000 });
		manager = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	async function createRoot(sessionManager: SessionManager): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected a bundled test model");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		manager = new AsyncJobManager({});
		root = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: createMockModel({ handler: () => ({ content: ["done"] }) }).stream,
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			ownedAsyncJobManager: manager,
		});
		return root;
	}

	async function recoverSubagents(): Promise<string[]> {
		if (!root) throw new Error("Expected a root agent session");
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue({
			index: 0,
			id: "Fresh",
			agent: "Fresh",
			agentSource: "user",
			task: "Fresh task",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 1,
		});
		const outcome = await restoreSession(root);
		const job = manager?.getJob("Fresh");
		if (!job) throw new Error("Expected restored subagent job");
		await job.promise;
		return outcome.subagents;
	}

	it("goes on with each subagent cut off mid-turn as a job its parent receives, not with finished or killed ones", async () => {
		setSystemTime(new Date("2026-10-09T00:00:00Z"));
		tempDir = TempDir.createSync("@pi-restore-subagents-");
		const cwd = tempDir.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		recordSessionActivation(main);
		setSystemTime();
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		await writeSubagent(mainFile, cwd, "Cut", cutOff);
		await writeSubagent(mainFile, cwd, "Done", finished);
		const killed = await writeSubagent(mainFile, cwd, "Killed", cutOff);
		await fs.writeFile(getAgentTombstonePath(killed), "");
		recordSessionActivation(main);
		await main.ensureOnDisk();
		await main.close();
		const active = await SessionManager.open(mainFile);

		manager = new AsyncJobManager({});
		const delivered: string[] = [];
		manager.registerDeliverySink(MAIN_AGENT_ID, jobId => {
			delivered.push(jobId);
		});
		const result: SingleResult = {
			index: 0,
			id: "Cut",
			agent: "Cut",
			agentSource: "user",
			task: "Cut task",
			exitCode: 0,
			output: "finished after the restart",
			stderr: "",
			truncated: false,
			durationMs: 5,
			tokens: 0,
			requests: 1,
		};
		const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue(result);
		const restoreTurn = vi.fn(async () => true);
		const session = {
			sessionManager: active,
			asyncJobManager: manager,
			settings: Settings.isolated(),
			restoreInterruptedTurn: restoreTurn,
		} as unknown as AgentSession;

		const outcome = await restoreSession(session);

		expect(outcome).toEqual({ turn: true, subagents: ["Cut"] });
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(followUp.mock.calls[0]![0]).toMatchObject({ id: "Cut", restore: true, message: "Cut task" });
		await manager.getJob("Cut")!.promise;
		await manager.drainDeliveries({ filter: { ownerId: MAIN_AGENT_ID } });
		expect(delivered).toEqual(["Cut"]);
		await active.close();
	});

	it("does not restart an abandoned subagent after the parent ran a replacement in a later process", async () => {
		setSystemTime(new Date("2026-10-10T00:00:00Z"));
		tempDir = TempDir.createSync("@pi-restore-stale-");
		const cwd = tempDir.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		recordSessionActivation(main);
		await writeSubagent(mainFile, cwd, "Cut", cutOff);
		setSystemTime(new Date("2026-10-11T00:00:00Z"));
		recordSessionActivation(main);
		await writeSubagent(mainFile, cwd, "Done", finished);
		setSystemTime(new Date("2026-10-11T00:01:00Z"));
		await writeSubagent(mainFile, cwd, "Fresh", cutOff);
		setSystemTime(new Date("2026-10-22T00:00:00Z"));
		recordSessionActivation(main);
		await main.ensureOnDisk();
		await main.close();
		const active = await SessionManager.open(mainFile);
		setSystemTime();

		manager = new AsyncJobManager({});
		const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue({
			index: 0,
			id: "Fresh",
			agent: "Fresh",
			agentSource: "user",
			task: "Fresh task",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 1,
		});
		const session = {
			sessionManager: active,
			asyncJobManager: manager,
			settings: Settings.isolated(),
			restoreInterruptedTurn: async () => false,
		} as unknown as AgentSession;

		const outcome = await restoreSession(session);
		expect(outcome.subagents).toEqual(["Fresh"]);
		expect(followUp).toHaveBeenCalledTimes(1);
		await active.close();
	});

	it("recovers a revived subagent when another process exits before its turn is written", async () => {
		tempDir = TempDir.createSync("@pi-restore-revival-crash-");
		const cwd = tempDir.path();
		setSystemTime(new Date("2026-10-09T00:00:00Z"));
		const original = SessionManager.create(cwd, path.join(cwd, "sessions"));
		original.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		recordSessionActivation(original);
		await original.ensureOnDisk();
		const mainFile = original.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		setSystemTime(new Date("2026-10-09T00:01:00Z"));
		await writeSubagent(mainFile, cwd, "Cut", cutOff);
		await original.close();

		setSystemTime(new Date("2026-10-22T00:00:00Z"));
		const first = await SessionManager.open(mainFile);
		recordSessionActivation(first);
		const pending = Promise.withResolvers<SingleResult>();
		const result: SingleResult = {
			index: 0,
			id: "Cut",
			agent: "Cut",
			agentSource: "user",
			task: "Cut task",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 1,
		};
		const followUp = vi
			.spyOn(executorModule, "runSubagentFollowUpTurn")
			.mockImplementationOnce(() => pending.promise)
			.mockResolvedValue(result);
		manager = new AsyncJobManager({});
		const firstRun = {
			sessionManager: first,
			asyncJobManager: manager,
			settings: Settings.isolated(),
			restoreInterruptedTurn: async () => false,
		} as unknown as AgentSession;
		try {
			expect((await restoreSession(firstRun)).subagents).toEqual(["Cut"]);
			expect(followUp).toHaveBeenCalledTimes(1);
			await manager.dispose({ timeoutMs: 0 });
			await first.close();

			setSystemTime(new Date("2026-10-23T00:00:00Z"));
			const second = await SessionManager.open(mainFile);
			try {
				recordSessionActivation(second);
				manager = new AsyncJobManager({});
				const secondRun = {
					sessionManager: second,
					asyncJobManager: manager,
					settings: Settings.isolated(),
					restoreInterruptedTurn: async () => false,
				} as unknown as AgentSession;
				expect((await restoreSession(secondRun)).subagents).toEqual(["Cut"]);
				const job = manager.getJob("Cut");
				if (!job) throw new Error("Expected restored subagent job");
				await job.promise;
				expect(followUp).toHaveBeenCalledTimes(2);
			} finally {
				await second.close();
			}
		} finally {
			pending.resolve(result);
			await first.close();
		}
	});

	it("restores a cut-off subagent from a session created with /new in this process", async () => {
		tempDir = TempDir.createSync("@pi-restore-new-session-");
		const cwd = tempDir.path();
		const current = SessionManager.create(cwd, path.join(cwd, "sessions"));
		recordSessionActivation(current);
		const active = await createRoot(current);
		expect(await active.newSession()).toBe(true);
		const newFile = current.getSessionFile();
		if (!newFile) throw new Error("Expected a persisted new session");

		setSystemTime(new Date(Date.now() + 60_000));
		await writeSubagent(newFile, cwd, "Fresh", cutOff);
		setSystemTime(new Date(Date.now() + 60_000));
		recordSessionActivation(current);

		expect(await recoverSubagents()).toEqual(["Fresh"]);
	});

	it("restores only work started after switching back to a previously abandoned session", async () => {
		tempDir = TempDir.createSync("@pi-restore-switch-session-");
		const cwd = tempDir.path();
		setSystemTime(new Date("2026-10-09T00:00:00Z"));
		const target = SessionManager.create(cwd, path.join(cwd, "sessions"));
		recordSessionActivation(target);
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected a persisted target session");
		setSystemTime(new Date("2026-10-10T00:00:00Z"));
		await writeSubagent(targetFile, cwd, "Cut", cutOff);
		await target.close();

		const current = SessionManager.create(cwd, path.join(cwd, "sessions"));
		recordSessionActivation(current);
		const active = await createRoot(current);
		setSystemTime(new Date("2026-10-11T00:00:00Z"));
		expect(await active.switchSession(targetFile)).toBe(true);
		setSystemTime(new Date("2026-10-11T00:01:00Z"));
		await writeSubagent(targetFile, cwd, "Fresh", cutOff);
		setSystemTime(new Date("2026-10-22T00:00:00Z"));
		recordSessionActivation(current);

		expect(await recoverSubagents()).toEqual(["Fresh"]);
	});

	it("does not guess which legacy subagents were running without a recorded process boundary", async () => {
		tempDir = TempDir.createSync("@pi-restore-legacy-");
		const cwd = tempDir.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		await writeSubagent(mainFile, cwd, "Cut", cutOff);
		recordSessionActivation(main);
		await main.close();

		manager = new AsyncJobManager({});
		const session = {
			sessionManager: { getSessionFile: () => mainFile, getEntries: () => main.getEntries() },
			asyncJobManager: manager,
			restoreInterruptedTurn: async () => true,
		} as unknown as AgentSession;

		expect(await restoreSession(session)).toEqual({ turn: true, subagents: [] });
	});
});
