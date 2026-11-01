/**
 * An IRC message that reaches a message-result subagent from anyone but its
 * parent (or as a broadcast) during or right after its final report turn is
 * answered in its own wake turn: the report stays the run's result, and a
 * direct sender still gets the reply.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "Reporter";
const PARENT_ID = "Main";
const PEER_ID = "Peer";
const CHILD_ID = "Reporter.Child";
const REPORT = "FULL_REPORT: findings one, two, three.";
const PEER_BODY = "Quick question?";
const PARENT_BODY = "Parent asks: anything else?";
const WAKE_BODY = "Parent wake: recheck one thing.";
const MOCK_API_SOURCE = "test/peer-message-after-report";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;
let manager: AsyncJobManager;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-peer-after-report-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	manager = new AsyncJobManager({ maxRunningJobs: 4 });
	AsyncJobManager.setInstance(manager);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AsyncJobManager.setInstance(undefined);
	await manager.dispose({ timeoutMs: 1_000 });
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

/** Text of the newest non-assistant message the model sees. */
function latestInput(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role === "assistant") continue;
		const content = message.content as unknown;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
				.join("");
		}
		return "";
	}
	return "";
}

/** Answers whatever the newest input asks: a peer question, a parent request, a parent wake, else the report. */
function answer(context: Context): MockResponse {
	const input = latestInput(context);
	if (input.includes(PEER_BODY)) return { content: ["PEER_REPLY"] };
	if (input.includes(PARENT_BODY)) return { content: ["PARENT_ANSWER"] };
	if (input.includes(WAKE_BODY)) return { content: ["WAKE_ANSWER"] };
	return { content: [REPORT] };
}

