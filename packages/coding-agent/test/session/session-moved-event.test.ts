import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentContext, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	ExtensionRunner,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { SessionEvent } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * File storage that reports one session id as owned by another live process,
 * which is what makes a write move the session off its file. Every other id —
 * the sibling it moves to included — claims normally.
 */
class StorageWithForeignOwner extends FileSessionStorage {
	readonly #ownedElsewhere: string;

	constructor(ownedElsewhere: string) {
		super();
		this.#ownedElsewhere = ownedElsewhere;
	}

	override claimSession(sessionId: string, sessionPath: string): (() => void) | null {
		return sessionId === this.#ownedElsewhere ? null : super.claimSession(sessionId, sessionPath);
	}
}

/** File storage on which this process can claim no session id, so every write moves the session. */
class StorageOwnedByNobody extends FileSessionStorage {
	override claimSession(): (() => void) | null {
		return null;
	}
}

describe("a session that had to leave its file", () => {
	it("announces the move with both ids, and never as a switch somebody chose", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const seed = SessionManager.create(tempDir.path(), sessionDir, new FileSessionStorage());
		await seed.ensureOnDisk();
		const sessionFile = seed.getSessionFile();
		const sessionId = seed.getSessionId();
		if (!sessionFile) throw new Error("Expected a persisted session");
		await seed.close();

		const sessionManager = await SessionManager.open(
			sessionFile,
			sessionDir,
			new StorageWithForeignOwner(sessionId),
			{ suppressBreadcrumb: true },
		);
		const events: SessionEvent[] = [];
		const announced = Promise.withResolvers<void>();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_moved", event => {
					events.push(event);
					announced.resolve();
				});
				pi.on("session_switch", event => {
					events.push(event);
					announced.resolve();
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"capture-session-moved",
		);
		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel();
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner: new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry),
		});
		try {
			sessionManager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
			await sessionManager.flush();
			await announced.promise;

			expect(events).toEqual([
				{
					type: "session_moved",
					reason: "open-elsewhere",
					previousSessionId: sessionId,
					sessionId: sessionManager.getSessionId(),
					previousSessionFile: sessionFile,
					sessionFile: sessionManager.getSessionFile() as string,
				},
			]);
			expect(sessionManager.getSessionId()).not.toBe(sessionId);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	/**
	 * A session over a file another process owns, so its first write moves it,
	 * with `register` as its extension. `seed` writes to the file first, as the
	 * owner, before this process opens it; `storage` decides which ids this
	 * process may claim — by default every id but the owner's.
	 */
	async function sessionOverOwnedFile(
		tempDir: TempDir,
		register: Parameters<typeof loadExtensionFromFactory>[0],
		tools: AgentTool[] = [],
		responses: Parameters<typeof createMockModel>[0] = {},
		seed: (owner: SessionManager) => void = () => {},
		storage: (ownerId: string) => FileSessionStorage = ownerId => new StorageWithForeignOwner(ownerId),
	) {
		const sessionDir = path.join(tempDir.path(), "sessions");
		const owner = SessionManager.create(tempDir.path(), sessionDir, new FileSessionStorage());
		seed(owner);
		await owner.ensureOnDisk();
		await owner.flush();
		const sessionFile = owner.getSessionFile();
		const sessionId = owner.getSessionId();
		if (!sessionFile) throw new Error("Expected a persisted session");
		await owner.close();
		const sessionManager = await SessionManager.open(sessionFile, sessionDir, storage(sessionId), {
			suppressBreadcrumb: true,
		});
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(register, tempDir.path(), new EventBus(), runtime, "moves");
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel(responses);
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner: new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry),
		});
		return { session, sessionManager };
	}

	const schema = type({});
	/** A tool that records when it runs. */
	function probeTool(order: string[]): AgentTool<typeof schema> {
		return {
			name: "probe",
			label: "Probe",
			description: "Records when it runs",
			parameters: schema,
			async execute() {
				order.push("tool ran");
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
	}

	/** The hook the agent loop runs before every tool call, asked for `tool`: what it said. */
	function toolGate(session: AgentSession, tool: AgentTool, signal?: AbortSignal): Promise<string> {
		const toolCall = { type: "toolCall" as const, id: "probe-1", name: tool.name, arguments: {} };
		return Promise.resolve(
			session.agent.beforeToolCall?.(
				{
					assistantMessage: { role: "assistant", content: [toolCall] } as unknown as AssistantMessage,
					toolCall,
					tool,
					args: {},
					context: { systemPrompt: [], messages: [], tools: [] } as unknown as AgentContext,
				},
				signal,
			),
		).then(
			() => "went ahead",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
	}

	it("holds a tool under the new id for a session_moved handler that finishes within its grace", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		const order: string[] = [];
		const handlerStarted = Promise.withResolvers<void>();
		const handlerMayFinish = Promise.withResolvers<void>();
		const probe = probeTool(order);
		const { session, sessionManager } = await sessionOverOwnedFile(
			tempDir,
			pi => {
				pi.on("session_moved", async () => {
					order.push("handler started");
					handlerStarted.resolve();
					await handlerMayFinish.promise;
					order.push("handler finished");
				});
			},
			[probe],
			{ responses: [{ content: [{ type: "toolCall", name: "probe", arguments: {} }] }, { content: ["done"] }] },
		);
		try {
			sessionManager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
			await sessionManager.flush();
			await handlerStarted.promise;

			// Asked while the handler is still running, by a caller that is
			// cancelled: a hook that waits for the handler can only answer with
			// the cancellation.
			expect(await toolGate(session, probe, AbortSignal.abort(new Error("cancelled by the caller")))).toBe(
				"cancelled by the caller",
			);

			// And a real turn: its tool runs once the handler has finished.
			const turn = session.prompt("go");
			handlerMayFinish.resolve();
			await turn;
			expect(order).toEqual(["handler started", "handler finished", "tool ran"]);
		} finally {
			handlerMayFinish.resolve();
			await session.dispose();
		}
	}, 30_000);

	it("goes ahead after the grace when a handler does not return, and shuts down without waiting for it", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		const order: string[] = [];
		const handlerStarted = Promise.withResolvers<number>();
		// Released only after the test has measured everything: until then
		// this handler never returns.
		const handlerMayFinish = Promise.withResolvers<void>();
		const probe = probeTool(order);
		const { session, sessionManager } = await sessionOverOwnedFile(
			tempDir,
			pi => {
				pi.on("session_moved", async () => {
					handlerStarted.resolve(performance.now());
					await handlerMayFinish.promise;
					order.push("handler finished");
				});
				pi.on("session_shutdown", async () => {
					order.push("shutdown");
				});
			},
			[probe],
		);
		// What `waited` came to, or "still waiting" after `ms`. Real time, on
		// purpose: the grace is a bound on how long a user waits, so it is
		// measured on the clock the user waits on. Every bound here is under
		// the extension runner's own 30-second cap on a handler, so a wait for
		// the handler itself would still be waiting.
		const within = (ms: number, waited: Promise<string>) =>
			Promise.race([waited, Bun.sleep(ms).then(() => "still waiting")]);
		try {
			sessionManager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
			await sessionManager.flush();
			const started = await handlerStarted.promise;

			// Without a cancellation: the tool-call hook and the main loop's model
			// request each wait two seconds — the figure the documentation gives —
			// then go ahead with the handler still running.
			let modelAt = 0;
			const model = Promise.resolve(session.agent.transformContext?.([], undefined)).then(() => {
				modelAt = performance.now();
				return "went ahead";
			});
			const [tool, request] = await Promise.all([within(7_000, toolGate(session, probe)), within(7_000, model)]);
			expect(modelAt - started).toBeGreaterThanOrEqual(1_950);
			expect([tool, request]).toEqual(["went ahead", "went ahead"]);
			expect(performance.now() - started).toBeGreaterThanOrEqual(1_950);
			// Teardown does not wait for the handler at all.
			expect(
				await within(
					5_000,
					session.dispose().then(() => "disposed"),
				),
			).toBe("disposed");
			expect(order).toEqual(["shutdown"]);
		} finally {
			handlerMayFinish.resolve();
			await session.dispose();
		}
	}, 30_000);

	it("bounds one wait at two seconds in all, however many moves happen while it waits", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		const probe = probeTool([]);
		const handlerMayFinish = Promise.withResolvers<void>();
		const { session, sessionManager } = await sessionOverOwnedFile(
			tempDir,
			pi => {
				pi.on("session_moved", async () => {
					await handlerMayFinish.promise;
				});
			},
			[probe],
			{},
			() => {},
			// Nobody may claim any id, so every write moves the session again.
			() => new StorageOwnedByNobody(),
		);
		let waiting = true;
		try {
			sessionManager.appendMessage({ role: "user", content: "move 0", timestamp: Date.now() });
			await sessionManager.flush();
			const started = performance.now();
			const gate = toolGate(session, probe).finally(() => {
				waiting = false;
			});
			// A move every 300 ms, each with a grace of its own, for up to 7 s.
			for (let n = 1; waiting && performance.now() - started < 7_000; n++) {
				await Bun.sleep(300);
				sessionManager.appendMessage({ role: "user", content: `move ${n}`, timestamp: Date.now() });
				await sessionManager.flush();
			}
			expect(waiting).toBe(false);
			expect(await gate).toBe("went ahead");
			expect(performance.now() - started).toBeLessThan(3_000);
		} finally {
			waiting = false;
			handlerMayFinish.resolve();
			await session.dispose();
		}
	}, 30_000);

	it("starts no session_moved handler once the session is disposed", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		const order: string[] = [];
		const firstStarted = Promise.withResolvers<void>();
		const firstMayFinish = Promise.withResolvers<void>();
		const { session, sessionManager } = await sessionOverOwnedFile(tempDir, pi => {
			pi.on("session_moved", async () => {
				firstStarted.resolve();
				await firstMayFinish.promise;
			});
			pi.on("session_moved", async () => {
				order.push("second handler started");
			});
		});
		// The runner gives up on the first handler after 300 ms, as it would
		// after 30 s, and would then start the second.
		testSetExtensionHandlerTimeoutMs(300);
		try {
			sessionManager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
			await sessionManager.flush();
			await firstStarted.promise;
			await session.dispose();
			order.push("disposed");
			await Bun.sleep(1_000);
			expect(order).toEqual(["disposed"]);
		} finally {
			testSetExtensionHandlerTimeoutMs(30_000);
			firstMayFinish.resolve();
		}
	}, 30_000);

	it("announces a move its exit record makes, before session_shutdown", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		const events: string[] = [];
		const { session, sessionManager } = await sessionOverOwnedFile(
			tempDir,
			pi => {
				pi.on("session_moved", async event => {
					events.push(`session_moved to ${event.sessionId}`);
				});
				pi.on("session_shutdown", async () => {
					events.push(`session_shutdown as ${sessionManager.getSessionId()}`);
				});
			},
			[],
			{},
			// An earlier exchange, so the exit has something to record.
			owner => {
				owner.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() });
				owner.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "earlier answer" }],
					api: "mock",
					provider: "mock",
					model: "mock-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				} as AssistantMessage);
			},
		);
		const before = sessionManager.getSessionId();
		// Nothing written by this process yet: the exit record is its first
		// write, so it is the one that finds the owner and moves.
		await session.dispose();
		const after = sessionManager.getSessionId();
		expect(after).not.toBe(before);
		expect(events).toEqual([`session_moved to ${after}`, `session_shutdown as ${after}`]);
	}, 30_000);
});
