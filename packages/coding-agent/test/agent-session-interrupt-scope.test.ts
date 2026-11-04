import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel, type MockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { registerComputerController } from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { shouldRenderAbortReason } from "@oh-my-pi/pi-tui/chat/messages";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * An interrupt cancels exactly the work it stops: the user-interrupt mark lands
 * only on the run it stopped, a prompt waiting behind another run or overtaken
 * by disposal never starts, accepted next-turn messages are never lost when a
 * prompt is dropped before dispatch, and a cancelled rule continuation leaves no
 * flag that would hide a later, unrelated provider abort.
 */
const resources: Array<{ session: AgentSession; auth: AuthStorage; dir: TempDir; releases: (() => void)[] }> = [];
beforeAll(async () => {
	setThemeInstance((await getThemeByName("dark"))!);
});
afterEach(async () => {
	for (const h of resources.splice(0)) {
		h.releases.forEach(r => r());
		await h.session.dispose();
		h.auth.close();
		await h.dir.remove();
	}
});
async function setup(responses: MockResponseSource, ttsrManager?: TtsrManager, withRunner = true) {
	const dir = TempDir.createSync("@interrupt-scope-");
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const registry = new ModelRegistry(auth, dir.join("models.yml"));
	const manager = SessionManager.create(dir.path(), dir.join("sessions"));
	const runtime = new ExtensionRuntime();
	let hook: (() => Promise<void>) | undefined;
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("before_agent_start", async () => {
				await hook?.();
			});
		},
		dir.path(),
		new EventBus(),
		runtime,
		"interrupt-scope-probe",
	);
	const runner = new ExtensionRunner([extension], runtime, dir.path(), manager, registry);
	const mock = createMockModel({ responses, handler: { content: ["done"] } });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"ask.notify": "off",
		"speech.enabled": false,
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		convertToLlm,
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		extensionRunner: withRunner ? runner : undefined,
		toolRegistry: new Map(),
		ttsrManager,
	});
	const releases: (() => void)[] = [];
	resources.push({ session, auth, dir, releases });
	function gate() {
		const entered = Promise.withResolvers<void>(),
			released = Promise.withResolvers<void>();
		releases.push(() => released.resolve());
		return {
			entered: entered.promise,
			release: () => released.resolve(),
			wait: async () => {
				entered.resolve();
				await released.promise;
			},
		};
	}
	function holdKey() {
		const g = gate(),
			orig = registry.getApiKey.bind(registry);
		registry.getApiKey = async (...args) => {
			registry.getApiKey = orig;
			await g.wait();
			return orig(...args);
		};
		return g;
	}
	function holdHook() {
		const g = gate();
		hook = async () => {
			hook = undefined;
			await g.wait();
		};
		return g;
	}
	async function saved() {
		await session.settleInFlightMessagePersistence();
		await manager.flush();
		return (await Bun.file(manager.getSessionFile()!).text())
			.trim()
			.split("\n")
			.map(l => JSON.parse(l));
	}
	function cancel() {
		session.buildAskReanswerContext({} as never).abort();
	}
	return { session, agent, mock, manager, registry, dir, settings, gate, holdKey, holdHook, saved, cancel };
}
const providerAbort = {
	content: ["provider partial"],
	stopReason: "aborted" as const,
	errorMessage: "transport closed independently",
};
function result(h: { session: AgentSession; mock: MockModel }, _name: string) {
	const aborted = h.session.messages.filter(
		(m): m is AssistantMessage => m.role === "assistant" && m.stopReason === "aborted",
	);
	return aborted;
}
async function untilAborted(signal?: AbortSignal) {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (signal?.aborted) resolve();
	else signal?.addEventListener("abort", () => resolve(), { once: true });
	await promise;
}
const payload = (content: string) => ({ customType: "interrupt-scope-context", content, display: false });