/** Starts a plain (message-result) subagent run; `beforeResponse` gates request `n` so a test can deliver mid-turn. */
async function startRun(options: {
	beforeResponse?: (request: number) => Promise<void> | void;
	respond?: (request: number, context: Context) => MockResponse;
	idleTtlMs?: number;
	deferIrcWakeRelease?: (release: () => void) => void;
	structured?: boolean;
}) {
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });
	await Bun.write(path.join(cwd, "notes.txt"), "notes\n");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	let request = 0;
	const mock = createMockModel({
		handler: async context => {
			const n = ++request;
			await options.beforeResponse?.(n);
			return options.respond?.(n, context) ?? answer(context);
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const deliveries: string[] = [];
	const unregisterSink = manager.registerDeliverySink(PARENT_ID, (_jobId, text) => {
		deliveries.push(text);
	});
	// The peer has no session: what the subagent sends it lands on this bus waiter.
	AgentRegistry.global().register({ id: PEER_ID, displayName: "peer", kind: "sub", session: null });
	const peerInbox = IrcBus.global().wait(PEER_ID, { from: AGENT_ID }, 10_000);
	const run = runSubprocess({
		cwd,
		artifactsDir,
		agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
		task: "report",
		index: 0,
		id: AGENT_ID,
		parentAgentId: PARENT_ID,
		asyncJobManager: manager,
		structured: options.structured ?? false,
		modelOverride: "mock/mock-model",
		authStorage,
		modelRegistry,
		settings: Settings.isolated({
			"task.agentIdleTtlMs": options.idleTtlMs ?? 0,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			modelRoles: { default: "mock/mock-model" },
		}),
		enableLsp: false,
		enableMCP: false,
		enableIrc: true,
		deferIrcWakeRelease: options.deferIrcWakeRelease,
	});
	const close = (): void => {
		unregisterSink();
		authStorage.close();
	};
	return {
		run,
		artifact: path.join(artifactsDir, `${AGENT_ID}.md`),
		artifactsDir,
		deliveries,
		peerInbox,
		close,
		mock,
	};
}

/** Lets the subagent's current turn, its relays and the parent's deliveries settle. */
async function settle(): Promise<void> {
	const session = AgentRegistry.global().get(AGENT_ID)?.session;
	if (session) {
		await session.waitForIdle();
		await session.waitForIrcReplies();
	}
	await manager.waitForOwnerJobs(PARENT_ID);
	await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
}

/** Gate for request `n`: `started` resolves when the request begins, which then waits for `release`. */
function gate(n: number) {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	return {
		started: started.promise,
		release: () => release.resolve(),
		beforeResponse: async (request: number) => {
			if (request !== n) return;
			started.resolve();
			await release.promise;
		},
	};
}

it("keeps the report when a peer message arrives during the final report turn, and relays the reply to the peer", async () => {
	const report = gate(1);
	const child = await startRun({ beforeResponse: report.beforeResponse });
	try {
		await report.started;
		const receipt = await IrcBus.global().send({ from: PEER_ID, to: AGENT_ID, body: PEER_BODY });
		expect(receipt.outcome).toBe("injected");
		report.release();
		const result = await child.run;
		expect(result.output).toBe(REPORT);
		expect((await child.peerInbox)?.body).toBe("PEER_REPLY");
		await settle();
		expect(await Bun.file(child.artifact).text()).toBe(REPORT);
		expect(child.deliveries.join("\n")).not.toContain("PEER_REPLY");
	} finally {
		report.release();
		child.close();
	}
}, 20_000);

it("returns the report without waiting for the turn that answers a peer", async () => {
	const report = gate(1);
	const peerTurn = gate(2);
	const child = await startRun({
		beforeResponse: async request => {
			await report.beforeResponse(request);
			await peerTurn.beforeResponse(request);
		},
	});
	try {
		await report.started;
		await IrcBus.global().send({ from: PEER_ID, to: AGENT_ID, body: PEER_BODY });
		report.release();
		// The peer's turn stays gated until the run returns: a run that waited on it never would.
		const result = await child.run;
		expect(result.output).toBe(REPORT);
		peerTurn.release();
		expect((await child.peerInbox)?.body).toBe("PEER_REPLY");
	} finally {
		report.release();
		peerTurn.release();
		child.close();
	}
}, 20_000);

it("keeps the report when answering the peer takes tool calls", async () => {
	const report = gate(1);
	const child = await startRun({
		beforeResponse: report.beforeResponse,
		// Report, then answer the peer after looking something up.
		respond: request => {
			if (request === 1) return { content: [REPORT] };
			if (request === 2) {
				return { content: [{ type: "toolCall", id: "call-peer", name: "read", arguments: { path: "notes.txt" } }] };
			}
			return { content: ["PEER_REPLY"] };
		},
	});
	try {
		await report.started;
		await IrcBus.global().send({ from: PEER_ID, to: AGENT_ID, body: PEER_BODY });
		report.release();
		const result = await child.run;
		expect(result.output).toBe(REPORT);
		expect((await child.peerInbox)?.body).toBe("PEER_REPLY");
		await settle();
		expect(await Bun.file(child.artifact).text()).toBe(REPORT);
	} finally {
		report.release();
		child.close();
	}
}, 20_000);

/** Sends `body` from `from` once the report's turn (request 1) has ended, before the run settles. */
function afterReport(from: string, body: string) {
	const sent = Promise.withResolvers<{ outcome: string }>();
	return {
		sent: sent.promise,
		beforeResponse: (request: number) => {
			if (request !== 1) return;
			const session = AgentRegistry.global().get(AGENT_ID)?.session;
			const unsubscribe = session?.subscribe(event => {
				if (event.type !== "agent_end") return;
				unsubscribe?.();
				sent.resolve(IrcBus.global().send({ from, to: AGENT_ID, body }));
			});
		},
	};
}

it("keeps the report when a peer message arrives right after the final report turn", async () => {
	const peer = afterReport(PEER_ID, PEER_BODY);
	const child = await startRun({ beforeResponse: peer.beforeResponse });
	try {
		const result = await child.run;
		expect((await peer.sent).outcome).not.toBe("failed");
		expect(result.output).toBe(REPORT);
		expect((await child.peerInbox)?.body).toBe("PEER_REPLY");
		await settle();
		expect(await Bun.file(child.artifact).text()).toBe(REPORT);
		expect(child.deliveries.join("\n")).not.toContain("PEER_REPLY");
	} finally {
		child.close();
	}
}, 20_000);

it("answers a peer message that arrives while the run waits on background work in a turn of its own", async () => {
	const job = Promise.withResolvers<void>();
	const peer = afterReport(PEER_ID, PEER_BODY);
	const child = await startRun({
		beforeResponse: request => {
			// The report turn ends with an owned background job still running.
			if (request === 1) {
				manager.register(
					"bash",
					"background build",
					async () => {
						await job.promise;
						return "build done";
					},
					{ ownerId: AGENT_ID, agentId: AGENT_ID },
				);
			}
			peer.beforeResponse(request);
		},
	});
	try {
		expect((await peer.sent).outcome).not.toBe("failed");
		job.resolve();
		const result = await child.run;
		expect(result.output).toBe(REPORT);
		expect((await child.peerInbox)?.body).toBe("PEER_REPLY");
	} finally {
		job.resolve();
		child.close();
	}
}, 20_000);

it("lets the agent answer its own child's question while its run waits on that child's work", async () => {
	const job = Promise.withResolvers<void>();
	const childAsked = afterReport(CHILD_ID, PEER_BODY);
	const answering = Promise.withResolvers<void>();
	AgentRegistry.global().register({
		id: CHILD_ID,
		displayName: "child",
		kind: "sub",
		parentId: AGENT_ID,
		session: null,
	});
	const child = await startRun({
		beforeResponse: request => {
			if (request === 1) {
				manager.register(
					"bash",
					"child's work",
					async () => {
						await job.promise;
						return "child done";
					},
					{ ownerId: AGENT_ID, agentId: AGENT_ID },
				);
			}
			// The question is answered before the work it may be blocking finishes.
			if (request === 2) answering.resolve();
			childAsked.beforeResponse(request);
		},
	});
	try {
		expect((await childAsked.sent).outcome).toBe("woken");
		await answering.promise;
		job.resolve();
		expect((await child.run).output).toBe(REPORT);
	} finally {
		job.resolve();
		child.close();
	}
}, 20_000);

it("does not park an agent while it still holds a peer's message for a turn of its own", async () => {
	const peer = afterReport(PEER_ID, PEER_BODY);
	const held = Promise.withResolvers<() => void>();
	const child = await startRun({
		beforeResponse: peer.beforeResponse,
		idleTtlMs: 1,
		deferIrcWakeRelease: release => held.resolve(release),
	});
	try {
		expect((await child.run).output).toBe(REPORT);
		const release = await held.promise;
		// Real time on purpose: the lifecycle's idle timer is what would park the agent.
		await Bun.sleep(50);
		expect(AgentRegistry.global().get(AGENT_ID)?.status).not.toBe("parked");
		release();
		expect((await child.peerInbox)?.body).toBe("PEER_REPLY");
	} finally {
		child.close();
	}
}, 20_000);

it("does not park an agent whose released peer message still waits for a pooled yield contract to clear", async () => {
	const peer = afterReport(PEER_ID, PEER_BODY);
	const held = Promise.withResolvers<() => void>();
	const child = await startRun({
		beforeResponse: peer.beforeResponse,
		idleTtlMs: 1,
		deferIrcWakeRelease: release => held.resolve(release),
	});
	try {
		expect((await child.run).output).toBe(REPORT);
		const release = await held.promise;
		const session = AgentRegistry.global().get(AGENT_ID)?.session;
		if (!session) throw new Error("kept-alive subagent has no live session");
		// A pooled worker's yield contract outlives the hold, so the released message stays queued.
		await session.setWorkPoolYieldItems([{ id: "pool#1", index: 1 }]);
		release();
		// Real time on purpose: the lifecycle's idle timer is what would park the agent.
		await Bun.sleep(50);
		expect(AgentRegistry.global().get(AGENT_ID)?.status).not.toBe("parked");
		await session.setWorkPoolYieldItems([]);
		expect((await child.peerInbox)?.body).toBe("PEER_REPLY");
	} finally {
		child.close();
	}
}, 20_000);

it("keeps a follow-up turn's report when a peer message arrives right after it", async () => {
	const peer = afterReport(PEER_ID, PEER_BODY);
	const child = await startRun({
		// Request 2 is the follow-up's report turn.
		beforeResponse: request => peer.beforeResponse(request - 1),
		respond: (request, context) => (request === 2 ? { content: ["FOLLOW_UP_REPORT"] } : answer(context)),
	});
	try {
		expect((await child.run).output).toBe(REPORT);
		const followUp = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			message: "report again",
			structured: false,
			artifactsDir: child.artifactsDir,
		});
		expect(followUp.output).toBe("FOLLOW_UP_REPORT");
		expect((await child.peerInbox)?.body).toBe("PEER_REPLY");
		await settle();
		expect(await Bun.file(child.artifact).text()).toBe("FOLLOW_UP_REPORT");
	} finally {
		child.close();
	}
}, 20_000);

