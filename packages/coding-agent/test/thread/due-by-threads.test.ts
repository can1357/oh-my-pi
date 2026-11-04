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
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry, type PersonNotice } from "../../src/registry/agent-registry";
import { AgentSession, type AgentSessionEvent } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { NOTICE_DEADLINE_MS, SUBAGENT_OVERDUE_MESSAGE_TYPE } from "../../src/task/due-by";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { asyncJobsThreadService } from "../../src/thread/services/async-jobs";
import { identityThreadService } from "../../src/thread/services/identity";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import type { DueByProbe, DueByProbeGlobals } from "../fixtures/due-by-worker";

const OWNER_NOTICE = "is taking longer than you said";
const ESCALATION = "is taking more than twice as long as";
const LOST_NOTICE = "and no agent was told";
const DUE_MS = 300;

const cleanups: Array<() => unknown> = [];
let tempDir: TempDir;
let jobManager: AsyncJobManager;

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	tempDir = TempDir.createSync("@pi-due-by-threads-");
	jobManager = new AsyncJobManager({});
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await jobManager.dispose({ timeoutMs: 1_000 });
	tempDir.removeSync();
	AsyncJobManager.resetForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

async function startWorker(): Promise<DueByProbe> {
	const probe = Promise.withResolvers<DueByProbe>();
	const probeService: ThreadService = {
		name: "due-by-probe",
		globals: (): DueByProbeGlobals => ({ ready: received => probe.resolve(received), jobManager }),
	};
	const worker = new SubagentWorker({
		entry: new URL("../fixtures/due-by-worker.ts", import.meta.url),
		services: [identityThreadService, agentsThreadService, asyncJobsThreadService, probeService],
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
	persist = false,
): Promise<{
	session: AgentSession;
	requests: string[];
	notices: Array<Extract<AgentSessionEvent, { type: "notice" }>>;
}> {
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
		sessionManager: persist
			? SessionManager.create(tempDir.path(), path.join(tempDir.path(), `sessions-${id}`))
			: SessionManager.inMemory(tempDir.path()),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
		agentId: id,
		asyncJobManager: jobManager,
	});
	cleanups.push(async () => {
		await session.dispose();
		authStorage.close();
	});
	const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];
	session.subscribe(event => {
		if (event.type === "notice") notices.push(event);
	});
	const registry = AgentRegistry.global();
	registry.register({
		id,
		displayName: id,
		kind,
		parentId,
		session,
		sessionFile: session.sessionManager.getSessionFile() ?? null,
		status: "idle",
	});
	registry.syncSessionStatus(id, session);
	return { session, requests, notices };
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

/** One dispatch armed on main: `settle` ends its run. */
function armOnMain(input: { childId: string; ownerId: string; ownerAddress: { entryId: string | null } }): () => void {
	const settled = Promise.withResolvers<void>();
	AgentRegistry.global().dueBy.arm(
		{
			childId: input.childId,
			ownerId: input.ownerId,
			ownerAddress: { entryId: input.ownerAddress.entryId, toolCallId: undefined },
			agent: "task",
			dispatchedAt: Date.now(),
			dueMs: DUE_MS,
			stated: true,
		},
		{ settled: settled.promise, signal: new AbortController().signal },
	);
	return () => settled.resolve();
}

const lostIn = (notices: readonly { message: string }[], childId: string, stage: "owner" | "escalation") =>
	notices.filter(
		notice =>
			notice.message.includes(LOST_NOTICE) &&
			notice.message.includes(`\`${childId}\``) &&
			notice.message.includes(stage === "owner" ? "running past the due-by" : "running past twice the due-by"),
	).length;

