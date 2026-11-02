/**
 * Contract: a session reports its run idle only while its Agent is settled (not streaming, holding no
 * input it took), whatever produced the `agent_end` it settles on, and it publishes input a run put back
 * only after that run's `agent_end`. The Agent-level properties live in
 * `packages/agent/test/steering-invariants.test.ts`; these rows check that the session, which treats any
 * `agent_end` as its run's end, inherits them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	return typeof message.content === "string"
		? message.content
		: message.content.map(part => ("text" in part ? part.text : "")).join("");
}

interface IdleSeen {
	streaming: boolean;
	held: string[];
}

describe("AgentSession reports a run idle only with its Agent settled", () => {
	let fixtureDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		fixtureDir = path.join(os.tmpdir(), `pi-settled-end-${Snowflake.next()}`);
		fs.mkdirSync(fixtureDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(fixtureDir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir, "models.yml"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(fixtureDir);
	});

	/** A session whose mock model answers in text; a response started after an abort ends as aborted. */
	function createSession() {
		const mock = createMockModel({
			handler: (_context, options) => ({ content: ["ack"], delayMs: options?.signal?.aborted ? 1 : 0 }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const idle: IdleSeen[] = [];
		session.subscribeRunState(state => {
			if (state !== "idle") return;
			idle.push({
				streaming: agent.state.isStreaming,
				held: agent.peekUndeliveredQueuedMessages().map(messageText),
			});
		});
		return { session, agent, mock, idle };
	}

	for (const held of ["nothing", "live-steered"] as const) {
		for (const ending of ["completes", "abort", "provider-throws", "foreign-end"] as const) {
			it(`holding ${held}, ended by ${ending}`, async () => {
				const { session, agent, mock, idle } = createSession();
				const streaming = Promise.withResolvers<void>();
				const reached = Promise.withResolvers<void>();
				const decided = Promise.withResolvers<void>();
				let first = true;
				agent.streamFn = async (model, context, options) => {
					if (!first) return mock.stream(model, context, options);
					first = false;
					streaming.resolve();
					if (held === "live-steered" && options?.liveSteering && options.signal) {
						await options.liveSteering.wait(options.signal);
						await options.liveSteering.claim(options.signal);
					}
					reached.resolve();
					await decided.promise;
					if (ending === "provider-throws") throw new Error("provider failed");
					return mock.stream(model, context, options);
				};

				const running = session.prompt("start");
				await streaming.promise;
				if (held === "live-steered") await session.steer("P1");
				await reached.promise;
				let foreign: string | undefined;
				if (ending === "foreign-end") {
					try {
						agent.emitExternalAgentEnd({ type: "agent_end", messages: [] }, "other-producer");
						foreign = "dispatched";
					} catch (error) {
						foreign = error instanceof Error ? error.message : String(error);
					}
				}
				const idleWhileRunning = [...idle];
				if (ending === "abort") agent.abort();
				decided.resolve();
				await running;
				await session.waitForIdle();

				if (ending === "foreign-end") {
					expect(foreign).toContain("Agent.emitExternalAgentEnd cannot report an end while this Agent");
				}
				expect(idleWhileRunning).toEqual([]);
				expect(idle.length).toBeGreaterThan(0);
				for (const seen of idle) expect(seen).toEqual({ streaming: false, held: [] });
				// Nothing the run took is lost: recorded, or back in the queue.
				const placed = [
					...agent.state.messages.filter(message => message.role === "user").map(messageText),
					...agent.peekSteeringQueue().map(messageText),
				];
				expect(placed.filter(text => text === "P1")).toHaveLength(held === "live-steered" ? 1 : 0);
			});
		}
	}

	it("dispatches a foreign agent_end while idle, and the session settles on it", async () => {
		const { session, agent, idle } = createSession();
		await session.prompt("start");
		await session.waitForIdle();
		const before = idle.length;
		const ended = Promise.withResolvers<string | undefined>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "agent_end") ended.resolve(event.source);
		});

		agent.emitExternalAgentEnd({ type: "agent_end", messages: [] }, "other-producer");

		expect(await ended.promise).toBe("other-producer");
		unsubscribe();
		await session.waitForIdle();
		expect(idle.length).toBeGreaterThan(before);
		for (const seen of idle) expect(seen).toEqual({ streaming: false, held: [] });
	});

	it("lists input an aborted preparation put back without publishing it from inside the run's teardown", async () => {
		const { session, agent } = createSession();
		let steered = false;
		let restoring = false;
		agent.addBeforeModelCallHook(() => {
			if (steered) return;
			steered = true;
			agent.steer({ role: "user", content: "P1", attribution: "user", timestamp: 1 });
		});
		agent.prepareQueuedMessages = () => {
			agent.prepareQueuedMessages = undefined;
			restoring = true;
			agent.abort();
			throw new Error("cancel preparation");
		};
		const observed: Array<{ type: "agent_end" | "queue_update"; streaming: boolean; steering: string[] }> = [];
		session.subscribe(event => {
			if (!restoring || event.type !== "queue_update" || !event.steering.includes("P1")) return;
			observed.push({ type: "queue_update", streaming: agent.state.isStreaming, steering: [...event.steering] });
		});
		agent.subscribe(event => {
			// The end of the run that put P1 back; a later run the session starts to deliver P1 ends too.
			if (!restoring || event.type !== "agent_end" || observed.some(seen => seen.type === "agent_end")) return;
			observed.push({
				type: "agent_end",
				streaming: agent.state.isStreaming,
				steering: [...session.getQueuedMessages().steering],
			});
		});

		await session.prompt("start");
		await session.waitForIdle();

		// P1 stayed listed while it was claimed, so the restoration changed nothing a client sees: no update
		// lists it from inside the teardown, and the run's end finds it listed.
		expect(observed[0]).toEqual({ type: "agent_end", streaming: false, steering: ["P1"] });
		for (const update of observed.slice(1)) expect(update).toMatchObject({ type: "queue_update", streaming: false });
		// Nothing is lost: the session delivers P1 or keeps it queued.
		const placed = [
			...agent.state.messages.filter(message => message.role === "user").map(messageText),
			...agent.peekSteeringQueue().map(messageText),
		];
		expect(placed.filter(text => text === "P1")).toHaveLength(1);
	});
});
