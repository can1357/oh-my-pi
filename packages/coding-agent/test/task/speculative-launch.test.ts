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
import {
	type AgentToolCall,
	type AgentTool,
	type SpeculativeOperationSink,
	validateAgentToolArguments,
} from "@oh-my-pi/pi-agent-core";
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
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";

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

	it("aborts launched agents when the finished call is invalid", async () => {
		const { session } = await openSession();
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

	// A duplicate is invisible in `runSubprocess` call counts read at the moment `tool.execute`
	// returns: for an async batch it returns once the jobs are registered, before any *replacement*
	// run has reached the mocked executor. Both signals these tests use are settled by then — a
	// discarded child's replacement is announced in `progress` and registered as a job under
	// `<name>-2` — so they catch it without waiting on wall-clock time.
	function duplicateJobs(manager: AsyncJobManager, names: readonly string[]): string[] {
		return names.filter(name => manager.getJob(`${name}-2`) !== undefined);
	}

	// A placeholder (`model: ""`, `outputSchema: null`, and the other fields a model fills in with
	// nothing) must leave the launcher and dispatch deriving the same spawn, so the started child is
	// adopted. Dispatch receives the *validated* arguments, which differ from the raw streamed ones —
	// validation discards `outputSchema: null` — which is exactly when the two would disagree.
	it("adopts a speculatively launched item whose fields are only placeholders, running it once", async () => {
		const placeholders = {
			context: "ctx",
			tasks: [
				{ name: "Alpha", agent: "task", solutionSpace: "one way", task: "Do A.", model: "", outputSchema: null },
			],
		};
		const raw = JSON.stringify(placeholders);
		const { tool, manager, session } = await openSession();

		session.update(toolCall, raw.slice(0, raw.indexOf("}]") + 1));
		await spawn("Alpha").started.promise;

		session.finalize({ toolCall, args: placeholders });
		const validated = validateAgentToolArguments(tool as unknown as AgentTool, {
			type: "toolCall",
			id: toolCall.id,
			name: tool.name,
			arguments: placeholders,
		});
		const result = await tool.execute(toolCall.id, validated as TaskParams);

		expect(result.isError).toBeFalsy();
		// The adopted child, not a replacement: a discarded Alpha would be reported as `Alpha-2`.
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha"]);
		expect(duplicateJobs(manager, ["Alpha"])).toEqual([]);
		expect([...startedIds]).toEqual(["Alpha"]);
	});

	// Regression: the launcher's `spawns` returning `undefined` means "this call is invalid", and at
	// finalize the session discards every run it already started. A later item carrying a placeholder
	// must not make the whole call look invalid: an earlier, ordinary item has already started, and
	// discarding it makes dispatch run it a second time — work already performed, done twice.
	it("keeps an already-launched item when a later item in the same batch carries a placeholder", async () => {
		const mixed = {
			context: "ctx",
			tasks: [
				{ name: "Alpha", agent: "task", solutionSpace: "one way", task: "Do A." },
				{ name: "Beta", agent: "task", solutionSpace: "one way", task: "Do B.", model: "", outputSchema: null },
			],
		};
		const raw = JSON.stringify(mixed);
		const { tool, manager, session } = await openSession();

		session.update(toolCall, raw.slice(0, raw.indexOf('{"name":"Beta"') + 10));
		await spawn("Alpha").started.promise;
		expect(startedIds.has("Beta")).toBe(false);

		session.finalize({ toolCall, args: mixed });
		await spawn("Beta").started.promise;
		const validated = validateAgentToolArguments(tool as unknown as AgentTool, {
			type: "toolCall",
			id: toolCall.id,
			name: tool.name,
			arguments: mixed,
		});
		const result = await tool.execute(toolCall.id, validated as TaskParams);

		expect(result.isError).toBeFalsy();
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha", "Beta"]);
		expect(duplicateJobs(manager, ["Alpha", "Beta"])).toEqual([]);
		expect([...startedIds].sort()).toEqual(["Alpha", "Beta"]);
	});

	// Shared validation discards an optional field holding `null`, and the spawn carries
	// `outputSchema` by presence, so a streamed `outputSchema: null` made the launcher's plan one key
	// larger than dispatch's: the started child was cancelled and dispatch ran `Alpha-2`. The launcher
	// now plans from the validated arguments, so the two agree and the child is adopted.
	it("matches dispatch for an item whose outputSchema is null, running it once", async () => {
		const withNull = {
			context: "ctx",
			tasks: [
				{ name: "Alpha", agent: "task", solutionSpace: "one way", task: "Do A.", outputSchema: null },
				{ name: "Beta", agent: "task", solutionSpace: "one way", task: "Do B." },
			],
		};
		const raw = JSON.stringify(withNull);
		const { tool, manager, session } = await openSession();

		session.update(toolCall, raw.slice(0, raw.indexOf('{"name":"Beta"') + 10));
		await spawn("Alpha").started.promise;

		session.finalize({ toolCall, args: withNull });
		await spawn("Beta").started.promise;
		const validated = validateAgentToolArguments(tool as unknown as AgentTool, {
			type: "toolCall",
			id: toolCall.id,
			name: tool.name,
			arguments: withNull,
		});
		const result = await tool.execute(toolCall.id, validated as TaskParams);

		expect(result.isError).toBeFalsy();
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha", "Beta"]);
		expect(duplicateJobs(manager, ["Alpha", "Beta"])).toEqual([]);
		expect([...startedIds].sort()).toEqual(["Alpha", "Beta"]);
	});

	// The same split, reached through another rewrite validation performs. `isolated: "true"` is left
	// out on purpose: a coerced value makes the two plans differ on `main` too, independently of
	// placeholders, and that is the launcher's ordinary reconciliation rather than anything this
	// change introduced or claims to close.
	it.each([
		["an undeclared key", { bogusKey: "x" }],
		["a null tools list", { tools: null }],
	] as const)("matches dispatch for an item validation rewrites through %s", async (_label, fill) => {
		const call = {
			context: "ctx",
			tasks: [
				{ name: "Alpha", agent: "task", solutionSpace: "one way", task: "Do A.", ...fill },
				{ name: "Beta", agent: "task", solutionSpace: "one way", task: "Do B." },
			],
		};
		const raw = JSON.stringify(call);
		const { tool, manager, session } = await openSession();

		session.update(toolCall, raw.slice(0, raw.indexOf('{"name":"Beta"') + 10));
		await spawn("Alpha").started.promise;

		session.finalize({ toolCall, args: call });
		await spawn("Beta").started.promise;
		const validated = validateAgentToolArguments(tool as unknown as AgentTool, {
			type: "toolCall",
			id: toolCall.id,
			name: tool.name,
			arguments: call,
		});
		const result = await tool.execute(toolCall.id, validated as TaskParams);

		expect(result.isError).toBeFalsy();
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha", "Beta"]);
		expect(duplicateJobs(manager, ["Alpha", "Beta"])).toEqual([]);
		expect([...startedIds].sort()).toEqual(["Alpha", "Beta"]);
	});

	// `TaskLaunchSession.update` does not plan from the call, it rebuilds one as `{ context, tasks }`,
	// so every top-level key is invisible to it: a value read from the top level on a batch call is
	// one the launcher's plan could never have, and the started child was discarded and re-run as
	// `Alpha-2`. The flag is refused on a batch call now, so both sides refuse and nothing launches.
	it.each([[false], [true]] as const)(
		"refuses a batch call carrying a top-level isolated %s, launching nothing",
		async isolated => {
			const call = {
				context: "ctx",
				isolated,
				tasks: [
					{ name: "Alpha", agent: "task", solutionSpace: "one way", task: "Do A." },
					{ name: "Beta", agent: "task", solutionSpace: "one way", task: "Do B." },
				],
			};
			const raw = JSON.stringify(call);
			const { tool, session } = await openSession();

			session.update(toolCall, raw.slice(0, raw.indexOf('{"name":"Beta"') + 10));
			session.finalize({ toolCall, args: call });
			const result = await tool.execute(toolCall.id, call as TaskParams);

			expect(result.isError).toBe(true);
			expect(result.content.find(part => part.type === "text")?.text).toContain(
				"Top-level `isolated` is not part of the batch shape",
			);
			expect([...startedIds]).toEqual([]);
		},
	);

	// KNOWN RESIDUAL, pinned so a fix flips this test rather than going unnoticed.
	//
	// Validation is whole-call and all-or-nothing, and its lenient path falls back to the raw
	// arguments when the call fails the schema. The launcher plans once per streamed item, each time
	// for a longer prefix, so a later item that fails the schema while still being accepted at
	// runtime — Beta here, with no `solutionSpace` — sends a prefix that validated down the fallback
	// path. Alpha's plan then changes after Alpha has already started, and the launcher's ordinary
	// "the call changed" reconciliation discards it and dispatch runs `Alpha-2`.
	//
	// It needs per-item normalization that does not depend on the call's other items. Until then this
	// records what actually happens; both items still run, and `Alpha` runs twice.
	it("re-runs an earlier item when a later one sends validation down its lenient path", async () => {
		const lenient = {
			context: "ctx",
			tasks: [
				{ name: "Alpha", agent: "task", solutionSpace: "one way", task: "Do A.", outputSchema: null },
				{ name: "Beta", agent: "task", task: "Do B." },
			],
		};
		const raw = JSON.stringify(lenient);
		const { tool, manager, session } = await openSession();

		session.update(toolCall, raw.slice(0, raw.indexOf('{"name":"Beta"') + 10));
		await spawn("Alpha").started.promise;

		session.finalize({ toolCall, args: lenient });
		const validated = validateAgentToolArguments(tool as unknown as AgentTool, {
			type: "toolCall",
			id: toolCall.id,
			name: tool.name,
			arguments: lenient,
		});
		const result = await tool.execute(toolCall.id, validated as TaskParams);

		expect(result.isError).toBeFalsy();
		// The residual: Alpha is announced as its replacement, and a duplicate job exists for it.
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha-2", "Beta"]);
		expect(duplicateJobs(manager, ["Alpha", "Beta"])).toEqual(["Alpha"]);
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