describe("each due-by notice ends exactly once, wherever its recipient lives", () => {
	it("a worker-homed recipient whose sent request outlives the bound counts it read, not lost", async () => {
		const probe = await startWorker();
		await mainSession("Main", "main");
		// Held in preparation until just before the bound, then the provider
		// blocks the worker past it: the main thread hears of the hand-off late.
		await probe.open("Owner", "Main", { holdBeforeModelMs: NOTICE_DEADLINE_MS - 2_000, blockInProviderMs: 2_500 });
		await probe.prompt("Owner", "the conversation the work is dispatched from");
		child("Child", "Owner");
		const warnings = personNotices();
		const settle = armOnMain({ childId: "Child", ownerId: "Owner", ownerAddress: await probe.address("Owner") });
		await waitFor(async () => carries(await probe.requests("Owner"), OWNER_NOTICE, "Child") > 0, 20_000);
		// Well past the bound: a loss would have surfaced by now.
		await Bun.sleep(3_000);
		settle();
		expect(carries(await probe.requests("Owner"), OWNER_NOTICE, "Child")).toBe(1);
		expect(lostIn(warnings, "Child", "owner")).toBe(0);
	}, 40_000);

	it("a task call on a worker shows its due-by as soon as it returns", async () => {
		const probe = await startWorker();
		await mainSession("Main", "main");
		await probe.open("Owner", "Main", { persistDir: tempDir.path() });
		await probe.prompt("Owner", "the conversation the work is dispatched from");
		const seen = await probe.dispatchAndLook("Owner", "WorkerChild", 5);
		await probe.releaseChildren();
		expect(seen.dueAt).toBeDefined();
		expect(seen.proc).toContain("due by");
	}, 30_000);

	it("a task call on a worker is addressed to the conversation that made it, not where it moved next", async () => {
		const probe = await startWorker();
		await mainSession("Main", "main");
		await probe.open("Owner", "Main", { persistDir: tempDir.path() });
		await probe.prompt("Owner", "before the dispatch");
		const cut = await probe.appendCutPoint("Owner");
		await probe.prompt("Owner", "the dispatching turn");
		const warnings = personNotices();
		await probe.dispatchThenBranchAway("Owner", "BranchChild", 0.004, cut);
		await waitFor(() => lostIn(warnings, "BranchChild", "owner") > 0, 15_000);
		await probe.releaseChildren();
		expect(carries(await probe.requests("Owner"), OWNER_NOTICE, "BranchChild")).toBe(0);
		expect(lostIn(warnings, "BranchChild", "owner")).toBe(1);
	}, 30_000);

	it("a main session mid-switch at the dispatch is never addressed by the transcript it switches to", async () => {
		const main = await mainSession("Main", "main", undefined, true);
		await main.session.prompt("ORIGINAL_CONVERSATION");
		const other = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "other"));
		other.appendMessage({ role: "user", content: "UNRELATED_CONVERSATION", timestamp: Date.now() });
		const otherFile = other.getSessionFile();
		if (!otherFile) throw new Error("no session file");
		await other.ensureOnDisk();
		await other.close();
		AgentRegistry.global().register({
			id: "Mid",
			displayName: "Mid",
			kind: "sub",
			status: "parked",
			session: null,
			sessionFile: null,
		});
		const lead = await mainSession("Lead", "sub", "Mid");
		await lead.session.prompt("the lead's conversation");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const refresh = main.session.refreshBaseSystemPrompt.bind(main.session);
		vi.spyOn(main.session, "refreshBaseSystemPrompt").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return refresh();
		});
		const switching = main.session.switchSession(otherFile);
		await entered.promise;
		child("Child", "Lead");
		const settle = armOnMain({
			childId: "Child",
			ownerId: "Lead",
			ownerAddress: { entryId: lead.session.sessionManager.getLeafId() },
		});
		release.resolve();
		expect(await switching).toBe(true);
		// No agent above the lead holds the dispatch, so the person is told, standing on the lead.
		await waitFor(() => lead.notices.some(notice => notice.message.includes(ESCALATION)), 5_000);
		settle();
		expect(main.notices.filter(notice => notice.message.includes(ESCALATION))).toEqual([]);
		expect(lead.notices.filter(notice => notice.message.includes(ESCALATION))).toHaveLength(1);
	}, 30_000);

	it("a session registered under the main id after the dispatch is never addressed by it", async () => {
		await mainSession("Main", "main");
		AgentRegistry.global().register({
			id: "Mid",
			displayName: "Mid",
			kind: "sub",
			status: "parked",
			session: null,
			sessionFile: null,
		});
		const lead = await mainSession("Lead", "sub", "Mid");
		await lead.session.prompt("the lead's conversation");
		const replacement = await mainSession("Prepared", "sub");
		await replacement.session.prompt("A LATER MAIN CONVERSATION");
		AgentRegistry.global().unregister("Prepared");
		child("Child", "Lead");
		const settle = armOnMain({
			childId: "Child",
			ownerId: "Lead",
			ownerAddress: { entryId: lead.session.sessionManager.getLeafId() },
		});
		// Right after the dispatch, another session takes the main id.
		AgentRegistry.global().unregister("Main");
		AgentRegistry.global().register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: replacement.session,
			sessionFile: null,
			status: "idle",
		});
		await waitFor(() => lead.notices.some(notice => notice.message.includes(ESCALATION)), 5_000);
		settle();
		expect(replacement.notices.filter(notice => notice.message.includes(ESCALATION))).toEqual([]);
		expect(carries(replacement.requests, ESCALATION, "Child")).toBe(0);
	}, 30_000);

	it("a dispatch with no due-by still records its conversation for the escalations of its child's own dispatches", async () => {
		const boss = await mainSession("Boss", "main");
		await boss.session.prompt("BOSS_DISPATCH_CONVERSATION");
		const lead = await mainSession("Lead", "sub", "Boss");
		await lead.session.prompt("the lead's conversation");
		const leadSettled = Promise.withResolvers<void>();
		// Boss dispatched Lead with no due-by (task.dueMinutes 0).
		AgentRegistry.global().dueBy.arm(
			{
				childId: "Lead",
				ownerId: "Boss",
				ownerAddress: { entryId: boss.session.sessionManager.getLeafId(), toolCallId: undefined },
				agent: "task",
				dispatchedAt: Date.now(),
				dueMs: 0,
				stated: false,
			},
			{ settled: leadSettled.promise, signal: new AbortController().signal },
		);
		expect(await boss.session.newSession()).toBe(true);
		await boss.session.prompt("BOSS_NEW_UNRELATED_CONVERSATION");
		child("Grandchild", "Lead");
		const settle = armOnMain({
			childId: "Grandchild",
			ownerId: "Lead",
			ownerAddress: { entryId: lead.session.sessionManager.getLeafId() },
		});
		// Boss's dispatch-time conversation is gone, so no agent is told: the person is, on the lead.
		await waitFor(() => lead.notices.some(notice => notice.message.includes(ESCALATION)), 5_000);
		settle();
		leadSettled.resolve();
		expect(carries(boss.requests, ESCALATION, "Grandchild")).toBe(0);
	}, 30_000);

	it("an escalation to the person is not shown on a session that moved off the dispatch meanwhile", async () => {
		const owner = await mainSession("Main", "main", undefined, true);
		await owner.session.prompt("ORIGINAL_CONVERSATION");
		const other = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "other"));
		other.appendMessage({ role: "user", content: "UNRELATED_CONVERSATION", timestamp: Date.now() });
		const otherFile = other.getSessionFile();
		if (!otherFile) throw new Error("no session file");
		await other.ensureOnDisk();
		await other.close();
		child("Child", "Main");
		const probe = owner.session.dueByProbe.bind(owner.session);
		let probes = 0;
		// Probes: the owner notice's, then the escalation text's, then the
		// escalation's own check; the session switches during that last one.
		vi.spyOn(owner.session, "dueByProbe").mockImplementation(async (address, waitMs) => {
			probes++;
			if (probes === 3) await owner.session.switchSession(otherFile);
			return probe(address, waitMs);
		});
		const settle = armOnMain({
			childId: "Child",
			ownerId: "Main",
			ownerAddress: { entryId: owner.session.sessionManager.getLeafId() },
		});
		await waitFor(() => lostIn(owner.notices, "Child", "escalation") > 0, 5_000);
		settle();
		expect(owner.notices.filter(notice => notice.message.includes(ESCALATION))).toEqual([]);
		expect(lostIn(owner.notices, "Child", "escalation")).toBe(1);
	}, 30_000);

	it("a person notice standing on a disposed worker session reports that no one was told", async () => {
		const probe = await startWorker();
		await probe.open("Owner", "Main");
		expect(await probe.notifyPersonOnDisposed("Owner")).toBe(false);
	}, 30_000);

	it("a peek while the conversation is elsewhere does not lose a queued notice", async () => {
		const owner = await mainSession("Main", "main", undefined, true);
		await owner.session.prompt("before");
		const cut = owner.session.sessionManager.getLeafId();
		if (!cut) throw new Error("no leaf");
		await owner.session.prompt("the dispatching turn");
		const dispatchLeaf = owner.session.sessionManager.getLeafId();
		if (!dispatchLeaf) throw new Error("no leaf");
		// Keep the notice queued: no idle turn starts while "streaming".
		Object.defineProperty(owner.session, "isStreaming", { value: true, configurable: true });
		let open = true;
		let held = false;
		let committed = 0;
		const receipt = owner.session.notifySubagentOverdue({
			childId: "Child",
			stage: "owner",
			text: "`Child` (task) is taking longer than you said",
			address: { entryId: dispatchLeaf, toolCallId: undefined },
			isOpen: () => open && !held,
			reserve: () => {
				if (!open || held) return false;
				held = true;
				return true;
			},
			release: () => {
				held = false;
			},
			commit: () => {
				held = false;
				open = false;
				committed++;
			},
		});
		expect((await owner.session.navigateTree(cut)).cancelled).toBe(false);
		expect(owner.session.yieldQueue.hasDeliverable(SUBAGENT_OVERDUE_MESSAGE_TYPE)).toBe(false);
		expect((await owner.session.navigateTree(dispatchLeaf)).cancelled).toBe(false);
		expect(owner.session.yieldQueue.hasDeliverable(SUBAGENT_OVERDUE_MESSAGE_TYPE)).toBe(true);
		Reflect.deleteProperty(owner.session, "isStreaming");
		await owner.session.yieldQueue.flush("idle");
		await receipt;
		expect(committed).toBe(1);
		expect(carries(owner.requests, OWNER_NOTICE, "Child")).toBe(1);
	}, 30_000);
});