it("keeps a structured run's yield when a peer message arrives as a turn of it ends without yielding", async () => {
	const child = await startRun({
		structured: true,
		// Request 1 ends in prose while a peer message arrives; the driver then reminds the agent to yield.
		beforeResponse: request => {
			if (request === 1) void IrcBus.global().send({ from: PEER_ID, to: AGENT_ID, body: PEER_BODY });
		},
		respond: (request, context) => {
			if (context.messages.at(-1)?.role === "toolResult") return { content: ["ok"] };
			if (request === 1) return { content: ["Working on it."] };
			const data = latestInput(context).includes(PEER_BODY) ? "PEER_PAYLOAD" : "INITIAL";
			return {
				content: [{ type: "toolCall", id: `yield-${request}`, name: "yield", arguments: { type: "result", data } }],
			};
		},
	});
	try {
		const result = await child.run;
		expect(result.output).toContain("INITIAL");
		expect(result.output).not.toContain("PEER_PAYLOAD");
		await settle();
		expect(child.mock.calls.some(call => latestInput(call.context).includes(PEER_BODY))).toBe(true);
	} finally {
		child.close();
	}
}, 20_000);

it("keeps a structured follow-up's yield when a peer message arrives as a turn of it ends without yielding", async () => {
	let peerSent: Promise<{ outcome: string }> | undefined;
	const child = await startRun({
		structured: true,
		// Request 1 yields the first run. Request 2, the follow-up's first turn, ends in prose
		// while a peer message arrives; the driver then reminds the agent to yield.
		beforeResponse: request => {
			if (request === 2) peerSent = IrcBus.global().send({ from: PEER_ID, to: AGENT_ID, body: PEER_BODY });
		},
		respond: (request, context) => {
			if (context.messages.at(-1)?.role === "toolResult") return { content: ["ok"] };
			if (request === 2) return { content: ["Working on it."] };
			const input = latestInput(context);
			const data = input.includes(PEER_BODY) ? "PEER_PAYLOAD" : request === 1 ? "INITIAL" : "FOLLOW_UP";
			return {
				content: [{ type: "toolCall", id: `yield-${request}`, name: "yield", arguments: { type: "result", data } }],
			};
		},
	});
	try {
		expect((await child.run).output).toContain("INITIAL");
		const followUp = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			message: "report again",
			artifactsDir: child.artifactsDir,
		});
		expect((await peerSent)?.outcome).not.toBe("failed");
		expect(followUp.output).toContain("FOLLOW_UP");
		expect(followUp.output).not.toContain("PEER_PAYLOAD");
		await settle();
		// The peer's message was answered in a turn of its own.
		expect(child.mock.calls.some(call => latestInput(call.context).includes(PEER_BODY))).toBe(true);
	} finally {
		child.close();
	}
}, 20_000);

