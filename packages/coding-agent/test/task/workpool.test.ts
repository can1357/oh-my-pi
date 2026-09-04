import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import subagentSystemPrompt from "../../src/prompts/system/subagent-system-prompt.md" with { type: "text" };
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { HubTool } from "../../src/tools/hub";
import type { CustomMessage } from "../../src/session/messages";
import * as executor from "../../src/task/executor";
import type { EffectiveSubagentPolicy, StructuredSubagentResult } from "../../src/task/structured-subagent";
import * as structured from "../../src/task/structured-subagent";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import { WorkPool, WorkPoolRegistry } from "../../src/task/workpool";
import type { ToolSession } from "../../src/tools";
import { prompt } from "@oh-my-pi/pi-utils";

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
	const session = {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"task.maxConcurrency": concurrency,
			"task.maxRuntimeMs": 0,
			"eval.workpool.freshAgents": freshAgents,
		}),
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
	return new WorkPool(session, { name, policy: POLICY });
}

async function finishPool(session: ToolSession, workpool: WorkPool): Promise<void> {
	const job = session.asyncJobManager?.getJob(workpool.name);
	if (!job) throw new Error(`Missing pool job ${workpool.name}`);
	await job.promise;
}

afterEach(async () => {
	for (const manager of managers) await manager.dispose();
	managers.clear();
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	WorkPoolRegistry.resetForTests();
});

describe("WorkPool dispatch", () => {
	it("renders the flat workpool yield contract after shared context", () => {
		const rendered = prompt.render(subagentSystemPrompt, {
			agent: "Worker",
			context: "Shared context for every item.",
			workPoolYieldItems: [{ id: "pool#1", index: 1 }],
			outputSchema: { type: "object", properties: { "pool#1": {} } },
		});
		expect(rendered).toContain("{ key: <1-based number>, data: <outcome> }");
		expect(rendered).not.toContain("Your terminal `yield` MUST use exactly this shape");
	});
	it("spawns while there is room, then queues round-robin, and dispatches to an idle agent", async () => {
		const cards: CustomMessage[] = [];
		const session = makeSession(cards);
		const gates = new Map<string, PromiseWithResolvers<void>>();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			const id = request.identity?.id ?? "missing";
			const gate = Promise.withResolvers<void>();
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
		const first = Promise.withResolvers<void>();
		const follow = Promise.withResolvers<void>();
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
		expect(followSpy.mock.calls[0]?.[0].message).toContain("After EACH item");
		expect(followSpy.mock.calls[0]?.[0].message).not.toContain("todo");
		follow.resolve();
		await finishPool(session, workpool);
	});

	it("requeues a dead agent's queued items onto another worker", async () => {
		const session = makeSession([], 2);
		const gates = new Map<string, PromiseWithResolvers<void>>();
		let firstId = "";
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			const id = request.identity?.id ?? "missing";
			firstId ||= id;
			const gate = Promise.withResolvers<void>();
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
		const polled = await new HubTool(session).execute("poll-workpool", { op: "wait", ids: [workpool.name] });
		const details = polled.details;
		if (!details || !("jobs" in details)) throw new Error("Expected a background-job poll result");
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
			const gate = Promise.withResolvers<void>();
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
			const gate = Promise.withResolvers<void>();
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
		const first = Promise.withResolvers<void>();
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
