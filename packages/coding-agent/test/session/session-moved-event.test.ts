import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentContext, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { SessionEvent } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { AgentSession, SESSION_MOVED_HANDLER_GRACE_MS } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

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

/**
 * File storage that refuses the first two session ids it is asked to claim
 * and claims every later one: the owner's id, then the id the session first
 * moves to, so the second write moves it again.
 */
class StorageRefusingFirstTwoIds extends FileSessionStorage {
	readonly #refused = new Set<string>();

	override claimSession(sessionId: string, sessionPath: string): (() => void) | null {
		if (this.#refused.size < 2) this.#refused.add(sessionId);
		return this.#refused.has(sessionId) ? null : super.claimSession(sessionId, sessionPath);
	}
}

/**
 * Holds every timer of `SESSION_MOVED_HANDLER_GRACE_MS` until `fire()` runs
 * it, so an outcome never depends on how long a loaded host takes between two
 * steps: only a handler finishing, or `fire()`, ends a wait for the handlers.
 * Each move starts one such timer for its gate, and each wait for the
 * handlers starts one for its deadline when it first meets a gate.
 */
function holdGraceTimers() {
	const held = new Map<object, () => void>();
	let heldSoFar = 0;
	const watchers = new Set<{ count: number; reached: () => void }>();
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: (...args: unknown[]) => void,
		ms?: number,
		...args: unknown[]
	) => {
		if (ms !== SESSION_MOVED_HANDLER_GRACE_MS) return realSetTimeout(callback, ms, ...args);
		const token = { unref: () => token, ref: () => token, hasRef: () => false };
		held.set(token, () => callback(...args));
		heldSoFar++;
		for (const watcher of watchers) {
			if (heldSoFar < watcher.count) continue;
			watchers.delete(watcher);
			watcher.reached();
		}
		return token;
	}) as unknown as typeof setTimeout);
	const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((token?: unknown) => {
		if (typeof token === "object" && token !== null && held.delete(token)) return;
		realClearTimeout(token as Parameters<typeof clearTimeout>[0]);
	}) as typeof clearTimeout);
	return {
		/** Settles once `count` grace timers have been started since this began holding them. */
		untilStarted(count: number): Promise<void> {
			const { promise, resolve } = Promise.withResolvers<void>();
			if (heldSoFar >= count) resolve();
			else watchers.add({ count, reached: resolve });
			return promise;
		},
		/** Runs every held timer now, as if its two seconds had passed. */
		fire(): void {
			const callbacks = [...held.values()];
			held.clear();
			for (const callback of callbacks) callback();
		},
		[Symbol.dispose](): void {
			setSpy.mockRestore();
			clearSpy.mockRestore();
		},
	};
}

/** Settles after the event loop's next turn, once every microtask queued before it has run. */
function nextEventLoopTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** How many times the session said it went on with `session_moved` handlers still running. */
function goneOnWarnings(warn: { mock: { calls: unknown[][] } }): number {
	return warn.mock.calls.filter(
		([message]) => typeof message === "string" && message.startsWith("session_moved handlers still running"),
	).length;
}

