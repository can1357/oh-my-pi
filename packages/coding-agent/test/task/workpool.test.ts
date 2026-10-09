import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import { WaitTool } from "../../src/tools/wait";
import type { CustomMessage } from "../../src/session/messages";
import * as executor from "../../src/task/executor";
import * as discovery from "../../src/task/discovery";
import { assertRoleDispatch, resolveRoleRoute } from "../../src/task/role-routing";
import type { WorkPoolYieldItem } from "../../src/task/workpool-yield";
import type { EffectiveSubagentPolicy, StructuredSubagentResult } from "../../src/task/structured-subagent";
import * as structured from "../../src/task/structured-subagent";
import type { AgentDefinition } from "../../src/task/types";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { WorkPool, WorkPoolRegistry } from "../../src/task/workpool";
import type { ToolSession } from "../../src/tools";
import { createTaskModelFixture, type TaskModelFixture } from "../helpers/model-fixtures";
import { createSessionDefaults } from "../helpers/session-defaults";

const AGENT: AgentDefinition = {
	name: "scout",
	description: "Test scout",
	systemPrompt: "Do the work.",
	source: "bundled",
};

const POLICY = {
	discovery: { agents: [AGENT], projectAgentsDir: null },
	agentName: "scout",
	agent: AGENT,
	effectiveAgent: AGENT,
	schema: { schema: undefined, source: "none", mode: "permissive", outputSchemaOverridesAgent: false },
	planMode: false,
	isIsolated: false,
	mergeMode: "patch",
	applyChanges: true,
	enableLsp: false,
	enableIrc: true,
} satisfies EffectiveSubagentPolicy;

const managers = new Set<AsyncJobManager>();
const modelFixtures: TaskModelFixture[] = [];
const workpools = new Set<WorkPool>();
const pendingGates = new Set<PromiseWithResolvers<void>>();
let cleaningUp = false;

function createGate(): PromiseWithResolvers<void> {
	const gate = Promise.withResolvers<void>();
	const tracked: PromiseWithResolvers<void> = {
		...gate,
		resolve: () => {
			pendingGates.delete(tracked);
			gate.resolve();
		},
	};
	pendingGates.add(tracked);
	if (cleaningUp) tracked.resolve();
	return tracked;
}

function makeSession(
	cards: CustomMessage[] = [],
	concurrency = 2,
	freshAgents = false,
	deliveries?: Array<{ id: string; text: string }>,
): ToolSession {
	const manager = new AsyncJobManager({ retentionMs: 0 });
	if (deliveries) {
		manager.registerDeliverySink("Main", (id, text) => {
			deliveries.push({ id, text });
		});
	}
	managers.add(manager);
	const settings = Settings.isolated({
		"task.maxConcurrency": concurrency,
		"task.maxRuntimeMs": 0,
		"eval.workpool.freshAgents": freshAgents,
		"launch.enabled": false,
	});
	const fixture = createTaskModelFixture(settings);
	modelFixtures.push(fixture);
	const session = {
		cwd: "/tmp",
		hasUI: false,
		settings,
		modelRegistry: fixture.modelRegistry,
		getActiveModel: fixture.getActiveModel,
		getActiveModelString: fixture.getActiveModelString,
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
	} satisfies ToolSession;
	AgentRegistry.global().register({
		id: "Main",
		displayName: "Main",
		kind: "main",
		status: "idle",
		session: { emitIrcRelayObservation: (card: CustomMessage) => cards.push(card) } as unknown as AgentSession,
	});
	return session;
}

function singleResult(id: string, output = `done ${id}`): SingleResult {
	return {
		index: 0,
		id,
		agent: "scout",
		agentSource: "bundled",
		task: "pool batch",
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 1,
		requests: 1,
	};
}

function execution(id: string, output?: string): StructuredSubagentResult {
	return {
		result: singleResult(id, output),
		policy: POLICY,
		mergeSummary: "",
		changesApplied: null,
		artifactsDir: "/tmp",
		temporaryArtifacts: true,
	};
}

function markIdle(id: string): void {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		status: "idle",
		session: null,
	});
}

async function until(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error("condition did not become true");
}

function cardMode(card: CustomMessage): string | undefined {
	const details = card.details;
	if (!details || typeof details !== "object" || !("mode" in details)) return undefined;
	return typeof details.mode === "string" ? details.mode : undefined;
}