describe("interrupt scope", () => {
	it("midstream interrupt keeps its own mark but not the next explicit turn", async () => {
		const started = Promise.withResolvers<void>();
		const h = await setup([
			async (_ctx, opts) => {
				started.resolve();
				await untilAborted(opts?.signal);
				return { content: ["partial"] };
			},
			providerAbort,
		]);
		const run = h.session.prompt("first");
		await started.promise;
		h.cancel();
		await run;
		await h.session.waitForIdle();
		expect(AIError.is(result(h, "midstream")[0]!.errorId, AIError.Flag.UserInterrupt)).toBe(true);
		await h.session.prompt("second");
		await h.session.waitForIdle();
		const last = result(h, "midstream-next").at(-1)!;
		expect(AIError.is(last.errorId, AIError.Flag.UserInterrupt)).toBe(false);
		expect(shouldRenderAbortReason(last)).toBe(true);
	});
	for (const next of ["explicit", "custom", "steer"] as const)
		it(`setup interruption does not mark later ${next} provider abort`, async () => {
			const h = await setup([providerAbort]);
			const key = h.holdKey();
			const dropped: string[] = [];
			h.session.setPromptDropped(p => dropped.push(p.text));
			const first = h.session.prompt("cancel during setup");
			await key.entered;
			expect(h.session.isStreaming).toBe(true);
			expect(h.agent.state.isStreaming).toBe(false);
			h.cancel();
			key.release();
			await first;
			await h.session.waitForIdle();
			expect(h.mock.calls).toHaveLength(0);
			expect(dropped).toEqual(["cancel during setup"]);
			if (next === "explicit") await h.session.prompt("independent next request");
			else if (next === "custom")
				await h.session.sendCustomMessage(payload("independent trigger"), { triggerTurn: true });
			else await h.session.sendUserMessage("independent steer", { deliverAs: "steer" });
			await h.session.waitForIdle();
			const last = result(h, `setup-${next}`).at(-1)!;
			expect(last).toBeDefined();
			expect(AIError.is(last.errorId, AIError.Flag.UserInterrupt)).toBe(false);
			expect(shouldRenderAbortReason(last)).toBe(true);
		});
	it("queued-only interrupt does not mark a later custom turn", async () => {
		const h = await setup([providerAbort]);
		h.agent.followUp({ role: "user", content: "parked", timestamp: Date.now() });
		h.cancel();
		await h.session.waitForIdle();
		expect(h.agent.peekFollowUpQueue()).toHaveLength(1);
		await h.session.sendCustomMessage(payload("new trigger"), { triggerTurn: true });
		await h.session.waitForIdle();
		const last = result(h, "queued-only")[0]!;
		expect(AIError.is(last.errorId, AIError.Flag.UserInterrupt)).toBe(false);
	});
	for (const reason of ["stop", "aborted"] as const)
		it(`interrupt at ${reason} message_end does not stain next custom turn`, async () => {
			const h = await setup([
				{ content: ["first"], stopReason: reason, errorMessage: reason === "aborted" ? "first transport" : "" },
				providerAbort,
			]);
			let once = false;
			h.agent.subscribe(e => {
				if (!once && e.type === "message_end" && e.message.role === "assistant") {
					once = true;
					h.cancel();
				}
			});
			await h.session.prompt("first");
			await h.session.waitForIdle();
			await h.session.sendCustomMessage(payload("next trigger"), { triggerTurn: true });
			await h.session.waitForIdle();
			const last = result(h, `message-end-${reason}`).at(-1)!;
			expect(AIError.is(last.errorId, AIError.Flag.UserInterrupt)).toBe(false);
		});
	it("plan-internal precedence does not leak user mark into next custom turn", async () => {
		const started = Promise.withResolvers<void>();
		const h = await setup([
			async (_ctx, opts) => {
				started.resolve();
				await untilAborted(opts?.signal);
				return { content: ["partial"] };
			},
			providerAbort,
		]);
		const run = h.session.prompt("first");
		await started.promise;
		h.session.markPlanInternalAbortPending();
		h.cancel();
		await run;
		await h.session.waitForIdle();
		expect(AIError.is(result(h, "plan-internal")[0]!.errorId, AIError.Flag.SilentAbort)).toBe(true);
		await h.session.sendCustomMessage(payload("next trigger"), { triggerTurn: true });
		await h.session.waitForIdle();
		const last = result(h, "plan-next").at(-1)!;
		expect(AIError.is(last.errorId, AIError.Flag.UserInterrupt)).toBe(false);
	});
	it("late setup interruption restores all scheduled hidden messages once", async () => {
		const h = await setup([]);
		const firstKey = h.holdKey();
		const hook = h.holdHook();
		h.session.queueDeferredMessage({ ...payload("snapshot-A"), role: "custom", timestamp: Date.now() });
		await firstKey.entered;
		await h.session.sendCustomMessage(payload("arriving-B"), { deliverAs: "nextTurn", triggerTurn: false });
		firstKey.release();
		await hook.entered;
		h.cancel();
		hook.release();
		await h.session.waitForIdle();
		expect(h.mock.calls).toHaveLength(0);
		await h.session.prompt("resume");
		await h.session.waitForIdle();
		const saved = await h.saved();
		const contents = saved.filter(e => e.type === "custom_message").map(e => e.content);

		expect(contents.filter(c => c === "snapshot-A")).toHaveLength(1);
		expect(contents.filter(c => c === "arriving-B")).toHaveLength(1);
	});
	it("normal prompt interruption after consuming deferred context preserves it", async () => {
		const h = await setup([]);
		const key = h.holdKey(),
			hook = h.holdHook();
		const first = h.session.prompt("first");
		await key.entered;
		await h.session.sendCustomMessage(payload("pending-C"), { deliverAs: "nextTurn", triggerTurn: false });
		key.release();
		await hook.entered;
		h.cancel();
		hook.release();
		await first;
		await h.session.waitForIdle();
		await h.session.prompt("resume");
		await h.session.waitForIdle();
		const saved = await h.saved();

		expect(JSON.stringify(saved)).toContain("pending-C");
		expect(JSON.stringify(h.mock.calls.map(c => c.context.messages))).toContain("pending-C");
	});
	it("restored scheduled messages neither duplicate nor restart until a later prompt", async () => {
		const h = await setup([]);
		const key = h.holdKey();
		h.session.queueDeferredMessage({ ...payload("deferred-once"), role: "custom", timestamp: Date.now() });
		await key.entered;
		h.cancel();
		key.release();
		await h.session.waitForIdle();
		expect(h.mock.calls).toHaveLength(0);
		await h.session.prompt("resume");
		await h.session.waitForIdle();
		await h.session.prompt("again");
		await h.session.waitForIdle();
		const contents = (await h.saved()).filter(e => e.type === "custom_message").map(e => e.content);
		expect(h.mock.calls).toHaveLength(2);
		expect(contents.filter(c => c === "deferred-once")).toHaveLength(1);
	});
	it("disposal prevents restored scheduled messages from dispatching", async () => {
		const h = await setup([]);
		const key = h.holdKey();
		h.session.queueDeferredMessage({ ...payload("dispose-context"), role: "custom", timestamp: Date.now() });
		await key.entered;
		const disposed = h.session.dispose();
		key.release();
		await disposed;
		expect(h.mock.calls).toHaveLength(0);
		expect(h.session.messages).toHaveLength(0);
	});
	it("interrupt while waiting does not dispatch the reserved prompt", async () => {
		const started = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const h = await setup([
			async () => {
				started.resolve();
				await release.promise;
				return { content: ["autonomous done"] };
			},
			{ content: ["should not run"] },
		]);
		const hook = h.holdKey();
		const dropped: string[] = [];
		h.session.setPromptDropped(p => dropped.push(p.text));
		const first = h.session.prompt("waiting client");
		await hook.entered;
		// A core run claims the loop during the client setup. Both are real runs, not a mocked AgentBusyError.
		const autonomous = h.agent.prompt("autonomous");
		await started.promise;
		const waiting = Promise.withResolvers<void>();
		const idle = h.agent.waitForIdle.bind(h.agent);
		h.agent.waitForIdle = () => {
			waiting.resolve();
			return idle();
		};
		hook.release();
		await waiting.promise;
		h.cancel();
		release.resolve();
		await autonomous;
		await first;
		await h.session.waitForIdle();

		expect(h.mock.calls).toHaveLength(1);
		expect(dropped).toEqual(["waiting client"]);
	});
});

