/**
 * Contract: the due-by clock runs on the main thread, and a notice reaches its
 * recipient wherever the recipient is homed. A dispatch made on a worker arms
 * main's clock over the thread RPC; a worker-homed owner or dispatcher answers
 * for its own transcript and queues the notice on its own thread, so the
 * notice is checked and committed in the loop that sends the request; and a
 * loss surfaces on main's person channel. Each case runs real `AgentSession`s
 * on a real subagent worker and on main, with mock models that record every
 * request they are sent.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry, type PersonNotice } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import type { DueByProbe, DueByProbeGlobals } from "../fixtures/due-by-worker";

const OWNER_NOTICE = "is taking longer than you said";
const ESCALATION = "is taking more than twice as long as";
const LOST_NOTICE = "and no agent was told";
const DUE_MS = 300;

const cleanups: Array<() => unknown> = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

async function startWorker(): Promise<DueByProbe> {
	const probe = Promise.withResolvers<DueByProbe>();
	const probeService: ThreadService = {
		name: "due-by-probe",
		globals: (): DueByProbeGlobals => ({ ready: received => probe.resolve(received) }),
	};
	const worker = new SubagentWorker({
		entry: new URL("../fixtures/due-by-worker.ts", import.meta.url),
		services: [identityThreadService, agentsThreadService, probeService],
		initTimeoutMs: 60_000,
	});
	cleanups.push(() => worker.terminate("test end"));
	await worker.ready;
	return probe.promise;
}

/** Poll a condition fed by another thread; there is no in-process clock to fake across a real worker. */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(20);
	}
}

/** A main-thread session registered as `id`, with a mock model that records every request. */
async function mainSession(
	id: string,
	kind: "main" | "sub",
	parentId?: string,
): Promise<{ session: AgentSession; requests: string[] }> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("bundled model missing");
	const requests: string[] = [];
	const mock = createMockModel({
		handler: context => {
			requests.push(JSON.stringify(context.messages));
			return { content: ["Done"] };
		},
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
		agentId: id,
	});
	cleanups.push(async () => {
		await session.dispose();
		authStorage.close();
	});
	const registry = AgentRegistry.global();
	registry.register({ id, displayName: id, kind, parentId, session, sessionFile: null, status: "idle" });
	registry.syncSessionStatus(id, session);
	return { session, requests };
}

/** A running child the clock watches, registered under `parentId`. */
function child(id: string, parentId: string): void {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		parentId,
		session: null,
		sessionFile: null,
		status: "running",
	});
}

/** Person notices main's window would show. */
function personNotices(): PersonNotice[] {
	const seen: PersonNotice[] = [];
	cleanups.push(AgentRegistry.global().onPersonNotice(notice => void seen.push(notice)));
	return seen;
}

const carries = (requests: readonly string[], text: string, childId: string) =>
	requests.filter(request => request.includes(text) && request.includes(`\`${childId}\``)).length;

