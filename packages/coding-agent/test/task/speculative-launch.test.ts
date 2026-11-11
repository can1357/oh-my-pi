/**
 * Contracts: speculative subagent launch for streamed batch `task` calls.
 *
 * 1. The scanner surfaces a `tasks[]` item only once its object closes —
 *    braces/quotes inside strings never close it early.
 * 2. An item's subagent starts while later items still stream; dispatch
 *    adopts the running agents instead of spawning duplicates.
 * 3. A finished call that is invalid, or whose items differ from what was
 *    launched, aborts every speculative agent.
 * 4. The host only authorizes launches under auto-allow approval with no
 *    extension lifecycle handlers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolCall, SpeculativeOperationSink } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createSpeculativeToolExecutionConfig } from "@oh-my-pi/pi-coding-agent/speculation/host";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { BatchArgsScanner, type TaskLaunchSession } from "@oh-my-pi/pi-coding-agent/task/speculative-launch";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const sink: SpeculativeOperationSink = {
	maxInFlight: 2,
	admit: async () => undefined,
	authorizeLaunch: async () => ({ allowed: true }),
	close: () => {},
};

function createSession(manager: AsyncJobManager): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": true, "task.batch": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => null,
		asyncJobManager: manager,
	} as unknown as ToolSession;
}

function makeResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: `${id} output.`,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

/** Observable lifecycle of one mocked subagent run, keyed by agent id. */
interface SpawnEvents {
	started: PromiseWithResolvers<void>;
	aborted: PromiseWithResolvers<void>;
	release: PromiseWithResolvers<void>;
}

const args = {
	context: "ctx",
	tasks: [
		{ name: "Alpha", agent: "task", task: "Do A." },
		{ name: "Beta", agent: "task", task: "Do B." },
	],
};
const json = JSON.stringify(args);
/** Streamed through Alpha's closing brace, mid-way into Beta. */
const alphaClosed = json.slice(0, json.indexOf('{"name":"Beta"') + 10);
const toolCall: AgentToolCall = { type: "toolCall", id: "tc-spec", name: "task", arguments: {} };

describe("BatchArgsScanner", () => {
	it("surfaces items only once their object closes, ignoring braces inside strings", () => {
		const raw =
			'{"context":"shared }\\" ctx","tasks":[{"name":"A","task":"use {x} and \\"}\\""},{"name":"B","task":"b"}]}';
		const scanner = new BatchArgsScanner();
		const seen: number[] = [];
		for (let end = 1; end <= raw.length; end++) {
			scanner.feed(raw.slice(0, end));
			seen.push(scanner.items.length);
		}

		expect(scanner.context).toBe('shared }" ctx');
		expect(scanner.items).toEqual([
			{ name: "A", task: 'use {x} and "}"' },
			{ name: "B", task: "b" },
		]);
		// Each item appears exactly at the byte that closes it.
		expect(seen.indexOf(1)).toBe(raw.indexOf('"},{"name":"B"') + 1);
		expect(seen.indexOf(2)).toBe(raw.length - 3);
	});

	it("scans appended deltas exactly like the growing buffer they add up to", () => {
		const raw =
			'{"context":"shared }\\" ctx","tasks":[{"name":"A","task":"use {x} and \\"}\\""},{"name":"B","task":"b"}]}';
		for (const size of [1, 3, 7]) {
			const fed = new BatchArgsScanner();
			const appended = new BatchArgsScanner();
			for (let start = 0; start < raw.length; start += size) {
				fed.feed(raw.slice(0, start + size));
				appended.append(raw.slice(start, start + size));
				expect([appended.context, appended.items, appended.itemsOpened]).toEqual([
					fed.context,
					fed.items,
					fed.itemsOpened,
				]);
			}
		}
	});
});