it("still answers the parent's own message that arrives right after the final report turn as the run's result", async () => {
	const parent = afterReport(PARENT_ID, PARENT_BODY);
	const child = await startRun({ beforeResponse: parent.beforeResponse });
	try {
		const result = await child.run;
		expect((await parent.sent).outcome).not.toBe("failed");
		expect(result.output).toBe("PARENT_ANSWER");
		await settle();
		// The run's own result carries the answer; no separate wake result follows it.
		expect(child.deliveries).toEqual([]);
	} finally {
		child.close();
	}
}, 20_000);

for (const from of [PEER_ID, PARENT_ID]) {
	it(`keeps the report when a broadcast from ${from === PARENT_ID ? "the parent" : "a peer"} arrives during the final report turn, without replying to it`, async () => {
		const report = gate(1);
		const broadcastTurn = gate(2);
		const child = await startRun({
			beforeResponse: async request => {
				await report.beforeResponse(request);
				await broadcastTurn.beforeResponse(request);
			},
		});
		try {
			await report.started;
			const receipt = await IrcBus.global().send({ from, to: AGENT_ID, body: PEER_BODY, broadcast: true });
			expect(receipt.outcome).toBe("injected");
			report.release();
			const result = await child.run;
			expect(result.output).toBe(REPORT);
			// The broadcast still gets its own turn; nothing is sent back for it.
			broadcastTurn.release();
			await broadcastTurn.started;
			await settle();
			expect(await Bun.file(child.artifact).text()).toBe(REPORT);
			expect(IrcBus.global().sentSince(AGENT_ID, from, 0)).toBe(false);
			expect(child.deliveries.join("\n")).not.toContain("PEER_REPLY");
		} finally {
			report.release();
			broadcastTurn.release();
			child.close();
		}
	}, 20_000);
}

