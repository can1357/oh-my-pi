import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentTool, type AgentToolResult, TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { emitSessionShutdownEvent, ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { createAssistantMessage } from "../helpers/agent-session-setup";

/**
 * Contract: a reply an extension expects for its agent (`pi.replies.expect`, a peer behind a
 * bridge) is one `wait` blocks for, in that session's agent only (not another session, not its
 * advisor), until a message interrupts the wait or the expectation stops counting: released by the
 * extension or at the load's teardown, paused while the load is suspended, or dropped when the
 * session replaces its conversation.
 */
const PEER = "@murmur/leia";

type WaitResult = AgentToolResult<CoordinationDetails>;

/** An extension load on its own runtime, as one session's extensions get. */
async function loadBridge(): Promise<{ api: ExtensionAPI; runtime: ExtensionRuntime; runner: ExtensionRunner }> {
	const runtime = new ExtensionRuntime();
	let api: ExtensionAPI | undefined;
	const extension = await loadExtensionFromFactory(
		pi => {
			api = pi;
		},
		"/tmp",
		new EventBus(),
		runtime,
		"bridge",
	);
	if (!api) throw new Error("factory did not run");
	const runner = new ExtensionRunner([extension], runtime, "/tmp", { getCwd: () => "/tmp" } as never, {} as never);
	return { api, runtime, runner };
}

function waitTool(runtime: ExtensionRuntime, agentId = "Main"): WaitTool {
	return new WaitTool({
		cwd: process.cwd(),
		settings: Settings.isolated({ "launch.enabled": false }),
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: new AsyncJobManager({}),
		getAgentId: () => agentId,
		expectedReplies: runtime.expectedReplies,
	} as unknown as ToolSession);
}

function text(result: WaitResult): string {
	const [first] = result.content;
	return first?.type === "text" ? first.text : "";
}

/** Whether `waiting` is still blocked once pending callbacks have run. */
async function stillBlocked(waiting: Promise<unknown>): Promise<boolean> {
	let settled = false;
	void waiting.then(() => {
		settled = true;
	});
	const tick = Promise.withResolvers<void>();
	setImmediate(tick.resolve);
	await tick.promise;
	return !settled;
}

/** The interrupt a steer injected by the bridge (or any message) raises on a running `wait`. */
async function interrupt(controller: AbortController, waiting: Promise<WaitResult>): Promise<WaitResult> {
	controller.abort(TOOL_INTERRUPT_ABORT_REASON);
	return waiting;
}

describe("wait on replies an extension expects", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		vi.useRealTimers();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("blocks for an expected reply until a message interrupts it", async () => {
		const { api, runtime } = await loadBridge();
		api.replies.expect(PEER);
		const controller = new AbortController();
		const waiting = waitTool(runtime).execute("wait", {}, controller.signal);
		expect(await stillBlocked(waiting)).toBe(true);
		const result = await interrupt(controller, waiting);
		expect(text(result)).toBe("Wait interrupted by message.");
		expect(result.details).toMatchObject({ interrupted: true });
	});

	test("a local agent's broadcast does not end a wait on an expected peer that shares its id", async () => {
		// Opaque peer ids are not registry ids, but nothing stops one equalling a local agent's.
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", status: "running", session: null });
		registry.register({ id: "Leia", displayName: "Leia", kind: "sub", parentId: "Main", session: null });
		const { api, runtime } = await loadBridge();
		api.replies.expect("Leia");
		const controller = new AbortController();
		const waiting = waitTool(runtime).execute("wait", {}, controller.signal);
		expect(await stillBlocked(waiting)).toBe(true);
		await IrcBus.global().send({ from: "Leia", to: "Main", body: "editing auth.ts", broadcast: true });
		expect(await stillBlocked(waiting)).toBe(true);
		await interrupt(controller, waiting);
	});

	test("a release drops only its own expectation; with none left, wait is an idle poll again", async () => {
		const { api, runtime } = await loadBridge();
		const first = api.replies.expect(PEER);
		const second = api.replies.expect(PEER);
		first();
		first();
		const controller = new AbortController();
		const waiting = waitTool(runtime).execute("wait", {}, controller.signal);
		expect(await stillBlocked(waiting)).toBe(true);
		await interrupt(controller, waiting);

		second();
		const idle = await waitTool(runtime).execute("idle", {});
		expect(idle.useless).toBe(true);
		expect(text(idle)).toContain("Nothing to wait for");
	});

	test("releasing the last expectation ends a blocked wait, naming the peer", async () => {
		const { api, runtime } = await loadBridge();
		const release = api.replies.expect(PEER);
		const waiting = waitTool(runtime).execute("wait", {});
		expect(await stillBlocked(waiting)).toBe(true);
		release();
		const result = await waiting;
		expect(result.isError).toBeUndefined();
		expect(text(result)).toContain(`\`${PEER}\` no longer owes a reply`);
	});

	test("an expected peer's opaque id appears in the result as one bounded line", async () => {
		const { api, runtime } = await loadBridge();
		const hostile = `@mesh/le\nia\u001b[31m${"x".repeat(500)}`;
		const release = api.replies.expect(hostile);
		const waiting = waitTool(runtime).execute("wait", {});
		expect(await stillBlocked(waiting)).toBe(true);
		release();
		const result = text(await waiting);
		expect(result).toContain("no longer owes a reply");
		expect(result).not.toMatch(/[\n\u001b]/);
		expect(result).not.toContain("x".repeat(100));
	});

	test("a result names at most a preview of the expected peers, counting the rest", async () => {
		const { api, runtime } = await loadBridge();
		const releases = Array.from({ length: 30 }, (_, i) => api.replies.expect(`@mesh/peer-${i}`));
		const waiting = waitTool(runtime).execute("wait", {});
		expect(await stillBlocked(waiting)).toBe(true);
		for (const release of releases) release();
		const result = text(await waiting);
		expect(result).toContain("`@mesh/peer-0`");
		expect(result).toContain("and 22 more no longer owes a reply");
		expect(result).not.toContain("`@mesh/peer-29`");
	});

	test("a release followed at once by a new expectation keeps the wait blocked, then names the new peer", async () => {
		const { api, runtime } = await loadBridge();
		const release = api.replies.expect(PEER);
		const waiting = waitTool(runtime).execute("wait", {});
		expect(await stillBlocked(waiting)).toBe(true);
		// One synchronous step: the first peer is done, a follow-up question went to another.
		release();
		const releaseHan = api.replies.expect("@murmur/han");
		expect(await stillBlocked(waiting)).toBe(true);
		releaseHan();
		const result = text(await waiting);
		expect(result).toContain("`@murmur/han` no longer owes a reply");
		expect(result).not.toContain(PEER);
	});

	test("a wait that runs out names the peers still awaited", async () => {
		const { api, runtime } = await loadBridge();
		api.replies.expect(PEER);
		vi.useFakeTimers();
		const waiting = waitTool(runtime).execute("wait", {});
		// The ladder's first window.
		vi.advanceTimersByTime(5_000);
		const result = await waiting;
		// The advice after the window is the ladder's; naming the awaited peer is what an expectation adds.
		expect(text(result)).toStartWith(`No reply from \`${PEER}\` within 5.0s`);
		expect(result.useless).toBe(true);
	});

	test("an unpromised expectation counts only in the run it was recorded in; a promised one outlives it", async () => {
		const { api, runtime } = await loadBridge();
		api.replies.expect(PEER);
		// The session's agent went idle and started its next run.
		runtime.expectedReplies.beginRun();
		expect(text(await waitTool(runtime).execute("next-run", {}))).toContain("Nothing to wait for");

		api.replies.expect("@murmur/han", { promised: true });
		runtime.expectedReplies.beginRun();
		const controller = new AbortController();
		const waiting = waitTool(runtime).execute("later-run", {}, controller.signal);
		expect(await stillBlocked(waiting)).toBe(true);
		await interrupt(controller, waiting);
	});

	test("session shutdown releases the load's expectations", async () => {
		const { api, runtime, runner } = await loadBridge();
		api.replies.expect(PEER);
		await emitSessionShutdownEvent(runner);
		const result = await waitTool(runtime).execute("after-shutdown", {});
		expect(result.useless).toBe(true);
		expect(text(result)).toContain("Nothing to wait for");
	});

	test("a suspended load's expectations do not count; a resume restores them", async () => {
		const { api, runtime, runner } = await loadBridge();
		runner.setSuspendedExtensions(() => true);
		api.replies.expect(PEER);
		const idle = await waitTool(runtime).execute("suspended", {});
		expect(idle.useless).toBe(true);
		expect(text(idle)).toContain("Nothing to wait for");

		runner.setSuspendedExtensions(() => false);
		const controller = new AbortController();
		const waiting = waitTool(runtime).execute("resumed", {}, controller.signal);
		expect(await stillBlocked(waiting)).toBe(true);
		await interrupt(controller, waiting);
	});

	test("suspending the load ends a wait blocked only on its expectations, naming the peer", async () => {
		const { api, runtime, runner } = await loadBridge();
		api.replies.expect(PEER);
		const waiting = waitTool(runtime).execute("wait", {});
		expect(await stillBlocked(waiting)).toBe(true);
		runner.setSuspendedExtensions(() => true);
		expect(text(await waiting)).toContain(`\`${PEER}\` no longer owes a reply`);

		runner.setSuspendedExtensions(() => false);
		const controller = new AbortController();
		const again = waitTool(runtime).execute("resumed", {}, controller.signal);
		expect(await stillBlocked(again)).toBe(true);
		await interrupt(controller, again);
	});

	test("an expectation a torn-down load's leftover callback records is inert", async () => {
		const { api, runtime, runner } = await loadBridge();
		await emitSessionShutdownEvent(runner);
		let changes = 0;
		runtime.expectedReplies.onChange(() => {
			changes++;
		});
		const release = api.replies.expect(PEER);
		// Nothing was recorded, so nothing a blocked `wait` re-checks on changed either.
		expect(changes).toBe(0);
		const result = await waitTool(runtime).execute("after-teardown", {});
		expect(result.useless).toBe(true);
		expect(text(result)).toContain("Nothing to wait for");
		release();
		expect(changes).toBe(0);
	});

	test("a factory that expects a reply and then throws leaves no expectation behind", async () => {
		const runtime = new ExtensionRuntime();
		const failing: ExtensionFactory = pi => {
			pi.replies.expect(PEER);
			throw new Error("bridge failed to start");
		};
		await expect(loadExtensionFromFactory(failing, "/tmp", new EventBus(), runtime, "bridge")).rejects.toThrow(
			"bridge failed to start",
		);
		const result = await waitTool(runtime).execute("after-failed-load", {});
		expect(result.useless).toBe(true);
		expect(text(result)).toContain("Nothing to wait for");
	});

	describe("in real sessions", () => {
		let dir: string;
		let modelRegistry: ModelRegistry;

		beforeAll(async () => {
			dir = path.join(os.tmpdir(), `pi-wait-extension-replies-${Snowflake.next()}`);
			fs.mkdirSync(dir, { recursive: true });
			modelRegistry = new ModelRegistry(await discoverAuthStorage(dir));
		});
		afterAll(() => {
			modelRegistry.authStorage.close();
			removeSyncWithRetries(dir);
		});

		const open = async (
			extensions: ExtensionFactory[],
			settings = Settings.isolated(),
			sessionManager = SessionManager.inMemory(),
		): Promise<AgentSession> =>
			(
				await createAgentSession({
					cwd: dir,
					agentDir: dir,
					modelRegistry,
					// Same agent id in both sessions, each in its own registry.
					agentRegistry: new AgentRegistry(),
					sessionManager,
					settings,
					model: getBundledModel("openai", "gpt-4o-mini"),
					disableExtensionDiscovery: true,
					extensions,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					rules: [],
					workspaceTree: { rootPath: dir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				})
			).session;

		const userPrompt = (session: AgentSession, text: string) =>
			session.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text }],
				attribution: "user",
				timestamp: Date.now(),
			});
		// Each replaces the session's conversation, or moves it onto another path of the tree.
		const transitions: Array<[string, (session: AgentSession) => Promise<unknown>]> = [
			["/new", session => session.newSession()],
			["a branch at an earlier prompt", session => session.branch(userPrompt(session, "ask leia"))],
			["/clear", session => session.resetSessionContext()],
			[
				"/tree back to an earlier prompt",
				session => {
					userPrompt(session, "ask leia");
					session.sessionManager.appendMessage(createAssistantMessage("asked leia"));
					return session.navigateTree(userPrompt(session, "ask leia again"));
				},
			],
		];
		for (const [transition, move] of transitions) {
			test(`a promised expectation does not outlive the conversation (${transition})`, async () => {
				let bridge: ExtensionAPI | undefined;
				const session = await open([
					pi => {
						bridge = pi;
					},
				]);
				try {
					const release = bridge?.replies.expect(PEER, { promised: true });
					await move(session);
					const wait = session.getToolByName("wait") as AgentTool | undefined;
					const idle = (await wait?.execute("after-move", {})) as WaitResult;
					expect(text(idle)).toContain("Nothing to wait for");
					// Already dropped: a bridge settling its oldest question skips it.
					expect(release?.()).toBe(false);
				} finally {
					await session.dispose();
				}
			});
		}

		test("a branch whose hook keeps the live conversation keeps a promised expectation", async () => {
			let bridge: ExtensionAPI | undefined;
			const session = await open([
				pi => {
					bridge = pi;
					pi.on("session_before_branch", () => ({ skipConversationRestore: true }));
				},
			]);
			try {
				const release = bridge?.replies.expect(PEER, { promised: true });
				await session.branch(userPrompt(session, "ask leia"));
				expect(release?.()).toBe(true);
			} finally {
				await session.dispose();
			}
		});

		test("a reload that leaves the conversation as it was keeps a promised expectation", async () => {
			let bridge: ExtensionAPI | undefined;
			const sessionManager = SessionManager.create(dir, path.join(dir, `sessions-${Snowflake.next()}`));
			const session = await open(
				[
					pi => {
						bridge = pi;
					},
				],
				Settings.isolated(),
				sessionManager,
			);
			try {
				// A persisted conversation (a file is written once an assistant message exists).
				sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: "ask leia" }],
					attribution: "user",
					timestamp: Date.now(),
				});
				sessionManager.appendMessage(createAssistantMessage("asked"));
				await sessionManager.flush();
				const release = bridge?.replies.expect(PEER, { promised: true });
				await session.reload();
				expect(release?.()).toBe(true);
			} finally {
				await session.dispose();
			}
		});

		test("an expectation blocks only its own session's wait, though both agents are Main", async () => {
			let bridge: ExtensionAPI | undefined;
			const asker = await open([
				pi => {
					bridge = pi;
				},
			]);
			const bystander = await open([]);
			try {
				bridge?.replies.expect(PEER);
				const bystanderWait = bystander.getToolByName("wait") as AgentTool | undefined;
				const idle = (await bystanderWait?.execute("bystander", {})) as WaitResult;
				expect(text(idle)).toContain("Nothing to wait for");

				const askerWait = asker.getToolByName("wait") as AgentTool | undefined;
				const controller = new AbortController();
				const waiting = askerWait?.execute("asker", {}, controller.signal) as Promise<WaitResult>;
				expect(await stillBlocked(waiting)).toBe(true);
				expect(text(await interrupt(controller, waiting))).toBe("Wait interrupted by message.");
			} finally {
				await asker.dispose();
				await bystander.dispose();
			}
		});

		test("an advisor granted wait does not block on the primary's expectations", async () => {
			let bridge: ExtensionAPI | undefined;
			const settings = Settings.isolated({ "advisor.enabled": true });
			settings.setModelRole("advisor", "openai/gpt-4o-mini");
			// The advisor runtime builds only for a model with credentials; nothing calls the model.
			modelRegistry.authStorage.keys.setRuntime("openai", "test-key");
			const primary = await open(
				[
					pi => {
						bridge = pi;
					},
				],
				settings,
			);
			try {
				expect(primary.applyAdvisorConfigs([{ name: "Guard", tools: ["wait"] }], undefined)).toBe(1);
				const advisorWait = primary.getAdvisorAgent()?.state.tools?.find(tool => tool.name === "wait");
				if (!advisorWait) throw new Error("advisor has no wait tool");
				bridge?.replies.expect(PEER);

				// An interrupt turns a wait that would block into "Wait interrupted by message."; one with
				// nothing to wait for says so either way.
				const controller = new AbortController();
				const waiting = advisorWait.execute("advisor", {}, controller.signal) as Promise<WaitResult>;
				expect(text(await interrupt(controller, waiting))).toContain("Nothing to wait for");
			} finally {
				await primary.dispose();
			}
		});
	});
});