describe("task speculative launch", () => {
	const managers: AsyncJobManager[] = [];
	const spawns = new Map<string, SpawnEvents>();
	const startedIds = new Set<string>();
	const spawn = (id: string): SpawnEvents => {
		let events = spawns.get(id);
		if (!events) {
			events = {
				started: Promise.withResolvers<void>(),
				aborted: Promise.withResolvers<void>(),
				release: Promise.withResolvers<void>(),
			};
			spawns.set(id, events);
		}
		return events;
	};

	async function openSession(): Promise<{ tool: TaskTool; manager: AsyncJobManager; session: TaskLaunchSession }> {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await TaskTool.create(createSession(manager));
		const session = await tool.speculation.stream?.open({ coordinator: sink, parentToolCallId: toolCall.id });
		if (!session) throw new Error("expected a task launch session");
		return { tool, manager, session: session as TaskLaunchSession };
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			const events = spawn(id);
			startedIds.add(id);
			options.signal?.addEventListener(
				"abort",
				() => {
					events.aborted.resolve();
					events.release.resolve();
				},
				{ once: true },
			);
			events.started.resolve();
			await events.release.promise;
			return makeResult(id);
		});
	});

	afterEach(async () => {
		for (const events of spawns.values()) events.release.resolve();
		spawns.clear();
		startedIds.clear();
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("retains dispatch evidence when the task tool is recreated for the same session", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const toolSession = createSession(manager);
		const original = await TaskTool.create(toolSession);
		const replacement = await TaskTool.create(toolSession);
		const invalid = { context: "ctx", tasks: [{ name: "Missing", agent: "missing", task: "Work." }] };
		const running = original.execute("recreated", args);
		const concurrent = await replacement.execute("recreated", invalid);
		expect(concurrent.isError).toBe(true);
		expect(concurrent.details?.dispatchOutcome).toBeUndefined();
		await running;
		await Promise.all([spawn("Alpha").started.promise, spawn("Beta").started.promise]);
		const afterDispatch = await replacement.execute("recreated", invalid);
		expect(afterDispatch.isError).toBe(true);
		expect(afterDispatch.details?.dispatchOutcome).toBeUndefined();
		for (const events of spawns.values()) events.release.resolve();
		await Promise.all(manager.getAllJobs().map(job => job.promise));
		const afterCompletion = await replacement.execute("recreated", invalid);
		expect(afterCompletion.details?.dispatchOutcome).toBeUndefined();
		const independent = await replacement.execute("independent", invalid);
		expect(independent.details?.dispatchOutcome).toBe("rejected-before-dispatch");
	});

	it("retains pending speculative session evidence across tool recreation", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const toolSession = createSession(manager);
		const original = await TaskTool.create(toolSession);
		const session = await original.speculation.stream?.open({ coordinator: sink, parentToolCallId: toolCall.id });
		if (!session) throw new Error("expected a task launch session");
		const replacement = await TaskTool.create(toolSession);
		const invalid = { context: "ctx", tasks: [{ name: "Missing", agent: "missing", task: "Work." }] };
		const result = await replacement.execute(toolCall.id, invalid);
		expect(result.details?.dispatchOutcome).toBeUndefined();
		(session as TaskLaunchSession).discard("test complete");
		const later = await replacement.execute(toolCall.id, invalid);
		expect(later.details?.dispatchOutcome).toBe("rejected-before-dispatch");
	});

	it("starts each item as it closes and dispatch adopts the running agents", async () => {
		const { tool, manager, session } = await openSession();

		session.update(toolCall, alphaClosed);
		await spawn("Alpha").started.promise;
		expect(startedIds.has("Beta")).toBe(false);

		session.finalize({ toolCall, args });
		await spawn("Beta").started.promise;

		const result = await tool.execute(toolCall.id, args);

		expect(executorModule.runSubprocess).toHaveBeenCalledTimes(2);
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha", "Beta"]);
		spawn("Alpha").release.resolve();
		spawn("Beta").release.resolve();
		await manager.getJob("Alpha")!.promise;
		await manager.getJob("Beta")!.promise;
		expect(manager.getJob("Alpha")!.status).toBe("completed");
		expect(manager.getJob("Beta")!.status).toBe("completed");
	});

	it("adopts an empty model placeholder without changing the submitted arguments", async () => {
		const { tool, manager, session } = await openSession();
		const submitted = {
			context: "ctx",
			tasks: [{ name: "Alpha", agent: "task", task: "Do A.", model: [] as string[] }],
		};
		const original = structuredClone(submitted);
		session.update(toolCall, JSON.stringify(submitted));
		await spawn("Alpha").started.promise;
		session.finalize({ toolCall, args: submitted });
		const result = await tool.execute(toolCall.id, submitted);
		expect(executorModule.runSubprocess).toHaveBeenCalledTimes(1);
		expect(submitted).toEqual(original);
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha"]);
		spawn("Alpha").release.resolve();
		await manager.getJob("Alpha")!.promise;
		expect(manager.getJob("Alpha")!.status).toBe("completed");
	});

	it("aborts launched agents when the finished call is invalid", async () => {
		const { tool, session } = await openSession();
		session.update(toolCall, alphaClosed);
		await spawn("Alpha").started.promise;

		session.finalize({
			toolCall,
			args: {
				context: "ctx",
				tasks: [
					{ name: "Alpha", task: "Do A." },
					{ name: "alpha", task: "dup" },
				],
			},
		});

		await spawn("Alpha").aborted.promise;
		expect([...startedIds]).toEqual(["Alpha"]);
		const result = await tool.execute(toolCall.id, {
			context: "ctx",
			tasks: [
				{ name: "Alpha", task: "Do A." },
				{ name: "alpha", task: "dup" },
			],
		});
		expect(result.isError).toBe(true);
		expect(result.details?.dispatchOutcome).toBeUndefined();
		const later = await tool.execute("independent-call", {
			context: "ctx",
			tasks: [{ name: "Missing", agent: "missing", task: "Work." }],
		});
		expect(later.details?.dispatchOutcome).toBe("rejected-before-dispatch");
		const reused = await Promise.all([
			tool.execute(toolCall.id, { context: "ctx", tasks: [{ name: "Missing", agent: "missing", task: "Work." }] }),
			tool.execute(toolCall.id, { context: "ctx", tasks: [{ name: "Missing", agent: "missing", task: "Work." }] }),
		]);
		expect(reused.map(result => result.details?.dispatchOutcome)).toEqual([undefined, undefined]);
	});

	it("reports rejection when a streamed session never starts a run", async () => {
		const { tool, session } = await openSession();
		const invalid = { context: "ctx", tasks: [{ name: "Missing", agent: "missing", task: "Work." }] };
		session.update(toolCall, JSON.stringify(invalid));
		const result = await tool.execute(toolCall.id, invalid);
		expect(result.details?.dispatchOutcome).toBe("rejected-before-dispatch");
		expect(executorModule.runSubprocess).not.toHaveBeenCalled();
	});

	it("keeps a duplicate live session conservative until it closes", async () => {
		const { tool, session } = await openSession();
		const second = await tool.speculation.stream?.open({ coordinator: sink, parentToolCallId: toolCall.id });
		if (!second) throw new Error("expected a second task launch session");
		const invalid = { context: "ctx", tasks: [{ name: "Missing", agent: "missing", task: "Work." }] };
		const result = await tool.execute(toolCall.id, invalid);
		expect(result.details?.dispatchOutcome).toBeUndefined();
		session.discard("test complete");
		const later = await tool.execute(toolCall.id, invalid);
		expect(later.details?.dispatchOutcome).toBe("rejected-before-dispatch");
	});

	it("cancels a pending authorization before reporting rejection", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await TaskTool.create(createSession(manager));
		const entered = Promise.withResolvers<void>();
		const authorization = Promise.withResolvers<{ allowed: true }>();
		const session = await tool.speculation.stream?.open({
			coordinator: {
				...sink,
				authorizeLaunch: () => {
					entered.resolve();
					return authorization.promise;
				},
			},
			parentToolCallId: toolCall.id,
		});
		if (!session) throw new Error("expected a task launch session");
		session.update(toolCall, alphaClosed);
		await entered.promise;
		const result = await tool.execute(toolCall.id, {
			context: "ctx",
			tasks: [{ name: "Missing", agent: "missing", task: "Work." }],
		});
		expect(result.details?.dispatchOutcome).toBe("rejected-before-dispatch");
		authorization.resolve({ allowed: true });
		await authorization.promise;
		expect(executorModule.runSubprocess).not.toHaveBeenCalled();
	});

	it("aborts launched agents when finished items differ from what launched", async () => {
		const { session } = await openSession();
		session.update(toolCall, alphaClosed);
		await spawn("Alpha").started.promise;

		const changed = {
			context: "ctx",
			tasks: [
				{ name: "Alpha", agent: "task", task: "Do something else." },
				{ name: "Beta", agent: "task", task: "Do B." },
			],
		};
		expect(session.matchesFinalArgs(changed)).toBe(false);
		session.finalize({ toolCall, args: changed });

		await spawn("Alpha").aborted.promise;
		expect([...startedIds]).toEqual(["Alpha"]);
	});
});

describe("speculative launch authorization", () => {
	it("allows launches only under auto-allow approval without lifecycle handlers", async () => {
		const launch = { tool: { name: "task", approval: "exec" as const }, toolCall, args: { context: "ctx" } };
		const authorize = (approvalMode: string, handlers: boolean) => {
			const settings = Settings.isolated({ "tools.approvalMode": approvalMode });
			const session = {
				cwd: "/tmp",
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings,
			};
			return createSpeculativeToolExecutionConfig(settings, session, {
				hasHandlers: event => handlers && event === "tool_call",
			}).host?.authorizeLaunch?.(launch);
		};

		expect(await authorize("yolo", false)).toMatchObject({ allowed: true });
		expect(await authorize("yolo", true)).toMatchObject({ allowed: false });
		expect(await authorize("always-ask", false)).toMatchObject({ allowed: false });
	});
});