it("delivers a parent wake turn's answer, not its reply to a peer message that arrived during it", async () => {
	const wake = gate(2);
	const child = await startRun({ beforeResponse: wake.beforeResponse });
	try {
		expect((await child.run).output).toBe(REPORT);
		const woken = await IrcBus.global().send({ from: PARENT_ID, to: AGENT_ID, body: WAKE_BODY });
		expect(woken.outcome).toBe("woken");
		await wake.started;
		const receipt = await IrcBus.global().send({ from: PEER_ID, to: AGENT_ID, body: PEER_BODY });
		expect(receipt.outcome).toBe("injected");
		wake.release();
		expect((await child.peerInbox)?.body).toBe("PEER_REPLY");
		await settle();
		expect(child.deliveries.join("\n")).toContain("WAKE_ANSWER");
		expect(child.deliveries.join("\n")).not.toContain("PEER_REPLY");
		expect(await Bun.file(child.artifact).text()).toBe("WAKE_ANSWER");
	} finally {
		wake.release();
		child.close();
	}
}, 20_000);

it("still answers the parent's own request that arrives during the final report turn", async () => {
	const report = gate(1);
	const child = await startRun({ beforeResponse: report.beforeResponse });
	try {
		await report.started;
		const receipt = await IrcBus.global().send({ from: PARENT_ID, to: AGENT_ID, body: PARENT_BODY });
		expect(receipt.outcome).toBe("injected");
		report.release();
		const result = await child.run;
		expect(result.output).toBe("PARENT_ANSWER");
		await settle();
		expect(await Bun.file(child.artifact).text()).toBe("PARENT_ANSWER");
	} finally {
		report.release();
		child.close();
	}
}, 20_000);

it("still shows a peer message to the agent within the run when it arrives while the agent works", async () => {
	const work = gate(1);
	const child = await startRun({
		beforeResponse: work.beforeResponse,
		respond: request =>
			request === 1
				? { content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.txt" } }] }
				: { content: [REPORT] },
	});
	try {
		await work.started;
		const receipt = await IrcBus.global().send({ from: PEER_ID, to: AGENT_ID, body: PEER_BODY });
		expect(receipt.outcome).toBe("injected");
		work.release();
		const result = await child.run;
		expect(result.output).toBe(REPORT);
		// The run's second request already carried the peer's message.
		expect(JSON.stringify(child.mock.calls[1]?.context.messages)).toContain(PEER_BODY);
		expect(child.mock.calls).toHaveLength(2);
	} finally {
		work.release();
		child.close();
	}
}, 20_000);