describe("interrupt scope: scheduled and rule turns", () => {
	it("public scheduled hidden prompt does not restart after an interrupt during busy-retry", async () => {
		const started = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const h = await setup([
			async () => {
				started.resolve();
				await release.promise;
				return { content: ["autonomous"] };
			},
			{ content: ["unexpected hidden turn"] },
		]);
		const run = h.session.sendCustomMessage(payload("autonomous"), { triggerTurn: true });
		await started.promise;
		const waiting = Promise.withResolvers<void>();
		const idle = h.agent.waitForIdle.bind(h.agent);
		h.agent.waitForIdle = () => {
			waiting.resolve();
			return idle();
		};
		h.session.queueDeferredMessage({ ...payload("waiting hidden context"), role: "custom", timestamp: Date.now() });
		await waiting.promise;
		h.cancel();
		release.resolve();
		await run;
		await h.session.waitForIdle();

		expect(h.mock.calls).toHaveLength(1);
	});
	it("a later hidden dispatch attempt cannot clear the stopped run mark", async () => {
		const started = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const h = await setup([
			async () => {
				started.resolve();
				await release.promise;
				return { content: ["interrupted run"] };
			},
			{ content: ["next run"] },
		]);
		const run = h.session.prompt("first");
		await started.promise;
		h.cancel();
		const waiting = Promise.withResolvers<void>();
		const idle = h.agent.waitForIdle.bind(h.agent);
		h.agent.waitForIdle = () => {
			waiting.resolve();
			return idle();
		};
		h.session.queueDeferredMessage({ ...payload("later hidden"), role: "custom", timestamp: Date.now() });
		await waiting.promise;
		release.resolve();
		await run;
		await h.session.waitForIdle();
		const old = result(h, "mark-cleared-before-old-end")[0]!;
		expect(AIError.is(old.errorId, AIError.Flag.UserInterrupt)).toBe(true);
	});
	it("false return after disposal at preparation does not deliver restored context", async () => {
		const h = await setup([]);
		const hook = h.holdHook();
		h.session.queueDeferredMessage({ ...payload("restore-on-dispose"), role: "custom", timestamp: Date.now() });
		await hook.entered;
		const disposing = h.session.dispose();
		hook.release();
		await disposing;
		expect(h.mock.calls).toHaveLength(0);
	});
	it("custom prompt false return preserves its deferred companions", async () => {
		const h = await setup([]);
		const key = h.holdKey(),
			hook = h.holdHook();
		const p = h.session.promptCustomMessage({ ...payload("skill prompt"), attribution: "user" });
		await key.entered;
		await h.session.sendCustomMessage(payload("custom-pending-D"), { deliverAs: "nextTurn", triggerTurn: false });
		key.release();
		await hook.entered;
		h.cancel();
		hook.release();
		expect(await p).toBe(false);
		await h.session.waitForIdle();
		await h.session.prompt("resume");
		await h.session.waitForIdle();
		const entries = await h.saved();
		expect(JSON.stringify(entries)).toContain("custom-pending-D");
	});
	it("TTSR interruption is silent and does not mark its later provider failure", async () => {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 0,
		});
		manager.addRule({
			name: "forbidden-token",
			path: "forbidden-token.md",
			content: "Avoid FORBIDDEN_TOKEN",
			condition: ["FORBIDDEN_TOKEN"],
			scope: ["text"],
			_source: { provider: "test", providerName: "test", path: "forbidden-token.md", level: "project" },
		});
		const h = await setup([{ content: ["FORBIDDEN_TOKEN"] }, providerAbort], manager);
		const aborted: AssistantMessage[] = [];
		h.agent.subscribe(e => {
			if (e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason === "aborted")
				aborted.push(e.message);
		});
		await h.session.prompt("trigger rule");
		await h.session.waitForIdle();

		expect(aborted.length).toBeGreaterThanOrEqual(2);
		expect(AIError.is(aborted[0]!.errorId, AIError.Flag.SilentAbort)).toBe(true);
		expect(shouldRenderAbortReason(aborted.at(-1)!)).toBe(true);
	});
});