describe("a session that had to leave its file", () => {
	// A test that times out never reaches its own `using` disposal: restore
	// every spy here, so a held timer cannot leak into the next test.
	afterEach(() => {
		mock.restore();
	});

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
	 * process may claim — by default every id but the owner's. As the SDK does,
	 * the agent's context transform runs the extensions' `context` handlers.
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
		const runner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
				convertToLlm,
				streamFn: mock.stream,
				transformContext: (messages, signal) => runner.emitContext(messages, signal),
			}),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner: runner,
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
			// The grace runs from the move, which happens inside this write. The
			// handler starts only after the write has finished, which under load
			// can be tens of milliseconds later, so the bounds count from here.
			const moving = performance.now();
			sessionManager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
			await sessionManager.flush();
			await handlerStarted.promise;

			// Without a cancellation: the tool-call hook and a real prompt's model
			// request each wait two seconds — the figure the documentation gives —
			// then go ahead with the handler still running.
			let modelAt = 0;
			const stream = session.agent.streamFn;
			session.agent.streamFn = (...args) => {
				modelAt ||= performance.now();
				return stream(...args);
			};
			const [tool, request] = await Promise.all([
				within(7_000, toolGate(session, probe)),
				within(
					7_000,
					session.prompt("go").then(() => "went ahead"),
				),
			]);
			expect([tool, request]).toEqual(["went ahead", "went ahead"]);
			expect(modelAt - moving).toBeGreaterThanOrEqual(1_950);
			expect(performance.now() - moving).toBeGreaterThanOrEqual(1_950);
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

	it("starts no session_moved handler once the session is disposed, while the running one's own code goes on", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		const order: string[] = [];
		const firstStarted = Promise.withResolvers<void>();
		const firstMayFinish = Promise.withResolvers<void>();
		const firstWentOn = Promise.withResolvers<void>();
		const { session, sessionManager } = await sessionOverOwnedFile(tempDir, pi => {
			pi.on("session_moved", async () => {
				firstStarted.resolve();
				await firstMayFinish.promise;
				order.push("first handler went on");
				firstWentOn.resolve();
			});
			pi.on("session_moved", async () => {
				order.push("second handler started");
			});
		});
		try {
			sessionManager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
			await sessionManager.flush();
			await firstStarted.promise;
			await session.dispose();
			order.push("disposed");
			// The first handler returns now, as one that ignores the disposal
			// would: a runner that waited for it would start the second next.
			firstMayFinish.resolve();
			await firstWentOn.promise;
			await nextEventLoopTurn();
			expect(order).toEqual(["disposed", "first handler went on"]);
		} finally {
			firstMayFinish.resolve();
		}
	}, 30_000);

	it("holds the model request for a move a context hook makes while the request is prepared", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		using timers = holdGraceTimers();
		const order: string[] = [];
		const moveMayFinish = Promise.withResolvers<void>();
		const modelRequested = Promise.withResolvers<void>();
		const writer: { manager?: SessionManager } = {};
		const { session, sessionManager } = await sessionOverOwnedFile(tempDir, pi => {
			pi.on("context", async () => {
				if (order.includes("context")) return;
				// Persisting state here is the session's first write, so it moves the session.
				order.push("context");
				writer.manager?.appendCustomEntry("context-state", {});
				await writer.manager?.flush();
			});
			pi.on("session_moved", async () => {
				order.push("move started");
				await moveMayFinish.promise;
				order.push("move finished");
			});
		});
		writer.manager = sessionManager;
		const stream = session.agent.streamFn;
		session.agent.streamFn = (...args) => {
			order.push("model request");
			modelRequested.resolve();
			return stream(...args);
		};
		try {
			const turn = session.prompt("go");
			// The move's gate starts one grace timer; a request that waits for
			// the handlers starts the second. Without a wait, the request is sent.
			await Promise.race([modelRequested.promise, timers.untilStarted(2)]);
			expect(order).toEqual(["context", "move started"]);
			moveMayFinish.resolve();
			await turn;
			expect(order).toEqual(["context", "move started", "move finished", "model request"]);
		} finally {
			moveMayFinish.resolve();
			await session.dispose();
		}
	}, 30_000);

	it("holds the model request for the move handlers when a host has replaced the agent's context transform", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		using timers = holdGraceTimers();
		const order: string[] = [];
		const moveStarted = Promise.withResolvers<void>();
		const moveMayFinish = Promise.withResolvers<void>();
		const modelRequested = Promise.withResolvers<void>();
		const { session, sessionManager } = await sessionOverOwnedFile(tempDir, pi => {
			pi.on("session_moved", async () => {
				order.push("move started");
				moveStarted.resolve();
				await moveMayFinish.promise;
				order.push("move finished");
			});
		});
		const stream = session.agent.streamFn;
		session.agent.streamFn = (...args) => {
			order.push("model request");
			modelRequested.resolve();
			return stream(...args);
		};
		try {
			sessionManager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
			await sessionManager.flush();
			await moveStarted.promise;
			// A host wraps or swaps the transform after the session was built.
			session.agent.transformContext = async messages => messages;
			const turn = session.prompt("go");
			await Promise.race([modelRequested.promise, timers.untilStarted(2)]);
			expect(order).toEqual(["move started"]);
			moveMayFinish.resolve();
			await turn;
			expect(order).toEqual(["move started", "move finished", "model request"]);
		} finally {
			moveMayFinish.resolve();
			await session.dispose();
		}
	}, 30_000);

	it("starts a move's handlers after the previous move's when a handler's own write moves the session again", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		const order: string[] = [];
		const firstStarted = Promise.withResolvers<void>();
		const firstMayFinish = Promise.withResolvers<void>();
		const secondFinished = Promise.withResolvers<void>();
		const writer: { manager?: SessionManager } = {};
		let moves = 0;
		const { session, sessionManager } = await sessionOverOwnedFile(
			tempDir,
			pi => {
				pi.on("session_moved", async () => {
					const move = ++moves;
					order.push(`move ${move} started`);
					if (move === 1) {
						firstStarted.resolve();
						// Rekeying state synchronously, as the event's contract asks,
						// is a write, and this one moves the session again.
						try {
							writer.manager?.appendCustomEntry("rekeyed", {});
							writer.manager?.flushSync();
						} catch (error) {
							order.push(`handler write failed: ${String(error)}`);
						}
						await firstMayFinish.promise;
					}
					order.push(`move ${move} finished`);
					if (move === 2) secondFinished.resolve();
				});
			},
			[],
			{},
			() => {},
			() => new StorageRefusingFirstTwoIds(),
		);
		writer.manager = sessionManager;
		try {
			let writeError: string | undefined;
			try {
				sessionManager.appendCustomEntry("first write", {});
				sessionManager.flushSync();
			} catch (error) {
				writeError = String(error);
			}
			await firstStarted.promise;
			await nextEventLoopTurn();
			expect(order).toEqual(["move 1 started"]);
			firstMayFinish.resolve();
			await secondFinished.promise;
			expect(order).toEqual(["move 1 started", "move 1 finished", "move 2 started", "move 2 finished"]);
			expect(writeError).toBeUndefined();
			// Disposal writes the exit record: it must meet no write conflict either.
			await session.dispose();
		} finally {
			firstMayFinish.resolve();
			// Cleanup only: an error here must not replace the assertion that failed above.
			await session.dispose().catch(() => {});
		}
	}, 30_000);

	it("warns that it went on without the handlers only when something waited for them", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		using timers = holdGraceTimers();
		const warn = spyOn(logger, "warn");
		const probe = probeTool([]);
		const handlerStarted = Promise.withResolvers<void>();
		const handlerMayFinish = Promise.withResolvers<void>();
		const { session, sessionManager } = await sessionOverOwnedFile(
			tempDir,
			pi => {
				pi.on("session_moved", async () => {
					handlerStarted.resolve();
					await handlerMayFinish.promise;
				});
			},
			[probe],
			{},
			() => {},
			// Nobody may claim any id, so every write moves the session again.
			() => new StorageOwnedByNobody(),
		);
		try {
			sessionManager.appendMessage({ role: "user", content: "move 1", timestamp: Date.now() });
			await sessionManager.flush();
			await handlerStarted.promise;
			// Two seconds pass with the handler running and nothing waiting.
			timers.fire();
			await nextEventLoopTurn();
			expect(goneOnWarnings(warn)).toBe(0);

			sessionManager.appendMessage({ role: "user", content: "move 2", timestamp: Date.now() });
			await sessionManager.flush();
			const gate = toolGate(session, probe);
			// The tool call waits, then two seconds pass.
			await timers.untilStarted(3);
			timers.fire();
			expect(await gate).toBe("went ahead");
			expect(goneOnWarnings(warn)).toBe(1);
		} finally {
			handlerMayFinish.resolve();
			await session.dispose();
		}
	}, 30_000);

	it("warns when a request goes on past a move whose handlers still run because its deadline passed while the context was prepared", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		using timers = holdGraceTimers();
		const warn = spyOn(logger, "warn");
		const order: string[] = [];
		const firstStarted = Promise.withResolvers<void>();
		const firstMayFinish = Promise.withResolvers<void>();
		const secondMayFinish = Promise.withResolvers<void>();
		const contextEntered = Promise.withResolvers<void>();
		const contextMayFinish = Promise.withResolvers<void>();
		const writer: { manager?: SessionManager } = {};
		let moves = 0;
		const { session, sessionManager } = await sessionOverOwnedFile(
			tempDir,
			pi => {
				pi.on("session_moved", async () => {
					const move = ++moves;
					order.push(`move ${move} started`);
					if (move === 1) {
						firstStarted.resolve();
						await firstMayFinish.promise;
					} else {
						await secondMayFinish.promise;
					}
					order.push(`move ${move} finished`);
				});
				pi.on("context", async () => {
					if (order.includes("context")) return;
					order.push("context");
					contextEntered.resolve();
					await contextMayFinish.promise;
					// This write moves the session again, with the request's deadline already passed.
					writer.manager?.appendCustomEntry("context-state", {});
					await writer.manager?.flush();
				});
			},
			[],
			{},
			() => {},
			() => new StorageRefusingFirstTwoIds(),
		);
		writer.manager = sessionManager;
		const stream = session.agent.streamFn;
		session.agent.streamFn = (...args) => {
			order.push("model request");
			return stream(...args);
		};
		try {
			sessionManager.appendCustomEntry("first write", {});
			await sessionManager.flush();
			await firstStarted.promise;
			const turn = session.prompt("go");
			// The move's gate starts one grace timer, the request's wait for it the second.
			await timers.untilStarted(2);
			// The first handler finishes: the wait before the context is prepared ends normally.
			firstMayFinish.resolve();
			await contextEntered.promise;
			// The request's two seconds pass while the context is still being prepared.
			timers.fire();
			contextMayFinish.resolve();
			await turn;
			expect(order.slice(0, 3)).toEqual(["move 1 started", "move 1 finished", "context"]);
			expect(order).toContain("move 2 started");
			expect(order).toContain("model request");
			expect(order).not.toContain("move 2 finished");
			expect(goneOnWarnings(warn)).toBe(1);
		} finally {
			firstMayFinish.resolve();
			contextMayFinish.resolve();
			secondMayFinish.resolve();
			await session.dispose().catch(() => {});
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
