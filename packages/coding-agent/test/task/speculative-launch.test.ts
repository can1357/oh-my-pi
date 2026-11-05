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
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
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

function createSession(manager: AsyncJobManager, extraSettings: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": true, "task.batch": true, ...extraSettings }),
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

	async function openSession(
		extraSettings: Record<string, unknown> = {},
	): Promise<{ tool: TaskTool; manager: AsyncJobManager; session: TaskLaunchSession }> {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await TaskTool.create(createSession(manager, extraSettings));
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

	// A placeholder is `model: ""` and the other fields a model fills in with nothing. Shared
	// validation leaves such a call byte-identical, so the launcher planning from the raw streamed
	// arguments and dispatch planning from the validated ones derive the same spawn and the started
	// child is adopted. (`outputSchema: null` is deliberately *not* in this fixture: validation does
	// discard it, which splits the two plans — that is the pre-existing route pinned further down,
	// not something a placeholder causes.)
	it("adopts a speculatively launched item whose fields are only placeholders, running it once", async () => {
		const placeholders = {
			context: "ctx",
			tasks: [
				{ name: "Alpha", agent: "task", solutionSpace: "one way", task: "Do A.", model: "", sourceSession: "" },
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
				{ name: "Beta", agent: "task", solutionSpace: "one way", task: "Do B.", model: "", sourceSession: "" },
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

	// PRE-EXISTING ROUTE, pinned so a fix flips this test rather than going unnoticed. Reproduces at
	// the inherited head `d6358699c872` with no placeholder in the call, and this change neither
	// opens nor closes it.
	//
	// Shared validation discards an optional field holding `null`, and the spawn carries
	// `outputSchema` by presence, so the launcher — which plans from the raw streamed arguments, as it
	// does on `main` — derives a plan one key larger than dispatch's. Reconciliation discards the
	// started child and dispatch runs the replacement as `Alpha-2`.
	//
	// Normalizing the launcher's arguments to what dispatch will see was tried and reverted: it closes
	// this case and opens a worse one, because validating a prefix that is schema-valid on its own
	// disagrees with a finished call whose lenient path fell back to raw, cancelling a child that had
	// already been adopted. That route would have been *this change's*, which is why it is not here.
	it("re-runs an item whose outputSchema is null, which this change does not address", async () => {
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
		// The route: Alpha is announced as its replacement, and a duplicate job exists for it.
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha-2", "Beta"]);
		expect(duplicateJobs(manager, ["Alpha", "Beta"])).toEqual(["Alpha"]);
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

	// The case that decided `asDispatched` had to go, kept as the guard against reintroducing it.
	//
	// Validation is whole-call and all-or-nothing, and its lenient path falls back to the raw
	// arguments when the call fails the schema. Beta here has no `solutionSpace` — required by the
	// wire schema, not by the runtime — so the finished call is dispatched from the raw arguments.
	// The launcher plans from the raw arguments too, so both sides see Alpha's `outputSchema: null`
	// and the started child is adopted. Normalizing the launcher's arguments breaks exactly this: a
	// prefix that is schema-valid on its own validates, loses the `null`, and no longer matches the
	// finished call, so an already-adopted Alpha is cancelled and re-run as `Alpha-2`.
	it("keeps an adopted item when a later one sends the finished call down the lenient path", async () => {
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
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha", "Beta"]);
		expect(duplicateJobs(manager, ["Alpha", "Beta"])).toEqual([]);
	});

	// Regression for the whole of `ARRAY_BLANKABLE_KEYS`, not one member of it. A key is
	// array-blankable only if (a) a populated array there yields an actionable refusal and (b) its
	// declared wire type admits an array, so the raw streamed arguments and the validated ones carry
	// the same value. `sourceSession` and `taskFile` both fail (b): validation rewrites their arrays
	// to JSON text, so the launcher drops the raw array and starts the child while dispatch keeps the
	// string and refuses the whole call — the run is started, does work, and is discarded.
	//
	// Both keys are covered because fixing one and leaving the other was the actual history here:
	// `sourceSession` was removed from the set in round 10, and a review round then measured that
	// putting `taskFile` in left the entire branch suite green. A set whose forbidden members no test
	// can distinguish is a set no test is guarding.
	//
	// Every row runs with both configurations enabled — seance advertised *and* `task.file` on — and
	// each key needs its own: `sourceSession` is declared only where seance is advertised, `taskFile`
	// only where `task.file` is on. Outside those, validation deletes the key rather than rewriting
	// it, the two planners then agree, and there is no defect to catch; both were measured to be
	// load-bearing for their own row.
	it.each([
		["sourceSession", "an empty array", [] as unknown],
		["sourceSession", "an array of blanks", ["", "  "]],
		["taskFile", "an empty array", []],
		["taskFile", "an array of blanks", ["", "  "]],
	] as const)("starts nothing for a streamed call whose %s is %s", async (key, _label, value) => {
		const seance = loadBundledAgents().find(agent => agent.name === "seance");
		if (!seance) throw new Error("Expected the bundled seance agent");
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent, seance],
			projectAgentsDir: null,
		});
		const call = {
			context: "ctx",
			tasks: [
				{ name: "Alpha", agent: "task", solutionSpace: "one way", task: "Do A.", [key]: value },
				{ name: "Beta", agent: "task", solutionSpace: "one way", task: "Do B." },
			],
		};
		const raw = JSON.stringify(call);
		// Wait on an event, not a duration. `#launch` asks `sink.authorizeLaunch` before its first
		// await, so the spy is the earliest observable proof that a launch was scheduled — and it
		// records the asking, so delaying the answer cannot hide it.
		//
		// `drained()` is what makes that honest. Two timing-based barriers were tried here and both
		// were green for the wrong reason: a 400 ms cap, which a 650 ms authorization delay defeats
		// while the launch still happens at 651–661 ms; and before it a 50-microtask drain, shorter
		// still. A cap cannot prove settling whatever its margin, because the margin is a proxy for
		// every await upstream of the start. The drain that replaced the cap was honest only while
		// `#launch` happened to reach authorization with no macrotask in front of it — a review arm
		// measured that inserting one `await Bun.sleep(0)` there turns both rows green. Awaiting the
		// session's own launch queue binds this to the thing it measures rather than to that accident.
		const authorize = vi.spyOn(sink, "authorizeLaunch");
		const { tool, session } = await openSession({ "task.file": true });

		session.update(toolCall, raw.slice(0, raw.indexOf('{"name":"Beta"') + 10));
		await session.drained();
		expect(authorize).not.toHaveBeenCalled();
		expect([...startedIds]).toEqual([]);

		session.finalize({ toolCall, args: call });
		const validated = validateAgentToolArguments(tool as unknown as AgentTool, {
			type: "toolCall",
			id: toolCall.id,
			name: tool.name,
			arguments: call,
		});
		const result = await tool.execute(toolCall.id, validated as TaskParams);

		// Dispatch refuses the call. `startedIds` is deliberately not re-asserted here, and the reason
		// is not that the run was discarded — nothing removes an id from that set. It is that
		// `startedIds` is written by the `runSubprocess` mock, which the launch chain does not await:
		// `launcher.start` resolves before the executor runs, so no `startedIds` line in this test can
		// red under the revert without a wait, and a wait is the thing this test exists to avoid.
		// `authorize` is the observable. The line above it is kept only as a cheap guard against a
		// launcher that reaches the executor synchronously.
		expect(result.isError).toBe(true);
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