describe("interrupt scope: races with the stopped run", () => {
	it("user interrupt during TTSR cleanup cannot hide the next provider abort", async () => {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 0,
		});
		manager.addRule({
			name: "race-token",
			path: "race-token.md",
			content: "Avoid RACE_TOKEN",
			condition: ["RACE_TOKEN"],
			scope: ["text"],
			_source: { provider: "test", providerName: "test", path: "race-token.md", level: "project" },
		});
		const h = await setup([{ content: ["RACE_TOKEN"] }, providerAbort], manager);
		let cancelled = false;
		h.session.subscribe(e => {
			if (e.type === "ttsr_triggered" && !cancelled) {
				cancelled = true;
				h.cancel();
			}
		});
		await h.session.prompt("trigger and cancel");
		await h.session.waitForIdle();

		await h.session.prompt("independent request");
		await h.session.waitForIdle();
		const last = result(h, "ttsr-user-next").at(-1)!;
		expect(shouldRenderAbortReason(last)).toBe(true);
		expect(h.session.isTtsrAbortPending).toBe(false);
	});
	it("dispatch behind an interrupted tool does not erase the old run mark", async () => {
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const h = await setup(
			[
				{ content: [{ type: "toolCall", id: "stop", name: "mcp__probe_hold", arguments: {} }] },
				{ content: ["done"] },
			],
			undefined,
			false,
		);
		await h.session.refreshMCPTools([
			{
				name: "mcp__probe_hold",
				label: "hold",
				description: "hold interrupted tool",
				parameters: type({}),
				mcpServerName: "probe",
				mcpToolName: "hold",
				loadMode: "essential",
				execute: async (_id, _params, _update, ctx) => {
					ctx.abort();
					entered.resolve();
					await release.promise;
					return { content: [{ type: "text", text: "finished tool" }] };
				},
			},
		]);

		const run = h.session.prompt("run tool");
		await Promise.race([
			entered.promise,
			run.then(() => {
				throw new Error(`tool never entered: ${JSON.stringify(h.session.messages)}`);
			}),
		]);
		let attempted = false;
		const prompt = h.agent.prompt.bind(h.agent) as (...args: unknown[]) => Promise<void>;
		h.agent.prompt = ((...args: unknown[]) => {
			attempted = true;
			return prompt(...args);
		}) as typeof h.agent.prompt;
		h.session.queueDeferredMessage({ ...payload("late dispatch"), role: "custom", timestamp: Date.now() });
		// The late dispatch waits for the interrupt's cleanup, which waits for the interrupted tool.
		for (let i = 0; i < 20; i++) {
			const tick = Promise.withResolvers<void>();
			setImmediate(tick.resolve);
			await tick.promise;
		}
		expect(attempted).toBe(false);
		release.resolve();
		await run;
		await h.session.waitForIdle();
		const old = result(h, "old-tool-mark")[0]!;
		expect(AIError.is(old.errorId, AIError.Flag.UserInterrupt)).toBe(true);
	});
	it("a scheduled hidden turn cannot begin its provider call after beginDispose", async () => {
		let disposedAtCall = false;
		const target: { session?: AgentSession } = {};
		const h = await setup([
			() => {
				disposedAtCall = target.session?.isDisposed === true;
				return { content: ["unexpected late call"] };
			},
		]);
		target.session = h.session;
		const key = h.holdKey();
		h.session.queueDeferredMessage({ ...payload("disposed hidden"), role: "custom", timestamp: Date.now() });
		await key.entered;
		const disposing = h.session.dispose();
		key.release();
		await disposing;
		expect(disposedAtCall).toBe(false);
		expect(h.mock.calls).toHaveLength(0);
	});

	// A turn that starts while an interrupt is still cleaning up (here, waiting for a computer-control
	// revocation acknowledgement over HTTP) is later work: the old cleanup must not cancel its rule continuation.
	for (const timing of ["during", "after"] as const) {
		it(`a rule continuation of a turn begun ${timing} an interrupt's cleanup still runs`, async () => {
			const manager = new TtsrManager({
				enabled: true,
				contextMode: "discard",
				interruptMode: "always",
				repeatMode: "once",
				repeatGap: 0,
			});
			manager.addRule({
				name: "later-revocation-rule",
				path: "later-revocation-rule.md",
				content: "Avoid LATER_REVOCATION_TOKEN",
				condition: ["LATER_REVOCATION_TOKEN"],
				scope: ["text"],
				_source: { provider: "test", providerName: "test", path: "later-revocation-rule.md", level: "project" },
			});
			const started = Promise.withResolvers<void>();
			const h = await setup(
				[
					async (_ctx, opts) => {
						started.resolve();
						await untilAborted(opts?.signal);
						return { content: ["old"] };
					},
					{ content: ["LATER_REVOCATION_TOKEN"] },
					{ content: ["recovered later run"] },
				],
				manager,
			);
			const ack = h.gate();
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: async () => {
					await ack.wait();
					return new Response("revoked");
				},
			});
			const unregister = registerComputerController(h.session.getEvalKernelOwnerId(), {
				revokeControl: async () => {
					await (await fetch(server.url)).text();
				},
				run: async () => {
					throw new Error("not part of this test");
				},
				capabilities: async () => undefined,
				close: async () => {},
			});
			try {
				const old = h.session.prompt("old request");
				await started.promise;
				const stopping = h.session.abort({ reason: USER_INTERRUPT_LABEL });
				await ack.entered;
				await h.agent.waitForIdle();
				if (timing === "after") {
					ack.release();
					await stopping;
					await old;
				}
				const triggered = Promise.withResolvers<void>();
				h.session.subscribe(event => {
					if (event.type === "ttsr_triggered") {
						triggered.resolve();
						ack.release();
					}
				});
				h.session.queueDeferredMessage({
					...payload("new work during revocation acknowledgement"),
					role: "custom",
					timestamp: Date.now(),
				});
				await triggered.promise;
				await stopping;
				await old;
				await h.session.waitForIdle();
				const injections = (await h.saved()).filter(
					entry => entry.type === "custom_message" && entry.customType === "ttsr-injection",
				);
				expect(injections).toHaveLength(1);
				expect(h.mock.calls).toHaveLength(3);
				expect(h.session.isTtsrAbortPending).toBe(false);
			} finally {
				ack.release();
				unregister();
				server.stop(true);
			}
		});
	}

	// A prompt waiting behind another run commits what it delivers only at its claim: cancelled
	// while it waits, it leaves the approved plan to be delivered by the next prompt.
	for (const stop of [false, true]) {
		it(`a prompt ${stop ? "cancelled" : "dispatched"} after waiting behind another run delivers the approved plan once`, async () => {
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const h = await setup([
				async () => {
					started.resolve();
					await release.promise;
					return { content: ["autonomous done"] };
				},
			]);
			const planUrl = "local://approved-plan.md";
			const planPath = resolveLocalUrlToPath(planUrl, {
				getArtifactsDir: () => h.manager.getArtifactsDir(),
				getSessionId: () => h.manager.getSessionId(),
			});
			await Bun.write(planPath, "# Approved plan\n\nAPPROVED-PLAN-CONTENT\n");
			h.session.setPlanReferencePath(planUrl);
			const hook = h.holdKey();
			const dropped: string[] = [];
			h.session.setPromptDropped(prompt => dropped.push(prompt.text));
			const waitingClient = h.session.prompt("execute the approved plan");
			await hook.entered;
			const autonomous = h.agent.prompt("older autonomous task");
			await started.promise;
			const waiting = Promise.withResolvers<void>();
			const waitForIdle = h.agent.waitForIdle.bind(h.agent);
			h.agent.waitForIdle = () => {
				waiting.resolve();
				return waitForIdle();
			};
			hook.release();
			await waiting.promise;
			const stopping = stop ? h.session.abort({ reason: USER_INTERRUPT_LABEL }) : Promise.resolve();
			release.resolve();
			await Promise.all([autonomous, waitingClient, stopping]);
			await h.session.waitForIdle();
			expect(dropped).toEqual(stop ? ["execute the approved plan"] : []);

			await h.session.prompt("continue executing the approved plan");
			await h.session.waitForIdle();
			const planReferences = h.session.messages.filter(
				message => message.role === "custom" && message.customType === "plan-mode-reference",
			);
			expect(planReferences).toHaveLength(1);
			expect(JSON.stringify(h.mock.calls.at(-1)!.context.messages)).toContain("APPROVED-PLAN-CONTENT");
		});
	}
});
