import { type } from "@oh-my-pi/omptype";
import { afterEach, beforeAll, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	cfgRetryEnabled,
	cfgRetryBaseDelayMs,
	cfgRetryModelFallback,
} from "@oh-my-pi/pi-coding-agent/session/settings";
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
/**
 * Work begun while an interrupt is still unwinding (waiting for a computer-control
 * revocation, a goal hook, or the stopped run's maintenance) is later work: the
 * interrupt's cleanup must neither cancel nor reset it, one interrupt finishing
 * must not reopen another's stopped work, and the cleanup must run even when a
 * revocation throws. Reproductions from the #17856 review, all against plain
 * `session.abort({ reason: USER_INTERRUPT_LABEL })`, the Esc path.
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
	const dir = TempDir.createSync("@interrupt-unwind-");
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const registry = new ModelRegistry(auth, dir.join("models.yml"));
	const manager = SessionManager.create(dir.path(), dir.join("sessions"));
	const runtime = new ExtensionRuntime();
	let hook: (() => Promise<void>) | undefined;
	let goalHook: (() => Promise<void>) | undefined;
	const goalEvents: string[] = [];
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("before_agent_start", async () => {
				await hook?.();
			});
			pi.on("goal_updated", async event => {
				if (event.goal) goalEvents.push(event.goal.status);
				if (event.goal?.status === "paused") await goalHook?.();
			});
		},
		dir.path(),
		new EventBus(),
		runtime,
		"interrupt-unwind-probe",
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
		getToolChoice: () => session.nextToolChoiceDirective(),
		onToolChoiceUnavailable: () => session.toolChoiceQueue.reject("unavailable"),
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
	return {
		session,
		agent,
		mock,
		manager,
		registry,
		dir,
		settings,
		gate,
		holdKey,
		holdHook,
		saved,
		cancel,
		goalEvents,
		setGoalHook: (value?: () => Promise<void>) => {
			goalHook = value;
		},
	};
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
const payload = (content: string) => ({ customType: "interrupt-unwind-context", content, display: false });

async function revocation(h: Awaited<ReturnType<typeof setup>>) {
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
			throw new Error("unused");
		},
		capabilities: async () => undefined,
		close: async () => {},
	});
	return {
		ack,
		close: () => {
			ack.release();
			unregister();
			server.stop(true);
		},
	};
}
function rules() {
	const manager = new TtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 0,
	});
	manager.addRule({
		name: "unwind-token",
		path: "unwind-token.md",
		content: "Avoid UNWIND_TOKEN",
		condition: ["UNWIND_TOKEN"],
		scope: ["text"],
		_source: { provider: "test", providerName: "test", path: "unwind-token.md", level: "project" },
	});
	return manager;
}
it("a later rule continuation must survive a still-pending old HTTP revocation", async () => {
	const started = Promise.withResolvers<void>();
	const h = await setup(
		[
			async (_ctx, opts) => {
				started.resolve();
				await untilAborted(opts?.signal);
				return { content: ["old"] };
			},
			{ content: ["UNWIND_TOKEN"] },
			{ content: ["new run recovered"] },
		],
		rules(),
	);
	const control = await revocation(h);
	try {
		const old = h.session.prompt("old request");
		await started.promise;
		const stopping = h.session.abort({ reason: USER_INTERRUPT_LABEL });
		await control.ack.entered;
		await h.agent.waitForIdle();
		const injected = Promise.withResolvers<void>();
		const append = h.agent.appendMessage.bind(h.agent);
		h.agent.appendMessage = message => {
			append(message);
			if (message.role === "custom" && message.customType === "ttsr-injection") injected.resolve();
		};
		h.session.queueDeferredMessage({
			...payload("later work while old revocation waits"),
			role: "custom",
			timestamp: Date.now(),
		});
		await injected.promise;
		control.ack.release();
		await stopping;
		await old;
		await h.session.waitForIdle();

		expect(h.mock.calls).toHaveLength(3);
	} finally {
		control.close();
	}
});
it("a later retry must survive a still-pending old HTTP revocation", async () => {
	const started = Promise.withResolvers<void>();
	const h = await setup([
		async (_ctx, opts) => {
			started.resolve();
			await untilAborted(opts?.signal);
			return { content: ["old"] };
		},
		{ content: [], stopReason: "error", errorMessage: "503 Service unavailable" },
		{ content: ["new run recovered"] },
	]);
	cfgRetryEnabled.override(h.settings, true);
	cfgRetryBaseDelayMs.override(h.settings, 1);
	cfgRetryModelFallback.override(h.settings, false);
	const control = await revocation(h);
	try {
		const old = h.session.prompt("old request");
		await started.promise;
		const stopping = h.session.abort({ reason: USER_INTERRUPT_LABEL });
		await control.ack.entered;
		await h.agent.waitForIdle();
		const newEnd = Promise.withResolvers<void>();
		h.agent.subscribe(e => {
			if (e.type === "agent_end") newEnd.resolve();
		});
		h.session.queueDeferredMessage({ ...payload("later failing request"), role: "custom", timestamp: Date.now() });
		await newEnd.promise;
		await h.agent.waitForIdle();
		// A new HTTP request waits behind all already-scheduled microtasks, so maintenance can reach its retry decision.
		const barrier = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("barrier") });
		try {
			await (await fetch(barrier.url)).text();
		} finally {
			barrier.stop(true);
		}
		control.ack.release();
		await stopping;
		await old;
		await h.session.waitForIdle();

		expect(h.mock.calls).toHaveLength(3);
	} finally {
		control.close();
	}
});
it("late abort finalization cannot reject a newer tool-choice directive", async () => {
	const h = await setup([
		async () => {
			await provider.wait();
			return { content: ["later done"] };
		},
	]);
	const provider = h.gate(),
		finish = h.gate();
	const reasons: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async () => {
			await finish.wait();
			return new Response("goal cleanup complete");
		},
	});
	await h.session.goalRuntime.createGoal({ objective: "old goal" });
	h.setGoalHook(async () => {
		await (await fetch(server.url)).text();
	});
	try {
		const stopping = h.session.abort({ reason: USER_INTERRUPT_LABEL });
		await finish.entered;
		h.session.toolChoiceQueue.pushOnce("none", {
			label: "new-work",
			onRejected: info => {
				reasons.push(info.reason);
				return "drop";
			},
		});
		h.session.queueDeferredMessage({
			...payload("new work during old goal cleanup"),
			role: "custom",
			timestamp: Date.now(),
		});
		await provider.entered;
		expect(h.session.toolChoiceQueue.hasInFlight).toBe(true);
		finish.release();
		await stopping;
		const observation = {
			reasons: [...reasons],
			streaming: h.agent.state.isStreaming,
			inFlight: h.session.toolChoiceQueue.hasInFlight,
		};

		provider.release();
		await h.session.waitForIdle();
		expect(observation.reasons).toEqual([]);
	} finally {
		h.setGoalHook();
		provider.release();
		finish.release();
		server.stop(true);
	}
});

it("late abort finalization cannot erase a later setup reservation", async () => {
	const h = await setup([{ content: ["later done"] }]);
	const finish = h.gate();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async () => {
			await finish.wait();
			return new Response("goal cleanup complete");
		},
	});
	await h.session.goalRuntime.createGoal({ objective: "old goal" });
	h.setGoalHook(async () => {
		await (await fetch(server.url)).text();
	});
	try {
		const stopping = h.session.abort({ reason: USER_INTERRUPT_LABEL });
		await finish.entered;
		const key = h.holdKey();
		h.session.queueDeferredMessage({
			...payload("new setup during old goal cleanup"),
			role: "custom",
			timestamp: Date.now(),
		});
		await key.entered;
		expect(h.session.isStreaming).toBe(true);
		finish.release();
		await stopping;
		const observation = {
			streaming: h.session.isStreaming,
			agentStreaming: h.agent.state.isStreaming,
			calls: h.mock.calls.length,
		};

		key.release();
		await h.session.waitForIdle();
		expect(observation.streaming).toBe(true);
	} finally {
		h.setGoalHook();
		finish.release();
		server.stop(true);
	}
});

it("nested interrupts do not restart stopped-rule work", async () => {
	const h = await setup([{ content: ["UNWIND_TOKEN"] }, { content: ["unexpected restart"] }], rules());
	const control = await revocation(h);
	let first: Promise<void> | undefined, second: Promise<void> | undefined;
	h.session.subscribe(e => {
		if (e.type === "ttsr_triggered") {
			first = h.session.abort({ reason: USER_INTERRUPT_LABEL });
			second = h.session.abort({ reason: USER_INTERRUPT_LABEL });
		}
	});
	try {
		const run = h.session.prompt("old rule run");
		await control.ack.entered;
		control.ack.release();
		await first;
		await second;
		await run;
		await h.session.waitForIdle();

		expect(h.mock.calls).toHaveLength(1);
		expect(h.session.isTtsrAbortPending).toBe(false);
	} finally {
		control.close();
	}
});

it("throwing controller revocation does not leave a stale rule abort", async () => {
	const h = await setup([{ content: ["UNWIND_TOKEN"] }, providerAbort], rules());
	let stopping: Promise<unknown> | undefined;
	let unregister = () => {};
	h.session.subscribe(e => {
		if (e.type === "ttsr_triggered")
			queueMicrotask(() => {
				unregister = registerComputerController(h.session.getEvalKernelOwnerId(), {
					revokeControl: () => {
						throw new Error("controller failed synchronously");
					},
					run: async () => {
						throw new Error("unused");
					},
					capabilities: async () => undefined,
					close: async () => {},
				});
				stopping = h.session.abort({ reason: USER_INTERRUPT_LABEL }).catch(e => String(e));
			});
	});
	try {
		await h.session.prompt("rule then failed interrupt");
		await stopping;
		unregister();
		await h.session.waitForIdle();
		const pending = h.session.isTtsrAbortPending;
		await h.session.prompt("unrelated provider abort");
		await h.session.waitForIdle();
		const last = result(h, "throwing").at(-1)!;

		expect(pending).toBe(false);
		expect(shouldRenderAbortReason(last)).toBe(true);
	} finally {
		unregister();
	}
});

it("work queued while the stopped run's agent_end is still running starts only after the interrupt, once", async () => {
	const order: string[] = [];
	const newRun = Promise.withResolvers<void>();
	const h = await setup([
		{ content: [] },
		async () => {
			order.push("new run");
			newRun.resolve();
			return { content: ["new result"] };
		},
		{ content: ["unexpected old restart"] },
	]);
	const end = h.gate();
	const original = h.session.goalRuntime.onAgentEnd.bind(h.session.goalRuntime);
	let first = true;
	h.session.goalRuntime.onAgentEnd = async options => {
		await original(options);
		if (first) {
			first = false;
			await end.wait();
		}
	};
	try {
		const old = h.session.prompt("old empty output");
		await end.entered;
		await h.agent.waitForIdle();
		const stopping = h.session.abort({ reason: USER_INTERRUPT_LABEL });
		h.session.queueDeferredMessage({
			...payload("new work before late old maintenance"),
			role: "custom",
			timestamp: Date.now(),
		});
		// The new turn waits for the interrupt's cleanup, which waits for the stopped run's agent_end.
		for (let i = 0; i < 20; i++) {
			const tick = Promise.withResolvers<void>();
			setImmediate(tick.resolve);
			await tick.promise;
		}
		const startedDuringCleanup = order.includes("new run");
		end.release();
		await stopping;
		await old;
		// The queued work starts once the interrupt is done; waitForIdle alone can return before it claims.
		await newRun.promise;
		await h.session.waitForIdle();

		expect(startedDuringCleanup).toBe(false);
		expect(h.mock.calls).toHaveLength(2);
		expect(order).toEqual(["new run"]);
	} finally {
		h.session.goalRuntime.onAgentEnd = original;
		end.release();
	}
});

it("completing one interrupt cannot reopen another interrupt's stopped maintenance", async () => {
	const h = await setup([{ content: [] }, { content: ["unexpected resumed old work"] }]);
	const finish = h.gate(),
		end = h.gate();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async () => {
			await finish.wait();
			return new Response("paused");
		},
	});
	await h.session.goalRuntime.createGoal({ objective: "old goal" });
	h.setGoalHook(async () => {
		await (await fetch(server.url)).text();
	});
	const original = h.session.goalRuntime.onAgentEnd.bind(h.session.goalRuntime);
	let firstEnd = true;
	h.session.goalRuntime.onAgentEnd = async options => {
		await original(options);
		if (firstEnd) {
			firstEnd = false;
			await end.wait();
		}
	};
	try {
		const first = h.session.abort({ reason: USER_INTERRUPT_LABEL });
		await finish.entered;
		h.session.queueDeferredMessage({
			...payload("run to be stopped by second interrupt"),
			role: "custom",
			timestamp: Date.now(),
		});
		await end.entered;
		await h.agent.waitForIdle();
		const second = h.session.abort({ reason: USER_INTERRUPT_LABEL });
		finish.release();
		await first;
		end.release();
		await second;
		await h.session.waitForIdle();

		expect(h.mock.calls).toHaveLength(1);
	} finally {
		h.setGoalHook();
		h.session.goalRuntime.onAgentEnd = original;
		finish.release();
		end.release();
		server.stop(true);
	}
});

it("a normal 503 outside interrupt cleanup retries", async () => {
	const h = await setup([
		{ content: [], stopReason: "error", errorMessage: "503 Service unavailable" },
		{ content: ["recovered"] },
	]);
	cfgRetryEnabled.override(h.settings, true);
	cfgRetryBaseDelayMs.override(h.settings, 1);
	cfgRetryModelFallback.override(h.settings, false);
	await h.session.prompt("control");
	await h.session.waitForIdle();

	expect(h.mock.calls).toHaveLength(2);
});

it("an interrupt cannot pause a goal created while it waits for a revocation ack", async () => {
	const h = await setup([{ content: ["old done"] }]);
	const control = await revocation(h);
	try {
		const stopping = h.session.abort({ reason: USER_INTERRUPT_LABEL });
		await control.ack.entered;
		await h.session.goalRuntime.createGoal({ objective: "new goal after interrupt" });
		control.ack.release();
		await stopping;

		const after = h.session.getGoalModeState();
		expect(after?.goal.status).toBe("active");
		expect(after?.enabled).toBe(true);
	} finally {
		control.close();
	}
});

it("extensions receive the interrupt pause before a later resume, without waiting for revocation", async () => {
	const h = await setup([{ content: ["seed"] }]);
	await h.session.prompt("seed transcript");
	await h.session.goalRuntime.createGoal({ objective: "keep working" });
	h.goalEvents.length = 0;
	const control = await revocation(h);
	try {
		const stopping = h.session.abort({ reason: USER_INTERRUPT_LABEL });
		await control.ack.entered;
		for (let i = 0; i < 1000 && h.session.getGoalModeState()?.goal.status !== "paused"; i++) {
			const tick = Promise.withResolvers<void>();
			setImmediate(tick.resolve);
			await tick.promise;
		}
		expect(h.session.getGoalModeState()?.goal.status).toBe("paused");
		await h.session.goalRuntime.resumeGoal();
		const beforeAck = [...h.goalEvents];
		control.ack.release();
		await stopping;
		expect(beforeAck).toEqual(["paused", "active"]);
		expect(h.goalEvents).toEqual(["paused", "active"]);
		expect(h.session.getGoalModeState()?.goal.status).toBe("active");
	} finally {
		control.close();
	}
});

for (const initiallyPaused of [false, true]) {
	it(`an interrupt does not undo a later activation of an ${initiallyPaused ? "already paused" : "active"} goal`, async () => {
		const h = await setup(
			[
				{ content: ["seed"] },
				{ content: [{ type: "toolCall", id: "hold", name: "mcp__probe_hold", arguments: {} }] },
			],
			undefined,
			false,
		);
		const tool = h.gate();
		await h.session.refreshMCPTools([
			{
				name: "mcp__probe_hold",
				label: "hold",
				description: "Hold interrupted work until released",
				parameters: type({}),
				mcpServerName: "probe",
				mcpToolName: "hold",
				loadMode: "essential",
				execute: async () => {
					await tool.wait();
					return { content: [{ type: "text", text: "released" }] };
				},
			},
		]);
		await h.session.prompt("seed transcript");
		await h.session.goalRuntime.createGoal({ objective: "same goal, different activation" });
		if (initiallyPaused) await h.session.goalRuntime.pauseGoal();
		const old = h.session.prompt("hold unrelated work");
		await tool.entered;
		const stopping = h.session.abort({ reason: USER_INTERRUPT_LABEL });
		if (!initiallyPaused) await h.session.goalRuntime.pauseGoal();
		await h.session.goalRuntime.resumeGoal();
		const resumed = h.session.getGoalModeState();
		tool.release();
		await Promise.all([old, stopping]);
		expect(h.session.getGoalModeState()).toEqual(resumed);
		expect(h.session.getGoalModeState()?.goal.status).toBe("active");
	});
}

it("interrupting unrelated work neither accounts nor republishes an already paused goal", async () => {
	const h = await setup([
		async (_ctx, opts) => {
			await untilAborted(opts?.signal);
			return { content: ["aborted unrelated work"], usage: { input: 17, output: 3 } };
		},
	]);
	await h.session.goalRuntime.createGoal({ objective: "paused goal" });
	await h.session.goalRuntime.pauseGoal();
	const paused = h.session.getGoalModeState();
	h.goalEvents.length = 0;
	const started = Promise.withResolvers<void>();
	const unsubscribe = h.session.subscribe(event => {
		if (event.type === "agent_start") started.resolve();
	});
	try {
		const old = h.session.prompt("unrelated work");
		await started.promise;
		await h.session.abort({ reason: USER_INTERRUPT_LABEL });
		await old;
		expect(h.session.getGoalModeState()).toEqual(paused);
		expect(h.goalEvents).toEqual([]);
	} finally {
		unsubscribe();
	}
});

it("nested interrupts of one activation pause it and notify extensions once", async () => {
	const h = await setup([{ content: ["seed"] }]);
	await h.session.prompt("seed transcript");
	await h.session.goalRuntime.createGoal({ objective: "one activation" });
	h.goalEvents.length = 0;
	const first = h.session.abort({ reason: USER_INTERRUPT_LABEL });
	const second = h.session.abort({ reason: USER_INTERRUPT_LABEL });
	await Promise.all([first, second]);
	expect(h.session.getGoalModeState()?.goal.status).toBe("paused");
	expect(h.goalEvents).toEqual(["paused"]);
	const modes = (await h.saved()).filter(entry => entry.type === "mode_change" && entry.mode === "goal_paused");
	expect(modes).toHaveLength(1);
});

it("an active goal restored through the session state setter still belongs to its interrupt", async () => {
	const h = await setup([{ content: ["seed"] }]);
	await h.session.prompt("seed transcript");
	const active = await h.session.goalRuntime.createGoal({ objective: "restored activation" });
	await h.session.goalRuntime.pauseGoal();
	h.session.setGoalModeState(active);
	await h.session.abort({ reason: USER_INTERRUPT_LABEL });
	expect(h.session.getGoalModeState()?.goal.status).toBe("paused");
});

it("a goal notification can resume the goal without waiting on its own ordered emission", async () => {
	const h = await setup([{ content: ["seed"] }]);
	await h.session.prompt("seed transcript");
	await h.session.goalRuntime.createGoal({ objective: "resume from notification" });
	h.goalEvents.length = 0;
	const active = Promise.withResolvers<void>();
	const unsubscribe = h.session.subscribe(event => {
		if (event.type === "goal_updated" && event.goal?.status === "active") active.resolve();
	});
	h.setGoalHook(async () => {
		await h.session.goalRuntime.resumeGoal();
	});
	try {
		await Promise.all([h.session.abort({ reason: USER_INTERRUPT_LABEL }), active.promise]);
		expect(h.goalEvents).toEqual(["paused", "active"]);
		expect(h.session.getGoalModeState()?.goal.status).toBe("active");
	} finally {
		h.setGoalHook();
		unsubscribe();
	}
});

it("a failed pause persistence still releases its committed notification and rethrows the first failure", async () => {
	const h = await setup([{ content: ["seed"] }, { content: ["next"] }]);
	await h.session.prompt("seed transcript");
	await h.session.goalRuntime.createGoal({ objective: "pause despite failed persistence" });
	h.goalEvents.length = 0;
	const original = h.manager.appendModeChange.bind(h.manager);
	const failed = new Error("pause persistence failed");
	h.manager.appendModeChange = (...args) => {
		const result = original(...args);
		if (args[0] === "goal_paused") throw failed;
		return result;
	};
	try {
		await expect(h.session.abort({ reason: USER_INTERRUPT_LABEL })).rejects.toBe(failed);
		expect(h.goalEvents).toEqual(["paused"]);
		await h.session.prompt("a failed cleanup must not keep admission closed");
		expect(h.mock.calls).toHaveLength(2);
	} finally {
		h.manager.appendModeChange = original;
	}
});

for (const throws of [false, true]) {
	it(`a withdrawn message survives an interrupt whose directive rejection ${throws ? "throws" : "succeeds"}`, async () => {
		const h = await setup([{ content: ["seed done"] }, { content: ["next done"] }]);
		await h.session.prompt("seed transcript before queue interruption");
		h.session.toolChoiceQueue.pushOnce("none", {
			label: "application directive",
			onRejected: () => {
				if (throws) throw new Error("application rejection callback failed");
				return "drop";
			},
		});
		h.session.toolChoiceQueue.nextToolChoice();
		h.agent.followUp({
			role: "custom",
			customType: "must-preserve",
			content: "IMPORTANT_WITHDRAWN_MESSAGE",
			display: true,
			timestamp: Date.now(),
		});
		h.session.clearQueue({ forInterrupt: true });
		const stopping = h.session.abort({ reason: USER_INTERRUPT_LABEL });
		if (throws) await expect(stopping).rejects.toThrow("application rejection callback failed");
		else await stopping;
		expect(JSON.stringify(await h.saved())).toContain("IMPORTANT_WITHDRAWN_MESSAGE");

		await h.session.prompt("next user request");
		expect(JSON.stringify(h.mock.calls.at(-1)?.context.messages)).toContain("IMPORTANT_WITHDRAWN_MESSAGE");
	});
}