function pool(session: ToolSession, name = "review"): WorkPool {
	const workpool = new WorkPool(session, { name, policy: POLICY });
	workpools.add(workpool);
	return workpool;
}

async function finishPool(session: ToolSession, workpool: WorkPool): Promise<void> {
	const job = session.asyncJobManager?.getJob(workpool.name);
	if (!job) throw new Error(`Missing pool job ${workpool.name}`);
	await job.promise;
}

beforeEach(() => {
	cleaningUp = false;
});

afterEach(async () => {
	for (const workpool of workpools) workpool.close();
	workpools.clear();
	cleaningUp = true;
	for (const gate of pendingGates) gate.resolve();
	await Promise.all(Array.from(managers).flatMap(manager => manager.getAllJobs().map(job => job.promise)));
	for (const manager of managers) await manager.dispose();
	managers.clear();
	await AgentLifecycleManager.global().dispose();
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	WorkPoolRegistry.resetForTests();
	for (const fixture of modelFixtures.splice(0)) fixture.close();
});

describe("WorkPool dispatch", () => {
	it("spawns while there is room, then queues round-robin, and dispatches to an idle agent", async () => {
		const cards: CustomMessage[] = [];
		const session = makeSession(cards);
		const gates = new Map<string, PromiseWithResolvers<void>>();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			const id = request.identity?.id ?? "missing";
			const gate = createGate();
			gates.set(id, gate);
			await gate.promise;
			markIdle(id);
			return execution(id);
		});
		vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async options => {
			markIdle(options.id);
			return singleResult(options.id, "follow-up done");
		});
		const workpool = pool(session);

		expect(workpool.push(["one", "two", "three", "four"])).toEqual(["review#1", "review#2", "review#3", "review#4"]);
		await until(() => workpool.agents.length === 2 && workpool.agents.every(agent => agent.queue.length === 1));
		expect(workpool.agents.map(agent => agent.queue[0]?.id)).toEqual(["review#3", "review#4"]);
		expect(cards.map(cardMode)).toEqual(["spawned", "spawned", "queued", "queued"]);

		gates.get(workpool.agents[0]!.id)?.resolve();
		await until(() => workpool.agents[0]?.state === "idle" && workpool.agents[0]?.turns === 2);
		workpool.push(["five"]);
		await until(() => cards.some(card => cardMode(card) === "dispatched"));
		expect(cards.map(cardMode)).toContain("dispatched");
		expect(workpool.items[4]?.agentId).toBe(workpool.agents[0]?.id);
		gates.get(workpool.agents[1]!.id)?.resolve();
		await finishPool(session, workpool);
		expect(cards.map(cardMode)).toContain("completed");
	});

	it("hands a queued batch to a follow-up turn after the first turn settles", async () => {
		const session = makeSession([], 1);
		const first = createGate();
		const follow = createGate();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			await first.promise;
			const id = request.identity?.id ?? "missing";
			markIdle(id);
			return execution(id);
		});
		const followSpy = vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async options => {
			await follow.promise;
			markIdle(options.id);
			return singleResult(options.id, "second batch");
		});
		const workpool = pool(session, "handoff");
		workpool.push(["first", "second"]);
		await until(() => workpool.agents[0]?.queue.length === 1);
		first.resolve();
		await until(() => followSpy.mock.calls.length === 1);
		expect(workpool.batches.map(batch => batch.items.map(item => item.id))).toEqual([["handoff#1"], ["handoff#2"]]);
		expect(followSpy.mock.calls[0]?.[0].workPoolYieldItems).toEqual([{ id: "handoff#2", index: 1 }]);
		follow.resolve();
		await finishPool(session, workpool);
	});
	it("tombstones the worker session when clearing the yield contract fails", async () => {
		const session = makeSession([], 1);
		let workerId = "";
		let disposed = false;
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			workerId = request.identity?.id ?? "missing";
			// Retained worker whose prompt rebuild throws after the runtime
			// contract already flipped: pool-local drop alone would leave it
			// messageable with a stale keyed declaration.
			AgentRegistry.global().register({
				id: workerId,
				displayName: workerId,
				kind: "sub",
				status: "idle",
				session: {
					setWorkPoolYieldItems: async () => {
						throw new Error("prompt rebuild boom");
					},
					dispose: async () => {
						disposed = true;
					},
				} as unknown as AgentSession,
			});
			return execution(workerId);
		});
		const workpool = pool(session, "poison");
		workpool.push(["one"]);
		await finishPool(session, workpool);
		// The successful turn result survives the cleanup failure, but the
		// poisoned worker is gone locally and left terminal in the registry: a
		// later persisted-agent scan must not resurrect it as parked.
		expect(workpool.batches[0]?.status).toBe("completed");
		expect(workpool.agents.length).toBe(0);
		expect(disposed).toBe(true);
		expect(AgentRegistry.global().get(workerId)?.status).toBe("aborted");
		expect(AgentRegistry.global().get(workerId)?.session).toBeNull();
	});

	it("requeues a dead agent's queued items onto another worker", async () => {
		const session = makeSession([], 2);
		const gates = new Map<string, PromiseWithResolvers<void>>();
		let firstId = "";
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			const id = request.identity?.id ?? "missing";
			firstId ||= id;
			const gate = createGate();
			gates.set(id, gate);
			await gate.promise;
			if (id !== firstId) markIdle(id);
			return execution(id);
		});
		vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async options => {
			markIdle(options.id);
			return singleResult(options.id);
		});
		const workpool = pool(session, "requeue");
		workpool.push(["one", "two", "three"]);
		await until(() => workpool.agents.length === 2 && workpool.items[2]?.agentId === firstId);
		gates.get(firstId)?.resolve();
		await until(() => workpool.items[2]?.agentId !== firstId && workpool.items[2]?.status === "running");
		expect(workpool.agents.some(agent => agent.id === firstId)).toBe(false);
		for (const [id, gate] of gates) {
			if (id !== firstId) gate.resolve();
		}
		await finishPool(session, workpool);
	});

	it("uses the pool name as the aggregate job id and label", async () => {
		const session = makeSession([], 1);
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			const id = request.identity?.id ?? "missing";
			markIdle(id);
			return execution(id);
		});
		const manager = session.asyncJobManager!;
		const consume = vi.spyOn(manager, "consumeJobResults");
		const workpool = pool(session, "waiter");
		workpool.push(["one"]);
		const poolJob = manager.getJob("waiter");
		expect(poolJob?.id).toBe("waiter");
		expect(poolJob?.label).toBe("waiter");
		const polled = await new WaitTool(session).execute("wait-workpool", {});
		const details = polled.details;
		if (!details?.jobs) throw new Error("Expected a background-job wait result");
		expect(details.jobs?.map(job => job.id)).toEqual(["waiter"]);
		expect(details.jobs?.map(job => job.status)).toEqual(["completed"]);
		expect(workpool.peek().pending).toBe(0);
		expect(workpool.peek().batches).toHaveLength(1);
		expect(consume).toHaveBeenCalledWith([workpool.batches[0]!.jobId]);
	});

	it("auto-delivers one aggregate completion under the pool id", async () => {
		const deliveries: Array<{ id: string; text: string }> = [];
		const cards: CustomMessage[] = [];
		const session = makeSession(cards, 1, false, deliveries);
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			const id = request.identity?.id ?? "missing";
			markIdle(id);
			return execution(id);
		});
		const workpool = pool(session, "aggregate");
		workpool.push(["one"]);
		await finishPool(session, workpool);
		await session.asyncJobManager?.drainDeliveries({ filter: { ownerId: "Main" } });

		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.id).toBe("aggregate");
		expect(deliveries[0]?.text).toContain("Pool `aggregate`");
		expect(cards.map(cardMode)).toContain("completed");
	});

	it("sends new work to the least context-loaded idle agent", async () => {
		const session = makeSession([], 3);
		const gates = new Map<string, PromiseWithResolvers<void>>();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			const id = request.identity?.id ?? "missing";
			const gate = createGate();
			gates.set(id, gate);
			request.onProgress?.({
				index: 0,
				id,
				agent: "scout",
				agentSource: "bundled",
				status: "running",
				task: request.assignment,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 1,
				tokens: 1,
				contextTokens: id.endsWith("-1") ? 80 : id.endsWith("-2") ? 20 : 50,
				contextWindow: 100,
				cost: 0,
				durationMs: 1,
			});
			await gate.promise;
			markIdle(id);
			return execution(id);
		});
		vi.spyOn(executor, "runSubagentFollowUpTurn").mockImplementation(async options => {
			markIdle(options.id);
			return singleResult(options.id);
		});
		const workpool = pool(session, "loaded");
		workpool.push(["one", "two", "three"]);
		await until(() => workpool.agents.length === 3);
		gates.get("loaded-1")?.resolve();
		gates.get("loaded-2")?.resolve();
		await until(() => workpool.agents.filter(agent => agent.state === "idle").length === 2);
		workpool.push(["four"]);
		await until(() => workpool.items[3]?.status !== "queued");
		expect(workpool.items[3]?.agentId).toBe("loaded-2");
		gates.get("loaded-3")?.resolve();
		await finishPool(session, workpool);
	});

	it("spawns a fresh agent per item when eval.workpool.freshAgents is enabled", async () => {
		const session = makeSession([], 1, true);
		const gates: Array<PromiseWithResolvers<void>> = [];
		const runSpy = vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			const gate = createGate();
			gates.push(gate);
			await gate.promise;
			const id = request.identity?.id ?? "missing";
			markIdle(id);
			return execution(id);
		});
		const followSpy = vi.spyOn(executor, "runSubagentFollowUpTurn");
		const workpool = pool(session, "fresh");
		workpool.push(["one", "two"]);
		await until(() => gates.length === 1);
		gates[0]?.resolve();
		await until(() => gates.length === 2);
		gates[1]?.resolve();
		await finishPool(session, workpool);

		expect(runSpy).toHaveBeenCalledTimes(2);
		expect(followSpy).not.toHaveBeenCalled();
		expect(workpool.batches.map(batch => batch.agentId)).toEqual(["fresh-1", "fresh-2"]);
		expect(workpool.batches.every(batch => batch.items.length === 1)).toBe(true);
		expect(workpool.status().freshAgents).toBe(true);
	});

	it("close drops queued items but lets the in-flight turn finish", async () => {
		const session = makeSession([], 1);
		const first = createGate();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			await first.promise;
			const id = request.identity?.id ?? "missing";
			markIdle(id);
			return execution(id);
		});
		const workpool = pool(session, "closing");
		workpool.push(["running", "queued"]);
		await until(() => workpool.items[0]?.status === "running" && workpool.items[1]?.status === "queued");
		expect(workpool.close()).toEqual({ dropped: ["closing#2"] });
		expect(workpool.items[1]?.status).toBe("cancelled");
		first.resolve();
		await finishPool(session, workpool);
		expect(workpool.peek().pending).toBe(0);
	});
});

