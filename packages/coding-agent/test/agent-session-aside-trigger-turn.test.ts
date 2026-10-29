import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TurnRecovery } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * An extension aside sent with `triggerTurn` that no running turn consumes still gets a turn,
 * also while an interrupt that stopped something keeps auto-resume suppressed and in plan mode,
 * unless a user interrupt happened after it was sent. `agent_end` is tagged non-terminal only
 * when a stranded aside will start a turn.
 */
describe("AgentSession triggerTurn aside", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-aside-trigger-turn-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
		AsyncJobManager.resetForTests();
	});

	interface Harness {
		session: AgentSession;
		mock: MockModel;
		modelRegistry: ModelRegistry;
		/** `isTerminal` of every `agent_end` the session published, in order. */
		agentEnds: Array<boolean | undefined>;
	}

	/**
	 * `onSessionStop` runs while the finished run still holds the session: after the loop's last aside poll, before it settles.
	 * `responses` answer the first model requests; later ones answer "Acknowledged.".
	 */
	async function createHarness(onSessionStop?: () => Promise<void>, responses?: MockResponse[]): Promise<Harness> {
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses,
			handler: { content: ["Acknowledged."] },
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"retry.enabled": false,
		});
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		let extensionRunner: ExtensionRunner | undefined;
		if (onSessionStop) {
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("session_stop", async () => {
						await onSessionStop();
					});
				},
				tempDir.path(),
				new EventBus(),
				runtime,
				"aside-at-session-stop",
			);
			extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		}
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			extensionRunner,
		});
		const agentEnds: Array<boolean | undefined> = [];
		session.subscribe(event => {
			if (event.type === "agent_end") agentEnds.push(event.isTerminal);
		});
		return { session, mock, modelRegistry, agentEnds };
	}

	function card(content: string) {
		return { customType: "ext-card", content, display: false, attribution: "agent" as const };
	}

	/** Waits until no run and no prompt setup or wake turn holds the session. */
	async function settle(target: AgentSession): Promise<void> {
		do {
			await target.waitForIdle();
			await setImmediate();
		} while (target.isStreaming);
	}

	function requestsContaining(mock: MockModel, text: string): number {
		return mock.calls.filter(call => JSON.stringify(call.context.messages).includes(text)).length;
	}

	function persisted(target: AgentSession, text: string): boolean {
		return target.agent.state.messages.some(message => message.role === "custom" && message.content === text);
	}

	interface HeldKeyLookup {
		/** Settles when the held lookup starts. */
		requested: Promise<void>;
		resolve(key: string | undefined): void;
		restore(): void;
	}

	/** Holds the next API-key lookup, which a direct prompt's setup makes before its run starts. */
	function holdNextKeyLookup(modelRegistry: ModelRegistry): HeldKeyLookup {
		const requested = Promise.withResolvers<void>();
		const key = Promise.withResolvers<string | undefined>();
		const spy = spyOn(modelRegistry, "getApiKey").mockImplementationOnce(async () => {
			requested.resolve();
			return key.promise;
		});
		return { requested: requested.promise, resolve: key.resolve, restore: () => spy.mockRestore() };
	}

	/**
	 * An Esc that stops something, which is what latches auto-resume suppression: here a
	 * prompt still in setup. An idle Esc stops no run and no queued work, so it suppresses
	 * nothing, and background work keeps waking the session on its own.
	 */
	async function interruptPromptInSetup(target: AgentSession, modelRegistry: ModelRegistry): Promise<void> {
		const keyLookup = holdNextKeyLookup(modelRegistry);
		try {
			const dropped = target.prompt("SETUP_INTERRUPTED", { synthetic: true });
			await keyLookup.requested;
			await target.abort({ reason: USER_INTERRUPT_LABEL });
			keyLookup.resolve("openai-test-key");
			await dropped;
		} finally {
			keyLookup.restore();
		}
	}

	it("gets a turn when the prompt it was sent during is refused before its run", async () => {
		const { session, mock, modelRegistry } = await createHarness();
		// An interrupt whose suppression is still live; the aside is sent after it.
		await interruptPromptInSetup(session, modelRegistry);
		const keyLookup = holdNextKeyLookup(modelRegistry);
		try {
			const refused = session.prompt("SYNTHETIC_SETUP", { synthetic: true });
			await keyLookup.requested;
			expect(session.isStreaming).toBe(true);

			expect(
				await session.sendCustomMessage(card("CARD_DURING_SETUP"), { deliverAs: "aside", triggerTurn: true }),
			).toBe(false);
			keyLookup.resolve(undefined);
			await expect(refused).rejects.toThrow("No API key");
			await settle(session);
		} finally {
			keyLookup.restore();
		}

		expect(mock.calls).toHaveLength(1);
		expect(requestsContaining(mock, "CARD_DURING_SETUP")).toBe(1);
	});

	it("folds without a turn when an Esc lands in the same setup window", async () => {
		const { session, mock, modelRegistry } = await createHarness();
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		const keyLookup = holdNextKeyLookup(modelRegistry);
		try {
			const dropped = session.prompt("SYNTHETIC_SETUP", { synthetic: true });
			await keyLookup.requested;
			await session.sendCustomMessage(card("CARD_BEFORE_ESC"), { deliverAs: "aside", triggerTurn: true });

			await session.abort({ reason: USER_INTERRUPT_LABEL });
			keyLookup.resolve("openai-test-key");
			await dropped;
			await settle(session);
		} finally {
			keyLookup.restore();
		}

		expect(mock.calls).toHaveLength(0);
		expect(persisted(session, "CARD_BEFORE_ESC")).toBe(true);
	});

	it("gets a turn when it lands after a run's last aside poll, and that run's agent_end says so", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_AFTER_POLL"), { deliverAs: "aside", triggerTurn: true });
		});
		const { session, mock, agentEnds, modelRegistry } = harness;
		await interruptPromptInSetup(session, modelRegistry);

		// An extension turn runs with the earlier interrupt's suppression still in effect.
		expect(await session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true })).toBe(true);
		await settle(session);

		expect(mock.calls).toHaveLength(2);
		expect(requestsContaining(mock, "CARD_AFTER_POLL")).toBe(1);
		expect(JSON.stringify(mock.calls[1]!.context.messages)).toContain("CARD_AFTER_POLL");
		expect(agentEnds).toEqual([false, true]);
	});

	it("in plan mode, an aside without triggerTurn stranded after a run's last aside poll folds, and that run's agent_end is terminal", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("PASSIVE_AFTER_POLL"), { deliverAs: "aside" });
		});
		const { session, mock, agentEnds } = harness;
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });

		await session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
		await settle(session);

		expect(mock.calls).toHaveLength(1);
		expect(persisted(session, "PASSIVE_AFTER_POLL")).toBe(true);
		expect(agentEnds).toEqual([true]);
	});

	it("at idle under an interrupt's suppression, triggerTurn decides between a turn and a fold", async () => {
		const { session, mock, modelRegistry } = await createHarness();
		await interruptPromptInSetup(session, modelRegistry);

		expect(await session.sendCustomMessage(card("IDLE_PASSIVE"), { deliverAs: "aside" })).toBe(false);
		await settle(session);
		expect(mock.calls).toHaveLength(0);
		expect(persisted(session, "IDLE_PASSIVE")).toBe(true);

		expect(await session.sendCustomMessage(card("IDLE_TRIGGER"), { deliverAs: "aside", triggerTurn: true })).toBe(
			true,
		);
		await settle(session);
		expect(mock.calls).toHaveLength(1);
		expect(requestsContaining(mock, "IDLE_TRIGGER")).toBe(1);
	});

	it("in plan mode, triggerTurn starts a turn at idle like a steer does; without it the aside folds", async () => {
		const { session, mock } = await createHarness();
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });

		expect(await session.sendCustomMessage(card("PLAN_PASSIVE"), { deliverAs: "aside" })).toBe(false);
		await settle(session);
		expect(mock.calls).toHaveLength(0);
		expect(persisted(session, "PLAN_PASSIVE")).toBe(true);

		expect(await session.sendCustomMessage(card("PLAN_TRIGGER"), { deliverAs: "aside", triggerTurn: true })).toBe(
			true,
		);
		await settle(session);
		expect(mock.calls).toHaveLength(1);
		expect(requestsContaining(mock, "PLAN_TRIGGER")).toBe(1);
	});

	it("in plan mode, a triggerTurn aside stranded after a run's last aside poll gets a turn and a non-terminal agent_end", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("PLAN_AFTER_POLL"), { deliverAs: "aside", triggerTurn: true });
		});
		const { session, mock, agentEnds } = harness;
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });

		await session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
		await settle(session);

		expect(mock.calls).toHaveLength(2);
		expect(JSON.stringify(mock.calls[1]!.context.messages)).toContain("PLAN_AFTER_POLL");
		expect(agentEnds).toEqual([false, true]);
	});

	it("of two sent at once to an idle session after an interrupt, the queued one gets a turn when the first run ends before its aside poll", async () => {
		// The first run fails, so its loop ends without the stop-boundary aside poll that would take the queued aside.
		const { session, mock, modelRegistry } = await createHarness(undefined, [
			{ stopReason: "error", errorMessage: "400 bad request" },
		]);
		await interruptPromptInSetup(session, modelRegistry);

		await Promise.all([
			session.sendCustomMessage(card("FIRST_CARD"), { deliverAs: "aside", triggerTurn: true }),
			session.sendCustomMessage(card("SECOND_CARD"), { deliverAs: "aside", triggerTurn: true }),
		]);
		await settle(session);

		expect(mock.calls).toHaveLength(2);
		expect(requestsContaining(mock, "FIRST_CARD")).toBeGreaterThan(0);
		expect(requestsContaining(mock, "SECOND_CARD")).toBeGreaterThan(0);
	});

	/** Strands a triggerTurn aside and then an aside without it after the extension turn's last aside poll. */
	async function expectStrandedAsidesInQueueOrder(
		setup: (target: AgentSession, modelRegistry: ModelRegistry) => Promise<void>,
	): Promise<void> {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("TRIGGER_FIRST"), { deliverAs: "aside", triggerTurn: true });
			await harness.session.sendCustomMessage(card("PASSIVE_SECOND"), { deliverAs: "aside" });
		});
		const { session, mock, modelRegistry } = harness;
		await setup(session, modelRegistry);

		await session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
		await settle(session);

		expect(mock.calls).toHaveLength(2);
		const request = JSON.stringify(mock.calls[1]!.context.messages);
		expect(request).toContain("PASSIVE_SECOND");
		expect(request.indexOf("TRIGGER_FIRST")).toBeGreaterThan(-1);
		expect(request.indexOf("TRIGGER_FIRST")).toBeLessThan(request.indexOf("PASSIVE_SECOND"));
		const persistedOrder = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message")
			.map(entry => entry.content);
		expect(persistedOrder).toEqual(["EXTENSION_TURN", "TRIGGER_FIRST", "PASSIVE_SECOND"]);
	}

	it("after an earlier interrupt, an aside without triggerTurn queued behind one with it rides that turn in queue order", async () => {
		await expectStrandedAsidesInQueueOrder(interruptPromptInSetup);
	});

	it("in plan mode, an aside without triggerTurn queued behind one with it rides that turn in queue order", async () => {
		await expectStrandedAsidesInQueueOrder(async target => {
			target.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		});
	});

	it("after an earlier interrupt, an aside without triggerTurn behind a peer message whose wake is held folds without a turn", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "HoldRecipient",
			displayName: "task",
			kind: "sub",
			parentId: "HoldParent",
			session: null,
		});
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.deliverIrcMessage({
				id: "peer-note",
				from: "HoldPeer",
				to: "HoldRecipient",
				body: "HOLD_PEER_NOTE",
				ts: Date.now(),
			});
			await harness.session.sendCustomMessage(card("PASSIVE_BEHIND_PEER"), { deliverAs: "aside" });
		});
		const { session, mock, modelRegistry } = harness;
		try {
			await interruptPromptInSetup(session, modelRegistry);
			const releaseHold = session.holdIrcWakes();
			await session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
			await settle(session);

			// The held peer message waits for a turn of its own; the aside that rode its wake folds.
			expect(mock.calls).toHaveLength(1);
			expect(persisted(session, "PASSIVE_BEHIND_PEER")).toBe(true);

			releaseHold();
			await settle(session);
			expect(mock.calls).toHaveLength(2);
			expect(JSON.stringify(mock.calls[1]!.context.messages)).toContain("HOLD_PEER_NOTE");
		} finally {
			registry.unregister("HoldRecipient");
		}
	});

	it("folds without a turn when an Esc lands while its turn waits for a work-pool yield change", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_BEFORE_ESC"), { deliverAs: "aside", triggerTurn: true });
		});
		const { session, mock, agentEnds } = harness;
		// The stranded aside's turn joins a pending work-pool yield change before it starts: hold that change.
		const turnWaiting = Promise.withResolvers<void>();
		const yieldChange = Promise.withResolvers<void>();
		const yieldSpy = spyOn(session, "whenWorkPoolYieldSettled").mockImplementation(() => {
			turnWaiting.resolve();
			return yieldChange.promise;
		});
		try {
			const extensionTurn = session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
			await turnWaiting.promise;

			await session.abort({ reason: USER_INTERRUPT_LABEL });
			yieldChange.resolve();
			await extensionTurn;
			await setImmediate();
			await settle(session);
		} finally {
			yieldChange.resolve();
			yieldSpy.mockRestore();
		}

		expect(mock.calls).toHaveLength(1);
		expect(persisted(session, "CARD_BEFORE_ESC")).toBe(true);
		// The run published its end non-terminal for the turn the aside asked for; the interrupt
		// cancelled that turn, so the session must still publish a terminal end.
		expect(agentEnds).toEqual([false, true]);
	});

	it("in an ACP session, one that lands after the run it was sent during has ended waits for the client's next turn", async () => {
		const { session, mock, modelRegistry } = await createHarness();
		session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
		// The aside's image normalization holds it until the switch below has changed the session generation.
		// Prompts normalize too, with no images: those pass straight through.
		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		// The switch changes the session generation, then fails and restores it.
		const switchPaused = Promise.withResolvers<void>();
		const failSwitch = Promise.withResolvers<void>();
		const setSessionFileSpy = spyOn(SessionManager.prototype, "setSessionFile").mockImplementation(async () => {
			switchPaused.resolve();
			await failSwitch.promise;
			throw new Error("forced switch failure");
		});
		let keyLookup: HeldKeyLookup | undefined;
		try {
			const sent = session.sendCustomMessage(
				{
					customType: "ext-card",
					content: [
						{ type: "text", text: "LATE_CARD" },
						{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
					],
					display: false,
					attribution: "agent",
				},
				{ deliverAs: "aside", triggerTurn: true },
			);
			await normalizeStarted.promise;
			const switched = session.switchSession(path.join(tempDir.path(), "target.jsonl"));
			await switchPaused.promise;
			// A client prompt's setup holds the session while the switch is paused.
			keyLookup = holdNextKeyLookup(modelRegistry);
			const refused = session.prompt("CLIENT_SETUP");
			await keyLookup.requested;
			expect(session.isStreaming).toBe(true);

			// The aside finds the session busy and waits out the generation change, past the prompt's end.
			releaseNormalize.resolve();
			await setImmediate();
			keyLookup.resolve(undefined);
			await expect(refused).rejects.toThrow("No API key");
			failSwitch.resolve();
			await expect(switched).rejects.toThrow("forced switch failure");
			expect(await sent).toBe(false);
			await settle(session);
		} finally {
			releaseNormalize.resolve();
			failSwitch.resolve();
			keyLookup?.resolve(undefined);
			keyLookup?.restore();
			setSessionFileSpy.mockRestore();
			normalizeSpy.mockRestore();
		}
		expect(mock.calls).toHaveLength(0);

		await session.prompt("CLIENT_TURN");
		expect(mock.calls).toHaveLength(1);
		expect(requestsContaining(mock, "LATE_CARD")).toBe(1);
	});

	interface HeldWorkPoolYieldWait {
		/** Settles when a wake turn starts to wait for the work-pool yield change. */
		reached: Promise<void>;
		release(): void;
		restore(): void;
	}

	/** Holds every wake turn in its work-pool yield wait, the window before it starts the turn. */
	function holdWorkPoolYieldWait(target: AgentSession): HeldWorkPoolYieldWait {
		const reached = Promise.withResolvers<void>();
		const change = Promise.withResolvers<void>();
		const spy = spyOn(target, "whenWorkPoolYieldSettled").mockImplementation(() => {
			reached.resolve();
			return change.promise;
		});
		return {
			reached: reached.promise,
			release: () => change.resolve(),
			restore: () => spy.mockRestore(),
		};
	}

	/** A card whose image normalization a test can hold, to outlast the run it was sent from. */
	function imageCard(content: string) {
		return {
			customType: "ext-card",
			content: [
				{ type: "text" as const, text: content },
				{ type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" },
			],
			display: false,
			attribution: "agent" as const,
		};
	}

	it("is dropped when a new session starts while its turn waits for a work-pool yield change, and the end it held open settles", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_BEFORE_NEW"), { deliverAs: "aside", triggerTurn: true });
		});
		const { session, mock, agentEnds } = harness;
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		const yieldWait = holdWorkPoolYieldWait(session);
		try {
			const extensionTurn = session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
			await yieldWait.reached;
			expect(agentEnds).toEqual([false]);

			// The new session clears the IRC queues and the transcript the aside belonged to.
			await session.newSession();
			yieldWait.release();
			await extensionTurn;
			await settle(session);
		} finally {
			yieldWait.release();
			yieldWait.restore();
		}

		expect(mock.calls).toHaveLength(1);
		expect(persisted(session, "CARD_BEFORE_NEW")).toBe(false);
		// No queue and no run of the outgoing session remain to publish that end.
		expect(agentEnds).toEqual([false, true]);
	});

	it("in an ACP session, one whose client prompt ends during the work-pool wait waits for the next client turn, and the end it held open settles", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_AFTER_CLIENT_TURN"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
		});
		const { session, mock, agentEnds } = harness;
		session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
		const yieldWait = holdWorkPoolYieldWait(session);
		try {
			// The client prompt owns the session while the wake starts, and releases it in the wait.
			const clientTurn = session.prompt("CLIENT_PROMPT");
			await yieldWait.reached;
			await clientTurn;

			yieldWait.release();
			await setImmediate();
			await settle(session);
		} finally {
			yieldWait.release();
			yieldWait.restore();
		}

		expect(mock.calls).toHaveLength(1);
		// The record waits for a prompt only the client can send, so the completed run's end is final.
		expect(agentEnds).toEqual([false, true]);

		await session.prompt("NEXT_CLIENT_PROMPT");
		await settle(session);
		expect(mock.calls).toHaveLength(2);
		expect(requestsContaining(mock, "CARD_AFTER_CLIENT_TURN")).toBe(1);
	});

	it("keeps its run's agent_end open while image normalization outlasts the run", async () => {
		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			// The extension API returns void: the send is not awaited, and its normalization runs on.
			void harness.session.sendCustomMessage(imageCard("CARD_SLOW_IMAGE"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
		});
		const { session, mock, agentEnds } = harness;
		try {
			await session.abort({ reason: USER_INTERRUPT_LABEL });
			await session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
			await normalizeStarted.promise;
			await settle(session);

			// The turn the aside asked for is still being prepared, so that run did not end the work.
			expect(mock.calls).toHaveLength(1);
			expect(agentEnds).toEqual([false]);

			releaseNormalize.resolve();
			await settle(session);
		} finally {
			releaseNormalize.resolve();
			normalizeSpy.mockRestore();
		}

		expect(mock.calls).toHaveLength(2);
		expect(requestsContaining(mock, "CARD_SLOW_IMAGE")).toBe(1);
		expect(agentEnds).toEqual([false, true]);
	});

	it("folds when an Esc lands while its idle turn waits for the usage preflight", async () => {
		const { session, mock } = await createHarness();
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		const preflightReached = Promise.withResolvers<void>();
		const releasePreflight = Promise.withResolvers<void>();
		const preflightSpy = spyOn(TurnRecovery.prototype, "maybeApplyUsageAwareFallback").mockImplementation(
			async () => {
				preflightReached.resolve();
				await releasePreflight.promise;
				return false;
			},
		);
		try {
			const sent = session.sendCustomMessage(card("CARD_IN_PREFLIGHT"), { deliverAs: "aside", triggerTurn: true });
			await preflightReached.promise;

			await session.abort({ reason: USER_INTERRUPT_LABEL });
			releasePreflight.resolve();
			expect(await sent).toBe(false);
			await settle(session);
		} finally {
			releasePreflight.resolve();
			preflightSpy.mockRestore();
		}

		expect(mock.calls).toHaveLength(0);
		expect(persisted(session, "CARD_IN_PREFLIGHT")).toBe(true);
	});

	it("folds when an Esc lands while startup-deferred extensions are still loading", async () => {
		const { session, mock } = await createHarness();
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		const loadStarted = Promise.withResolvers<void>();
		const releaseLoad = Promise.withResolvers<void>();
		session.setDeferredExtensionLoader(async () => {
			loadStarted.resolve();
			await releaseLoad.promise;
		});
		try {
			const sent = session.sendCustomMessage(card("CARD_BEFORE_LOAD_ESC"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
			await loadStarted.promise;

			await session.abort({ reason: USER_INTERRUPT_LABEL });
			releaseLoad.resolve();
			expect(await sent).toBe(false);
			await settle(session);
		} finally {
			releaseLoad.resolve();
		}

		expect(mock.calls).toHaveLength(0);
		expect(persisted(session, "CARD_BEFORE_LOAD_ESC")).toBe(true);
	});

	it("folds when an idle Esc lands during that load with no plan mode and nothing to suppress", async () => {
		// The Esc stops no run and no queued work, so since #17243 it latches no suppression:
		// only the interrupt the send was given folds this aside.
		const { session, mock } = await createHarness();
		const loadStarted = Promise.withResolvers<void>();
		const releaseLoad = Promise.withResolvers<void>();
		session.setDeferredExtensionLoader(async () => {
			loadStarted.resolve();
			await releaseLoad.promise;
		});
		try {
			const sent = session.sendCustomMessage(card("CARD_BEFORE_IDLE_ESC"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
			await loadStarted.promise;

			await session.abort({ reason: USER_INTERRUPT_LABEL });
			releaseLoad.resolve();
			expect(await sent).toBe(false);
			await settle(session);
		} finally {
			releaseLoad.resolve();
		}

		expect(mock.calls).toHaveLength(0);
		expect(persisted(session, "CARD_BEFORE_IDLE_ESC")).toBe(true);
	});

	it("stays parked for a monitored wake when a rolled-back transition and a pooled contract catch its turn in the work-pool wait", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_POOLED"), { deliverAs: "aside", triggerTurn: true });
		});
		const { session, mock } = harness;
		const yieldWait = holdWorkPoolYieldWait(session);
		const switchPaused = Promise.withResolvers<void>();
		const releaseSwitch = Promise.withResolvers<void>();
		session.setSessionBeforeSwitchReconciler(async () => {
			switchPaused.resolve();
			await releaseSwitch.promise;
		});
		const setSessionFileSpy = spyOn(SessionManager.prototype, "setSessionFile").mockImplementation(async () => {
			throw new Error("forced switch failure");
		});
		let switched: Promise<boolean> | undefined;
		try {
			// The extension turn strands the aside, and its wake enters the work-pool wait.
			const extensionTurn = session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
			await yieldWait.reached;

			// A pooled turn takes the worker, and a switch disconnects the agent before its own reset.
			void session.setWorkPoolYieldItems([{ id: "pool#1", index: 1 }]);
			switched = session.switchSession(path.join(tempDir.path(), "target.jsonl"));
			await switchPaused.promise;

			yieldWait.release();
			await setImmediate();
			releaseSwitch.resolve();
			await expect(switched).rejects.toThrow("forced switch failure");
			await extensionTurn;
			await settle(session);
		} finally {
			yieldWait.release();
			releaseSwitch.resolve();
			yieldWait.restore();
			setSessionFileSpy.mockRestore();
			session.setSessionBeforeSwitchReconciler(null);
			await switched?.catch(() => {});
		}

		// The record waits for a wake of its own: a pooled turn must not flush it into its batch.
		expect(session.ircWakesPending).toBe(true);
		await session.prompt("POOLED_TURN");
		await settle(session);
		expect(requestsContaining(mock, "CARD_POOLED")).toBe(0);

		// Clearing the contract gives it that wake.
		await session.setWorkPoolYieldItems([]);
		await settle(session);
		expect(requestsContaining(mock, "CARD_POOLED")).toBe(1);
	});

	it("gets its turn as soon as a rolled-back switch restores the queue it was parked in", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_ROLLED_BACK"), { deliverAs: "aside", triggerTurn: true });
		});
		const { session, mock } = harness;
		const yieldWait = holdWorkPoolYieldWait(session);
		const switchPaused = Promise.withResolvers<void>();
		const releaseSwitch = Promise.withResolvers<void>();
		session.setSessionBeforeSwitchReconciler(async () => {
			switchPaused.resolve();
			await releaseSwitch.promise;
		});
		const setSessionFileSpy = spyOn(SessionManager.prototype, "setSessionFile").mockImplementation(async () => {
			throw new Error("forced switch failure");
		});
		let switched: Promise<boolean> | undefined;
		try {
			const extensionTurn = session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
			await yieldWait.reached;

			// The switch has disconnected the agent and has not yet snapshotted the queues.
			switched = session.switchSession(path.join(tempDir.path(), "target.jsonl"));
			await switchPaused.promise;

			yieldWait.release();
			await setImmediate();
			releaseSwitch.resolve();
			await expect(switched).rejects.toThrow("forced switch failure");
			await extensionTurn;
			await settle(session);
		} finally {
			yieldWait.release();
			releaseSwitch.resolve();
			yieldWait.restore();
			setSessionFileSpy.mockRestore();
			session.setSessionBeforeSwitchReconciler(null);
			await switched?.catch(() => {});
		}

		// The rollback restored the record into the live session: it gets its turn with no
		// further prompt from anyone.
		expect(mock.calls).toHaveLength(2);
		expect(requestsContaining(mock, "CARD_ROLLED_BACK")).toBe(1);
	});

	it("holds no agent_end of the session that replaced its own open", async () => {
		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		const { session, mock, agentEnds } = await createHarness();
		try {
			await session.abort({ reason: USER_INTERRUPT_LABEL });
			const sent = session.sendCustomMessage(imageCard("CARD_OLD_SESSION"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
			await normalizeStarted.promise;

			// The send belongs to the transcript this replaces.
			expect(await session.newSession()).toBe(true);
			await session.prompt("NEW_SESSION_TURN");
			await settle(session);

			// That turn ended the work of the new session: nothing of the old send follows it.
			expect(agentEnds).toEqual([true]);

			releaseNormalize.resolve();
			expect(await sent).toBe(false);
			await settle(session);
		} finally {
			releaseNormalize.resolve();
			normalizeSpy.mockRestore();
		}

		expect(mock.calls).toHaveLength(1);
		expect(requestsContaining(mock, "CARD_OLD_SESSION")).toBe(0);
	});

	it("keeps the agent_end of the session it lands in open when a new session starts during startup extension loading", async () => {
		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		const { session, mock, agentEnds } = await createHarness();
		const loadStarted = Promise.withResolvers<void>();
		const releaseLoad = Promise.withResolvers<void>();
		session.setDeferredExtensionLoader(async () => {
			loadStarted.resolve();
			await releaseLoad.promise;
		});
		try {
			await session.abort({ reason: USER_INTERRUPT_LABEL });
			const sent = session.sendCustomMessage(imageCard("CARD_AFTER_LOAD"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
			await loadStarted.promise;

			// The send is still waiting for the extensions when the new session commits; it goes on
			// into the new session once they load.
			expect(await session.newSession()).toBe(true);
			releaseLoad.resolve();
			await normalizeStarted.promise;
			await session.prompt("NEW_SESSION_TURN");
			await settle(session);

			// The aside's turn in this session is still being prepared, so that run did not end the work.
			expect(agentEnds).toEqual([false]);

			releaseNormalize.resolve();
			await sent;
			await settle(session);
		} finally {
			releaseLoad.resolve();
			releaseNormalize.resolve();
			normalizeSpy.mockRestore();
		}

		expect(mock.calls).toHaveLength(2);
		expect(requestsContaining(mock, "CARD_AFTER_LOAD")).toBe(1);
		expect(agentEnds).toEqual([false, true]);
	});

	/** Strands a `triggerTurn` aside, then parks its wake as a deferred wake behind a pooled contract. */
	async function parkStrandedAsideBehindPool(target: AgentSession, yieldWait: HeldWorkPoolYieldWait): Promise<void> {
		const extensionTurn = target.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
		await yieldWait.reached;
		void target.setWorkPoolYieldItems([{ id: "pool#1", index: 1 }]);
		yieldWait.release();
		await extensionTurn;
		await settle(target);
	}

	it("folds a parked aside an idle Esc overtook, and settles the end that was held open for it", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_PARKED"), { deliverAs: "aside", triggerTurn: true });
		});
		const { session, mock, agentEnds } = harness;
		const yieldWait = holdWorkPoolYieldWait(session);
		try {
			await parkStrandedAsideBehindPool(session, yieldWait);
			expect(session.ircWakesPending).toBe(true);
			expect(agentEnds).toEqual([false]);

			// The Esc stops no run and no queued work, so it latches no suppression: the interrupt
			// count it bumps is the only thing that can fold the parked aside.
			await session.abort({ reason: USER_INTERRUPT_LABEL });
			await session.setWorkPoolYieldItems([]);
			await settle(session);
		} finally {
			yieldWait.release();
			yieldWait.restore();
		}

		expect(mock.calls).toHaveLength(1);
		expect(persisted(session, "CARD_PARKED")).toBe(true);
		expect(agentEnds).toEqual([false, true]);
	});

	it("settles that end when plan mode folds every parked record as the pool clears", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_PARKED_PLAN"), { deliverAs: "aside" });
		});
		const { session, mock, agentEnds } = harness;
		const yieldWait = holdWorkPoolYieldWait(session);
		try {
			await parkStrandedAsideBehindPool(session, yieldWait);
			expect(agentEnds).toEqual([false]);

			session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
			await session.setWorkPoolYieldItems([]);
			await settle(session);
		} finally {
			yieldWait.release();
			yieldWait.restore();
		}

		expect(mock.calls).toHaveLength(1);
		expect(persisted(session, "CARD_PARKED_PLAN")).toBe(true);
		expect(agentEnds).toEqual([false, true]);
	});

	it("settles the replacement session's end while an aside of the session it replaced is still admitted", async () => {
		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_PARKED_NEW"), { deliverAs: "aside", triggerTurn: true });
		});
		const { session, mock, agentEnds } = harness;
		const yieldWait = holdWorkPoolYieldWait(session);
		try {
			// The image-bearing send belongs to the transcript the new session replaces, and stays
			// admitted across it: it promises the replacement nothing.
			void session.sendCustomMessage(imageCard("CARD_OLD_SESSION"), { deliverAs: "aside", triggerTurn: true });
			await normalizeStarted.promise;
			expect(await session.newSession()).toBe(true);

			await parkStrandedAsideBehindPool(session, yieldWait);
			expect(agentEnds).toEqual([false]);

			await session.abort({ reason: USER_INTERRUPT_LABEL });
			await session.setWorkPoolYieldItems([]);
			await settle(session);
		} finally {
			yieldWait.release();
			yieldWait.restore();
			releaseNormalize.resolve();
			normalizeSpy.mockRestore();
		}

		expect(mock.calls).toHaveLength(1);
		expect(agentEnds).toEqual([false, true]);
	});

	it("settles that end when an Esc in the usage preflight folds the aside its run waited for", async () => {
		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		const preflightReached = Promise.withResolvers<void>();
		const releasePreflight = Promise.withResolvers<void>();
		// Held only for the aside's own turn: the extension turn below runs the same preflight.
		let holdPreflight = false;
		const preflightSpy = spyOn(TurnRecovery.prototype, "maybeApplyUsageAwareFallback").mockImplementation(
			async () => {
				if (!holdPreflight) return false;
				preflightReached.resolve();
				await releasePreflight.promise;
				return false;
			},
		);
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			// The extension API returns void: the send outlives the run it was made from.
			void harness.session.sendCustomMessage(imageCard("CARD_IN_PREFLIGHT_ESC"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
		});
		const { session, mock, agentEnds } = harness;
		try {
			await session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
			await normalizeStarted.promise;
			await settle(session);
			expect(agentEnds).toEqual([false]);

			// The aside leaves normalization and reaches the preflight of the turn it was promised.
			holdPreflight = true;
			releaseNormalize.resolve();
			await preflightReached.promise;
			await session.abort({ reason: USER_INTERRUPT_LABEL });
			releasePreflight.resolve();
			await settle(session);
		} finally {
			releaseNormalize.resolve();
			releasePreflight.resolve();
			normalizeSpy.mockRestore();
			preflightSpy.mockRestore();
		}

		expect(mock.calls).toHaveLength(1);
		expect(JSON.stringify(session.agent.state.messages)).toContain("CARD_IN_PREFLIGHT_ESC");
		expect(agentEnds).toEqual([false, true]);
	});

	interface HeldSessionTransition {
		/** Settles once a transition has disconnected the agent and not yet bumped the generation. */
		reached: Promise<void>;
		release(): void;
		restore(): void;
	}

	/** Holds the next session transition in `SessionManager.flush()`, which `newSession()` awaits
	 *  after `#disconnectFromAgent()` and before it bumps `#sessionGeneration`. */
	function holdSessionTransition(target: AgentSession): HeldSessionTransition {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let held = true;
		const spy = spyOn(target.sessionManager, "flush").mockImplementation(async () => {
			if (!held) return;
			held = false;
			reached.resolve();
			await release.promise;
		});
		return { reached: reached.promise, release: () => release.resolve(), restore: () => spy.mockRestore() };
	}

	interface HeldIdleCompaction {
		/** Settles once a wake has parked on the held idle compaction. */
		reached: Promise<void>;
		/** Lets the next `waitForIdleCompaction()` caller park; earlier callers see no compaction. */
		arm(): void;
		release(): void;
		restore(): void;
	}

	/** Holds the first armed `waitForIdleCompaction()` call, the window a wake parks in while an
	 *  automatic idle compaction runs. Unarmed and after the hold it answers "none running", as the
	 *  real one does, so only the caller under test parks. */
	function holdIdleCompaction(): HeldIdleCompaction {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let armed = false;
		let held = false;
		const spy = spyOn(SessionMaintenance.prototype, "waitForIdleCompaction").mockImplementation(() => {
			if (!armed || held) return undefined;
			held = true;
			reached.resolve();
			return release.promise;
		});
		return {
			reached: reached.promise,
			arm: () => {
				armed = true;
			},
			release: () => release.resolve(),
			restore: () => spy.mockRestore(),
		};
	}

	it("in plan mode, one whose normalization outlasts the start of a new session runs no turn in the replacement transcript", async () => {
		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		const { session, mock } = await createHarness();
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		// Holds the new session after it has disconnected the agent and before it bumps the session
		// generation: the window in which a bare generation check still reads "same session".
		const transition = holdSessionTransition(session);
		try {
			// `triggerTurn` keeps plan mode from folding it, so only the transition can stop the turn.
			const sent = session.sendCustomMessage(imageCard("CARD_MID_TRANSITION"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
			await normalizeStarted.promise;
			const started = session.newSession();
			await transition.reached;

			releaseNormalize.resolve();
			await setImmediate();
			transition.release();
			expect(await started).toBe(true);
			expect(await sent).toBe(false);
			await settle(session);
		} finally {
			releaseNormalize.resolve();
			transition.release();
			transition.restore();
			normalizeSpy.mockRestore();
		}

		expect(mock.calls).toHaveLength(0);
		expect(persisted(session, "CARD_MID_TRANSITION")).toBe(false);
	});

	it("settles the run's end when a new session drops the aside its admission held open", async () => {
		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			// The extension API returns void: the send outlives the run it was made from.
			void harness.session.sendCustomMessage(imageCard("CARD_DROPPED_BY_NEW"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
		});
		const { session, mock, agentEnds } = harness;
		try {
			await session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
			await normalizeStarted.promise;
			await settle(session);
			// The run ended non-terminal for the turn the admitted aside asked for.
			expect(agentEnds).toEqual([false]);

			// The new session owns the transcript now, so the send lands nowhere: no record is
			// queued, folded or prompted, and only its admission closes.
			expect(await session.newSession()).toBe(true);
			releaseNormalize.resolve();
			await settle(session);
		} finally {
			releaseNormalize.resolve();
			normalizeSpy.mockRestore();
		}

		expect(mock.calls).toHaveLength(1);
		expect(persisted(session, "CARD_DROPPED_BY_NEW")).toBe(false);
		expect(agentEnds).toEqual([false, true]);
	});

	it("settles the end it held open when a new session commits after its wake re-queued the records", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_REQUEUED_BY_NEW"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
		});
		const { session, mock, agentEnds } = harness;
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		const yieldWait = holdWorkPoolYieldWait(session);
		const transition = holdSessionTransition(session);
		try {
			const extensionTurn = session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
			await yieldWait.reached;
			expect(agentEnds).toEqual([false]);

			// The wake leaves its yield wait while the new session has disconnected the agent and
			// has not yet bumped the generation, so it re-queues its records for the transition.
			const started = session.newSession();
			await transition.reached;
			yieldWait.release();
			await setImmediate();
			transition.release();
			expect(await started).toBe(true);
			await extensionTurn;
			await settle(session);
		} finally {
			yieldWait.release();
			yieldWait.restore();
			transition.release();
			transition.restore();
		}

		// The commit cleared the queue, so no record and no turn remain to publish that end.
		expect(mock.calls).toHaveLength(1);
		expect(persisted(session, "CARD_REQUEUED_BY_NEW")).toBe(false);
		expect(agentEnds).toEqual([false, true]);
	});

	it("settles the end it held open when a new session commits while its wake waits out an idle compaction", async () => {
		const compaction = holdIdleCompaction();
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_BEFORE_COMPACTION"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
			// From here the only waitForIdleCompaction() call left in this settle is the wake's.
			compaction.arm();
		});
		const { session, mock, agentEnds } = harness;
		try {
			await session.sendCustomMessage(card("EXTENSION_TURN"), { triggerTurn: true });
			await compaction.reached;
			expect(agentEnds).toEqual([false]);

			// The new session clears the IRC queues and the transcript the aside belonged to; the
			// wake's records live only in the parked closure, so the commit leaves nothing to wake.
			expect(await session.newSession()).toBe(true);
			compaction.release();
			await setImmediate();
			await settle(session);
		} finally {
			compaction.release();
			compaction.restore();
		}

		expect(mock.calls).toHaveLength(1);
		expect(persisted(session, "CARD_BEFORE_COMPACTION")).toBe(false);
		expect(agentEnds).toEqual([false, true]);
	});

	it("settles the end it held open when a new session discards the parked record that promised the turn", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_PARKED_POOL"), { deliverAs: "aside", triggerTurn: true });
		});
		const { session, mock, agentEnds } = harness;
		const yieldWait = holdWorkPoolYieldWait(session);
		try {
			await parkStrandedAsideBehindPool(session, yieldWait);
			expect(session.ircWakesPending).toBe(true);
			expect(agentEnds).toEqual([false]);

			// The record waits for the pool to clear; the new session discards it instead.
			expect(await session.newSession()).toBe(true);
			await settle(session);
		} finally {
			yieldWait.release();
			yieldWait.restore();
		}

		expect(mock.calls).toHaveLength(1);
		expect(persisted(session, "CARD_PARKED_POOL")).toBe(false);
		expect(agentEnds).toEqual([false, true]);
	});

	it("settles the end it held open when a session switch discards the parked record that promised the turn", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_PARKED_SWITCH"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
		});
		const { session, mock, agentEnds } = harness;
		const yieldWait = holdWorkPoolYieldWait(session);
		try {
			await parkStrandedAsideBehindPool(session, yieldWait);
			expect(agentEnds).toEqual([false]);

			expect(await session.switchSession(path.join(tempDir.path(), "switch-target.jsonl"))).toBe(true);
			await settle(session);
		} finally {
			yieldWait.release();
			yieldWait.restore();
		}

		expect(mock.calls).toHaveLength(1);
		expect(agentEnds).toEqual([false, true]);
	});

	it("settles the end it held open when a context reset discards the parked record that promised the turn", async () => {
		let sent = false;
		const harness = await createHarness(async () => {
			if (sent) return;
			sent = true;
			await harness.session.sendCustomMessage(card("CARD_PARKED_RESET"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
		});
		const { session, agentEnds } = harness;
		const yieldWait = holdWorkPoolYieldWait(session);
		try {
			await parkStrandedAsideBehindPool(session, yieldWait);
			expect(agentEnds).toEqual([false]);

			// A context reset bumps the session generation like /new, so the parked record belongs
			// to a transcript that no longer exists and no turn of this run's can follow.
			expect(await session.resetSessionContext()).toBeDefined();
			await settle(session);
		} finally {
			yieldWait.release();
			yieldWait.restore();
		}

		expect(agentEnds).toEqual([false, true]);
		// The reset discarded the record itself, not only the end it held open.
		expect(session.ircWakesPending).toBe(false);
	});

	it("hands its record to a transition that starts while the generation check awaits", async () => {
		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		const { session, mock } = await createHarness();
		// `triggerTurn` in plan mode: only the transition can stop this turn.
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		let callsWhenTransitionStarted = Number.POSITIVE_INFINITY;
		try {
			const sent = session.sendCustomMessage(imageCard("CARD_IN_GENERATION_AWAIT"), {
				deliverAs: "aside",
				triggerTurn: true,
			});
			await normalizeStarted.promise;
			// Starts `/new` three microtasks after normalization resolves, which lands it after the
			// dispatch has read `isSessionTransitioning` and before its generation await resumes —
			// the window a check made before that await cannot see. The hop count pins that
			// alignment; the assertion below holds whichever way the two interleave.
			let chain: Promise<unknown> = releaseNormalize.promise;
			for (let hop = 0; hop < 3; hop++) chain = chain.then(() => undefined);
			void chain.then(() => {
				callsWhenTransitionStarted = mock.calls.length;
				void session.newSession();
			});
			releaseNormalize.resolve();
			expect(await sent).toBe(false);
			await settle(session);
		} finally {
			releaseNormalize.resolve();
			normalizeSpy.mockRestore();
		}

		// No request carrying the record was made once the transition had started: a turn after
		// that point would have run against the transcript replacing the one it was sent to.
		const leaked = mock.calls.findIndex(
			(call, index) =>
				index >= callsWhenTransitionStarted &&
				JSON.stringify(call.context.messages).includes("CARD_IN_GENERATION_AWAIT"),
		);
		expect(leaked).toBe(-1);
	});

	it("does not hold a session transition open while it queues an aside the transition's own hook sent", async () => {
		const { session, mock } = await createHarness();
		// The reconciler runs inside switchSession()'s transition scope, which awaits it. A send
		// that waited the transition out instead of queueing would never return here, and the
		// switch would never finish: this test hangs to its timeout rather than failing an assert.
		let hookResult: boolean | undefined;
		session.setSessionSwitchReconciler(async () => {
			hookResult = await session.sendCustomMessage(card("CARD_FROM_HOOK"), { deliverAs: "aside" });
		});
		expect(await session.switchSession(path.join(tempDir.path(), "hook-target.jsonl"))).toBe(true);
		// The send returns without starting a turn inside the transition scope, and the record it
		// queued reaches the new session's first turn instead of being lost.
		expect(hookResult).toBe(false);
		await settle(session);
		expect(requestsContaining(mock, "CARD_FROM_HOOK")).toBe(1);
	});
});