describe("due-by notices across subagent worker threads", () => {
	it("tells a worker-homed dispatcher, read and committed in its own loop", async () => {
		const probe = await startWorker();
		await mainSession("Main", "main");
		await probe.open("Owner", "Main");
		await probe.prompt("Owner", "the conversation the work is dispatched from");
		expect(AgentRegistry.global().get("Owner")?.session).toBeInstanceOf(RemoteAgentSession);
		child("Child", "Owner");
		const warnings = personNotices();
		const settled = Promise.withResolvers<void>();
		AgentRegistry.global().dueBy.arm(
			{
				childId: "Child",
				ownerId: "Owner",
				ownerAddress: await probe.address("Owner"),
				agent: "task",
				dispatchedAt: Date.now(),
				dueMs: DUE_MS,
				stated: true,
			},
			{ settled: settled.promise, signal: new AbortController().signal },
		);
		await waitFor(async () => carries(await probe.requests("Owner"), OWNER_NOTICE, "Child") > 0);
		settled.resolve();
		expect(carries(await probe.requests("Owner"), OWNER_NOTICE, "Child")).toBe(1);
		expect(warnings.filter(notice => notice.message.includes(LOST_NOTICE))).toHaveLength(0);
	}, 30_000);

	it("arms main's clock for a dispatch made on a worker", async () => {
		const probe = await startWorker();
		await mainSession("Main", "main");
		await probe.open("Owner", "Main");
		await probe.prompt("Owner", "the conversation the work is dispatched from");
		child("Child", "Owner");
		await probe.arm("Child", "Owner", DUE_MS);
		await waitFor(() => AgentRegistry.global().dueBy.dueAt("Child") !== undefined, 5_000);
		await waitFor(async () => carries(await probe.requests("Owner"), OWNER_NOTICE, "Child") > 0);
		await probe.settle("Child");
		expect(carries(await probe.requests("Owner"), OWNER_NOTICE, "Child")).toBe(1);
		// The run's settle crosses the link too: the clock disarms.
		await waitFor(() => AgentRegistry.global().dueBy.dueAt("Child") === undefined, 5_000);
	}, 30_000);

	it("escalates from a worker-homed owner to the main-thread agent above it", async () => {
		const probe = await startWorker();
		const main = await mainSession("Main", "main");
		await main.session.prompt("the conversation the owner was dispatched from");
		await probe.open("Owner", "Main");
		await probe.prompt("Owner", "the conversation the work is dispatched from");
		child("Child", "Owner");
		await probe.arm("Child", "Owner", DUE_MS);
		await waitFor(() => carries(main.requests, ESCALATION, "Child") > 0);
		await probe.settle("Child");
		expect(carries(await probe.requests("Owner"), OWNER_NOTICE, "Child")).toBe(1);
		expect(carries(main.requests, ESCALATION, "Child")).toBe(1);
	}, 30_000);

	it("escalates from a main-thread owner to the worker-homed agent that dispatched it", async () => {
		const probe = await startWorker();
		await mainSession("Main", "main");
		await probe.open("Boss", "Main");
		await probe.prompt("Boss", "the conversation the lead was dispatched from");
		const lead = await mainSession("Lead", "sub", "Boss");
		await lead.session.prompt("the conversation the work is dispatched from");
		child("Child", "Lead");
		const settled = Promise.withResolvers<void>();
		AgentRegistry.global().dueBy.arm(
			{
				childId: "Child",
				ownerId: "Lead",
				ownerAddress: lead.session.dueByDispatchAddress("Lead-task", false),
				agent: "task",
				dispatchedAt: Date.now(),
				dueMs: DUE_MS,
				stated: true,
			},
			{ settled: settled.promise, signal: new AbortController().signal },
		);
		await waitFor(async () => carries(await probe.requests("Boss"), ESCALATION, "Child") > 0);
		settled.resolve();
		expect(carries(lead.requests, OWNER_NOTICE, "Child")).toBe(1);
		expect(carries(await probe.requests("Boss"), ESCALATION, "Child")).toBe(1);
	}, 30_000);

	it("surfaces the loss on main's person channel when a worker-homed owner no longer holds the dispatch", async () => {
		const probe = await startWorker();
		await mainSession("Main", "main");
		await probe.open("Owner", "Main");
		await probe.prompt("Owner", "a conversation");
		child("Child", "Owner");
		const warnings = personNotices();
		const settled = Promise.withResolvers<void>();
		AgentRegistry.global().dueBy.arm(
			{
				childId: "Child",
				ownerId: "Owner",
				// An entry this owner's transcript never held.
				ownerAddress: { entryId: "not-an-entry", toolCallId: undefined },
				agent: "task",
				dispatchedAt: Date.now(),
				dueMs: DUE_MS,
				stated: true,
			},
			{ settled: settled.promise, signal: new AbortController().signal },
		);
		await waitFor(() => warnings.some(notice => notice.message.includes("running past the due-by")));
		settled.resolve();
		expect(carries(await probe.requests("Owner"), OWNER_NOTICE, "Child")).toBe(0);
		expect(
			warnings.filter(notice => notice.message.includes(LOST_NOTICE) && notice.message.includes("`Child`")),
		).toHaveLength(1);
	}, 30_000);
});