describe("WorkPool model selection", () => {
	it("admits a model only for worker creation and preserves that worker's model and effort on follow-up", async () => {
		using artifacts = TempDir.createSync("@omp-workpool-models-");
		const session = makeSession([], 1);
		const queued = Promise.withResolvers<void>();
		const workerCreated = Promise.withResolvers<void>();
		const owner = AgentRegistry.global().get("Main")!.session!;
		owner.emitIrcRelayObservation = card => {
			if (cardMode(card) === "queued") queued.resolve();
		};
		session.getSessionFile = () => artifacts.join("session.jsonl");
		session.getArtifactsDir = () => artifacts.join("session");
		session.settings.setModelRole("project-review", "routing-test/primary");
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
		const policy = await structured.resolveEffectiveSubagentPolicy({
			session,
			invocationKind: "eval",
			assignment: "Create workers",
			agent: "scout",
			model: "@project-review:high",
		});
		const first = createGate();
		const resumed: Array<{ id: string; model: string; thinkingLevel: AgentSession["thinkingLevel"] }> = [];
		const workers: AgentSession[] = [];
		const initial = vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			const selected = resolveRoleRoute(options.roleRoute!, session.modelRegistry);
			let items: readonly WorkPoolYieldItem[] = options.workPoolYieldItems ?? [];
			const listeners: Array<(event: AgentSessionEvent) => void> = [];
			let disposed = false;
			const retained = {
				...createSessionDefaults(),
				model: selected.model,
				thinkingLevel: selected.thinkingLevel,
				settings: session.settings,
				state: { messages: [] },
				agent: { state: { systemPrompt: ["Workpool worker"] } },
				isStreaming: false,
				dispose: async () => {
					disposed = true;
					listeners.splice(0);
				},
				setWorkPoolYieldItems: async (next: readonly WorkPoolYieldItem[]) => {
					items = next;
				},
				getActiveToolNames: () => ["yield"],
				getEnabledToolNames: () => ["yield"],
				subscribe: (listener: (event: AgentSessionEvent) => void) => {
					listeners.push(listener);
					return () => {
						const index = listeners.indexOf(listener);
						if (index >= 0) listeners.splice(index, 1);
					};
				},
				prompt: async () => {
					if (disposed) throw new Error("Cannot prompt a disposed workpool worker");
					assertRoleDispatch(options.roleRoute, worker.model, Effort.High, undefined, session.modelRegistry);
					resumed.push({
						id: options.id,
						model: `${worker.model!.provider}/${worker.model!.id}`,
						thinkingLevel: worker.thinkingLevel!,
					});
					const data = Object.fromEntries(items.map(item => [item.id, { model: selected.selector }]));
					for (const listener of listeners)
						listener({
							type: "tool_execution_end",
							toolCallId: "pool-followup-yield",
							toolName: "yield",
							result: {
								content: [{ type: "text", text: "Result submitted." }],
								details: { status: "success", data },
							},
							isError: false,
						});
					return true;
				},
			};
			const worker = retained as unknown as AgentSession;
			workers.push(worker);
			const ref = AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				status: "running",
				session: worker,
			});
			workerCreated.resolve();
			await first.promise;
			AgentRegistry.global().setStatus(options.id, "idle", ref);
			AgentLifecycleManager.global().adopt(options.id, { idleTtlMs: 0 }, ref);
			return singleResult(
				options.id,
				JSON.stringify(Object.fromEntries(items.map(item => [item.id, { model: selected.selector }]))),
			);
		});
		const workpool = new WorkPool(session, { name: "models", policy, model: "@project-review:high" });
		workpools.add(workpool);
		let drained: Promise<void> | undefined;
		try {
			workpool.push(["one", "two"]);
			drained = finishPool(session, workpool);
			await Promise.race([
				Promise.all([queued.promise, workerCreated.promise]),
				drained.then(() => {
					throw new Error("Pool drained before the queued follow-up and its retained worker were ready");
				}),
			]);
			expect(workpool.agents[0]?.queue.map(item => item.id)).toEqual(["models#2"]);
			const changedParent = session.modelRegistry!.find("routing-test", "fallback")!;
			session.getActiveModel = () => changedParent;
			session.getActiveModelString = () => "routing-test/fallback:low";
			first.resolve();
			await drained;
			expect(initial).toHaveBeenCalledTimes(1);
			expect(workpool.status().items.completed).toBe(2);
			expect(workpool.agents[0]?.turns).toBe(2);
			expect(resumed).toEqual([
				{ id: workpool.agents[0]!.id, model: "routing-test/primary", thinkingLevel: Effort.High },
			]);
			expect(workers[0]?.model?.id).toBe("primary");
			expect(workers[0]?.thinkingLevel).toBe(Effort.High);
		} finally {
			first.resolve();
			workpool.close();
			try {
				await drained;
			} finally {
				for (const worker of workers) {
					const ref = AgentRegistry.global()
						.list()
						.find(candidate => candidate.session === worker);
					if (ref) await AgentLifecycleManager.global().release(ref.id, ref);
					else await worker.dispose();
				}
			}
		}
	});

	it("admits independent model identities for separate pools", async () => {
		const session = makeSession();
		using artifacts = TempDir.createSync("@omp-workpool-independent-models-");
		session.settings.setModelRole("first-worker", "routing-test/primary");
		session.getSessionFile = () => artifacts.join("session.jsonl");
		session.getArtifactsDir = () => artifacts.join("session");
		session.settings.setModelRole("second-worker", "routing-test/fallback");
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
		const policy = await structured.resolveEffectiveSubagentPolicy({
			session,
			invocationKind: "eval",
			assignment: "Create pools",
			agent: "scout",
		});
		const selections = new Map<string, string>();
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			selections.set(options.id, resolveRoleRoute(options.roleRoute!, session.modelRegistry).selector);
			markIdle(options.id);
			return singleResult(options.id);
		});
		const first = new WorkPool(session, { name: "first", policy, model: "@first-worker:low" });
		const second = new WorkPool(session, { name: "second", policy, model: "@second-worker:high" });
		workpools.add(first);
		workpools.add(second);
		first.push(["one"]);
		second.push(["two"]);
		await Promise.all([finishPool(session, first), finishPool(session, second)]);
		expect(selections.get(first.agents[0]!.id)).toBe("routing-test/primary:low");
		expect(selections.get(second.agents[0]!.id)).toBe("routing-test/fallback:high");
	});
});
