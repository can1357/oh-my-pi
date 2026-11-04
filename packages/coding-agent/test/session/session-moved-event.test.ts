import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
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
import { SessionManager, type SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
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

/**
 * File storage that, once `original` is set, holds every full asynchronous
 * rewrite of any other file — the file the session moves to — before it is
 * published, until `publish` resolves. With `contestOriginal`, every full
 * rewrite of `original` meets another writer's change instead, so the session
 * ends up moving off it ("contested").
 */
class StorageHoldingMovedWrites extends StorageWithForeignOwner {
	original?: string;
	contestOriginal = false;
	readonly heldWrite = Promise.withResolvers<void>();
	readonly publish = Promise.withResolvers<void>();

	override async writeTextAtomic(
		sessionFile: string,
		body: string,
		options?: Parameters<FileSessionStorage["writeTextAtomic"]>[2],
	): Promise<void> {
		const original = this.original;
		if (original !== undefined && path.resolve(sessionFile) !== path.resolve(original)) {
			this.heldWrite.resolve();
			await this.publish.promise;
		} else if (original !== undefined && this.contestOriginal) {
			const expected = options?.expectedSize ?? 0;
			throw new SessionWriteConflictError(sessionFile, expected, expected + 1);
		}
		await super.writeTextAtomic(sessionFile, body, options);
	}
}

/**
 * File storage that, once `original` is set, lets the full asynchronous
 * rewrite of any other file — the file the session moves to — land its
 * bytes and then holds the write's return until `go` resolves: the publish
 * is on disk, its readback still to come.
 */
class StorageHoldingLandedMove extends StorageWithForeignOwner {
	original?: string;
	readonly landed = Promise.withResolvers<void>();
	readonly go = Promise.withResolvers<void>();

	override async writeTextAtomic(
		sessionFile: string,
		body: string,
		options?: Parameters<FileSessionStorage["writeTextAtomic"]>[2],
	): Promise<void> {
		await super.writeTextAtomic(sessionFile, body, options);
		const original = this.original;
		if (original !== undefined && path.resolve(sessionFile) !== path.resolve(original)) {
			this.landed.resolve();
			await this.go.promise;
		}
	}
}

/** File storage on which this process can claim no session id, so every write moves the session. */
class StorageOwnedByNobody extends FileSessionStorage {
	override claimSession(): (() => void) | null {
		return null;
	}
}

/** {@link StorageOwnedByNobody} that, once `failNext` is set, fails the next full publish before writing anything. */
class StorageFailingNextPublish extends StorageOwnedByNobody {
	failNext = false;

	override async writeTextAtomic(
		sessionFile: string,
		body: string,
		options?: Parameters<FileSessionStorage["writeTextAtomic"]>[2],
	): Promise<void> {
		if (this.failNext) {
			this.failNext = false;
			throw new Error("injected publish failure");
		}
		await super.writeTextAtomic(sessionFile, body, options);
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
 * File storage on which this process may claim every id, so writes stay put
 * until `contested` is set: then every full write of that file, synchronous
 * or not, meets another writer's change, and the session moves off it.
 */
class StorageWithContestedFile extends FileSessionStorage {
	contested?: string;

	#refuseContested(sessionFile: string, options?: { expectedSize?: number | null }): void {
		const contested = this.contested;
		if (contested === undefined || path.resolve(sessionFile) !== path.resolve(contested)) return;
		const expected = options?.expectedSize ?? 0;
		throw new SessionWriteConflictError(sessionFile, expected, expected + 1);
	}

	override writeTextSync(
		sessionFile: string,
		body: string,
		options?: Parameters<FileSessionStorage["writeTextSync"]>[2],
	): void {
		this.#refuseContested(sessionFile, options);
		super.writeTextSync(sessionFile, body, options);
	}

	override async writeTextAtomic(
		sessionFile: string,
		body: string,
		options?: Parameters<FileSessionStorage["writeTextAtomic"]>[2],
	): Promise<void> {
		this.#refuseContested(sessionFile, options);
		await super.writeTextAtomic(sessionFile, body, options);
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
	/** Every grace timer started, in start order. */
	const started: object[] = [];
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
		started.push(token);
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
		/** How many grace timers have been started since this began holding them. */
		get started(): number {
			return heldSoFar;
		},
		/** Runs every held timer now, as if its two seconds had passed. */
		fire(): void {
			const callbacks = [...held.values()];
			held.clear();
			for (const callback of callbacks) callback();
		},
		/** Runs only the `nth` grace timer started (from 1) now, if it is still held, as if its two seconds had passed. */
		fireStarted(nth: number): void {
			const token = started[nth - 1];
			const callback = token === undefined ? undefined : held.get(token);
			if (!token || !callback) return;
			held.delete(token);
			callback();
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
			const movedSessionFile = sessionManager.getSessionFile();
			expect(movedSessionFile).toBeDefined();
			if (!movedSessionFile) throw new Error("Expected the moved session to have a file");

			expect(events).toEqual([
				{
					type: "session_moved",
					reason: "open-elsewhere",
					previousSessionId: sessionId,
					sessionId: sessionManager.getSessionId(),
					previousSessionFile: sessionFile,
					sessionFile: movedSessionFile,
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
	 * `host` runs on the agent before the session is built around it.
	 */
	async function sessionOverOwnedFile(
		tempDir: TempDir,
		register: Parameters<typeof loadExtensionFromFactory>[0],
		tools: AgentTool[] = [],
		responses: Parameters<typeof createMockModel>[0] = {},
		seed: (owner: SessionManager) => void = () => {},
		storage: (ownerId: string) => FileSessionStorage = ownerId => new StorageWithForeignOwner(ownerId),
		host: (agent: Agent, sessionManager: SessionManager) => void = () => {},
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
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			streamFn: mock.stream,
			transformContext: (messages, signal) => runner.emitContext(messages, signal),
		});
		host(agent, sessionManager);
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner: runner,
		});
		return { session, sessionManager };
	}

	const schema = type({});

	it("lets a cancelled request stop waiting for the session_moved handlers at once", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		using timers = holdGraceTimers();
		const order: string[] = [];
		const handlerStarted = Promise.withResolvers<void>();
		const handlerMayFinish = Promise.withResolvers<void>();
		const { session, sessionManager } = await sessionOverOwnedFile(tempDir, pi => {
			pi.on("session_moved", async () => {
				order.push("handler started");
				handlerStarted.resolve();
				await handlerMayFinish.promise;
				order.push("handler finished");
			});
		});
		const stream = session.agent.streamFn;
		session.agent.streamFn = (...args) => {
			order.push("model request");
			return stream(...args);
		};
		try {
			sessionManager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
			await sessionManager.flush();
			await handlerStarted.promise;
			const turn = session.prompt("go");
			// The move's gate starts one grace timer; the request, held for it, the second.
			await timers.untilStarted(2);
			// The grace never passes and the handler never returns: only the
			// cancellation can end this turn.
			await session.abort();
			await turn.catch(() => undefined);
			expect(order).toEqual(["handler started"]);
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
		const { session, sessionManager } = await sessionOverOwnedFile(tempDir, pi => {
			pi.on("session_moved", async () => {
				handlerStarted.resolve(performance.now());
				await handlerMayFinish.promise;
				order.push("handler finished");
			});
			pi.on("session_shutdown", async () => {
				order.push("shutdown");
			});
		});
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

			// Without a cancellation: a real prompt's model request waits two
			// seconds — the figure the documentation gives — then goes ahead
			// with the handler still running.
			let modelAt = 0;
			const stream = session.agent.streamFn;
			session.agent.streamFn = (...args) => {
				modelAt ||= performance.now();
				return stream(...args);
			};
			const request = await within(
				7_000,
				session.prompt("go").then(() => "went ahead"),
			);
			expect(request).toBe("went ahead");
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
		const handlerMayFinish = Promise.withResolvers<void>();
		const { session, sessionManager } = await sessionOverOwnedFile(
			tempDir,
			pi => {
				pi.on("session_moved", async () => {
					await handlerMayFinish.promise;
				});
			},
			[],
			{},
			() => {},
			// Nobody may claim any id, so every write moves the session again.
			() => new StorageOwnedByNobody(),
		);
		const requested = Promise.withResolvers<number>();
		let waiting = true;
		const stream = session.agent.streamFn;
		session.agent.streamFn = (...args) => {
			waiting = false;
			requested.resolve(performance.now());
			return stream(...args);
		};
		try {
			sessionManager.appendMessage({ role: "user", content: "move 0", timestamp: Date.now() });
			await sessionManager.flush();
			const started = performance.now();
			const turn = session.prompt("go");
			// A move every 300 ms, each with a grace of its own, for up to 7 s.
			for (let n = 1; waiting && performance.now() - started < 7_000; n++) {
				await Bun.sleep(300);
				sessionManager.appendMessage({ role: "user", content: `move ${n}`, timestamp: Date.now() });
				await sessionManager.flush();
			}
			expect(waiting).toBe(false);
			expect((await requested.promise) - started).toBeLessThan(3_000);
			await turn;
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

	it("starts no session_moved handler after disposal, while moveWritten reports the file a publish in flight at disposal wrote", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		const handled: string[] = [];
		let storage: StorageHoldingLandedMove | undefined;
		const { session, sessionManager } = await sessionOverOwnedFile(
			tempDir,
			pi => {
				pi.on("session_moved", event => {
					handled.push(event.sessionId);
				});
			},
			[],
			{},
			() => {},
			ownerId => (storage = new StorageHoldingLandedMove(ownerId)),
		);
		if (!storage) throw new Error("Expected the session's storage");
		const held = storage;
		const notices: SessionPersistenceNotice[] = [];
		sessionManager.onPersistenceNotice(notice => notices.push(notice));
		held.original = sessionManager.getSessionFile();
		const rewrite = sessionManager.rewriteEntries().catch(() => undefined);
		let disposing: Promise<void> | undefined;
		try {
			await held.landed.promise;
			expect(notices).toHaveLength(1);
			const [notice] = notices;
			const sealed = Promise.withResolvers<void>();
			const seal = sessionManager.seal.bind(sessionManager);
			spyOn(sessionManager, "seal").mockImplementation(() => {
				seal();
				sealed.resolve();
			});
			disposing = session.dispose();
			await sealed.promise;
			// Disposed, with the moved file's bytes on disk and its readback still to come.
			expect(sessionManager.moveWritten(notice)).toBeUndefined();
			held.go.resolve();
			await rewrite;
			await disposing;
			await nextEventLoopTurn();
			// The durable fact: the file holds the moved session's transcript...
			expect(sessionManager.moveWritten(notice)).toBe(true);
			expect(fs.readFileSync(notice.to, "utf8")).toContain(`"id":"${notice.sessionId}"`);
			// ...and the session, disposed first, never ran a handler for it.
			expect(handled).toEqual([]);
		} finally {
			held.go.resolve();
			await rewrite;
			await (disposing ?? session.dispose());
		}
	}, 30_000);

	/**
	 * A session over a file another process owns, as {@link sessionOverOwnedFile},
	 * built to send side requests: `prepare` runs at each step that prepares one
	 * — the session's context transform, its message conversion, the agent's
	 * provider-context transform — and `onSend` when the side stream is called.
	 */
	async function sessionForSideRequests(
		tempDir: TempDir,
		register: Parameters<typeof loadExtensionFromFactory>[0],
		storage: (ownerId: string) => FileSessionStorage,
		prepare: (step: "the context transform" | "the message conversion" | "the provider-context transform") => unknown,
		onSend: () => void,
	) {
		const sessionDir = path.join(tempDir.path(), "sessions");
		const owner = SessionManager.create(tempDir.path(), sessionDir, new FileSessionStorage());
		owner.appendMessage({ role: "user", content: "the owner's turn", timestamp: Date.now() });
		await owner.ensureOnDisk();
		await owner.flush();
		const sessionFile = owner.getSessionFile();
		const ownerId = owner.getSessionId();
		if (!sessionFile) throw new Error("Expected a persisted session");
		await owner.close();
		const sessionManager = await SessionManager.open(sessionFile, sessionDir, storage(ownerId), {
			suppressBreadcrumb: true,
		});
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(register, tempDir.path(), new EventBus(), runtime, "moves");
		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: mock.stream,
				transformProviderContext: async context => {
					await prepare("the provider-context transform");
					return context;
				},
			}),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner: new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry),
			transformContext: async messages => {
				await prepare("the context transform");
				return messages;
			},
			convertToLlm: async messages => {
				await prepare("the message conversion");
				return convertToLlm(messages);
			},
			sideStreamFn: (...args) => {
				onSend();
				return mock.stream(...args);
			},
		});
		return { session, sessionManager };
	}

	/**
	 * A side request (`runEphemeralTurn`, as `/btw` sends one) prepared after
	 * nothing moved the session: wherever a write while it is prepared moves
	 * it — the session's context transform, the configured message conversion,
	 * the agent's provider-context transform — the request waits for that
	 * move's handlers at its send.
	 */
	for (const at of ["the context transform", "the message conversion", "the provider-context transform"] as const) {
		it(`holds a side request for a move made by ${at} while it is prepared`, async () => {
			using tempDir = TempDir.createSync("@omp-session-moved-");
			using timers = holdGraceTimers();
			const order: string[] = [];
			const moveStarted = Promise.withResolvers<void>();
			const moveMayFinish = Promise.withResolvers<void>();
			const sent = Promise.withResolvers<void>();
			const writer: { manager?: SessionManager } = {};
			const { session, sessionManager } = await sessionForSideRequests(
				tempDir,
				pi => {
					pi.on("session_moved", async () => {
						order.push("move started");
						moveStarted.resolve();
						await moveMayFinish.promise;
						order.push("move finished");
					});
				},
				ownerId => new StorageWithForeignOwner(ownerId),
				// This session's first write finds the file owned by another process, so it moves the session.
				step => {
					if (step !== at || order.includes("moved")) return;
					order.push("moved");
					writer.manager?.appendCustomEntry("side-request-state", {});
				},
				() => {
					order.push("side request");
					sent.resolve();
				},
			);
			writer.manager = sessionManager;
			try {
				const turn = session.runEphemeralTurn({ promptText: "explain the owner's turn", tools: false });
				// The move's gate starts one grace timer; the request held for it, the
				// second. A side request sent first, or a turn that ends first, has
				// gone wrong: say how.
				await Promise.race([
					sent.promise,
					Promise.all([moveStarted.promise, timers.untilStarted(2)]),
					turn.catch(() => undefined),
				]);
				expect(order).toEqual(["moved", "move started"]);
				moveMayFinish.resolve();
				await turn;
				expect(order).toEqual(["moved", "move started", "move finished", "side request"]);
			} finally {
				moveMayFinish.resolve();
				await session.dispose();
			}
		}, 30_000);
	}

	it("bounds a side request's waits for the move handlers by one grace in all, before its context transform and at its send", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		using timers = holdGraceTimers();
		const warn = spyOn(logger, "warn");
		const order: string[] = [];
		const firstStarted = Promise.withResolvers<void>();
		const firstMayFinish = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const secondMayFinish = Promise.withResolvers<void>();
		const sent = Promise.withResolvers<void>();
		const writer: { manager?: SessionManager } = {};
		let moves = 0;
		const { session, sessionManager } = await sessionForSideRequests(
			tempDir,
			pi => {
				pi.on("session_moved", async () => {
					const move = ++moves;
					order.push(`move ${move} started`);
					if (move === 1) {
						firstStarted.resolve();
						await firstMayFinish.promise;
					} else {
						secondStarted.resolve();
						await secondMayFinish.promise;
					}
					order.push(`move ${move} finished`);
				});
			},
			() => new StorageRefusingFirstTwoIds(),
			// The conversion runs after the wait before the context transform; its
			// write moves the session again.
			async step => {
				if (step !== "the message conversion" || order.includes("moved again")) return;
				order.push("moved again");
				writer.manager?.appendCustomEntry("side-request-state", {});
				await writer.manager?.flush();
			},
			() => {
				order.push("side request");
				sent.resolve();
			},
		);
		writer.manager = sessionManager;
		let turn: Promise<unknown> | undefined;
		try {
			sessionManager.appendCustomEntry("first write", {});
			await sessionManager.flush();
			await firstStarted.promise;
			turn = session.runEphemeralTurn({ promptText: "explain the owner's turn", tools: false });
			// The first move's gate starts one grace timer; the side request, held
			// for it before its context transform, the second: its deadline.
			await timers.untilStarted(2);
			// The first handler finishes: that wait ends without the deadline.
			firstMayFinish.resolve();
			// The conversion moves the session again; that move's gate starts the
			// third timer, and the request waits for its handler at the send.
			await Promise.race([
				sent.promise,
				Promise.all([secondStarted.promise, timers.untilStarted(3)]),
				turn.catch(() => undefined),
			]);
			expect(order).toEqual(["move 1 started", "move 1 finished", "moved again", "move 2 started"]);
			// Two seconds pass from the first gate the request met: its one deadline.
			timers.fireStarted(2);
			// It goes on — or, waiting at its send on a deadline of its own, starts
			// a fourth timer: that is a second grace.
			await Promise.race([sent.promise, timers.untilStarted(4), turn.catch(() => undefined)]);
			// It goes on with the second handler still running, and says so once.
			expect(order).toEqual(["move 1 started", "move 1 finished", "moved again", "move 2 started", "side request"]);
			expect(goneOnWarnings(warn)).toBe(1);
			expect(timers.started).toBe(3);
			await turn;
		} finally {
			firstMayFinish.resolve();
			secondMayFinish.resolve();
			await turn?.catch(() => undefined);
			await session.dispose();
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
			[],
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
			const turn = session.prompt("go");
			// The model request waits, then two seconds pass.
			await timers.untilStarted(3);
			timers.fire();
			await turn;
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

	it.each([
		{ path: "a full rewrite that finds the file owned by another process", reason: "open-elsewhere" },
		{ path: "a full rewrite that loses every race for the file to another writer", reason: "contested" },
	] as const)(
		"starts no session_moved handler until $path has published the new file",
		async ({ reason }) => {
			using tempDir = TempDir.createSync("@omp-session-moved-");
			const seen: { reason: string; fileExisted: boolean }[] = [];
			const handlerStarted = Promise.withResolvers<void>();
			let storage: StorageHoldingMovedWrites | undefined;
			const { session, sessionManager } = await sessionOverOwnedFile(
				tempDir,
				pi => {
					pi.on("session_moved", event => {
						seen.push({ reason: event.reason, fileExisted: fs.existsSync(event.sessionFile) });
						handlerStarted.resolve();
					});
				},
				[],
				{},
				() => {},
				// "contested": this process may claim the owner's id, so only the races move it.
				ownerId => (storage = new StorageHoldingMovedWrites(reason === "open-elsewhere" ? ownerId : "")),
			);
			if (!storage) throw new Error("Expected the session's storage");
			try {
				storage.original = sessionManager.getSessionFile();
				storage.contestOriginal = reason === "contested";
				const rewrite = sessionManager.rewriteEntries();
				await storage.heldWrite.promise;
				// The session has moved and its new file is being written, not yet published.
				expect(sessionManager.getSessionFile()).not.toBe(storage.original);
				await nextEventLoopTurn();
				await nextEventLoopTurn();
				expect(seen).toEqual([]);
				storage.publish.resolve();
				await rewrite;
				await handlerStarted.promise;
				expect(seen).toEqual([{ reason, fileExisted: true }]);
			} finally {
				storage.publish.resolve();
				await session.dispose();
			}
		},
		30_000,
	);

	/**
	 * Every place a host or an extension can write while a model request or a
	 * tool call is prepared, and so move the session. Whichever it is, the
	 * request or call waits for that move's handlers: until they finish, or
	 * until its two seconds are up, when it goes on and says so once.
	 */
	const preparationWrites = [
		{ effect: "model request", at: "a context handler" },
		{ effect: "model request", at: "a host transform that replaced the agent's, before it delegates" },
		{ effect: "model request", at: "a host transform that replaced the agent's, after it delegates" },
		{ effect: "model request", at: "a host before-model-call hook added before the session" },
		{ effect: "model request", at: "a host before-model-call hook added after the session" },
		{ effect: "model request", at: "a host before-model-call gate" },
		{ effect: "tool call", at: "the model's answer, before its tool call" },
		{ effect: "tool call", at: "the model's answer, with the session's tool-call hook replaced" },
		{ effect: "tool call", at: "a host hook that replaced the session's tool-call hook" },
		{ effect: "tool call", at: "a tool_call handler" },
		{ effect: "tool call", at: "an earlier tool call in the batch" },
	] as const;
	type WriteSite = (typeof preparationWrites)[number]["at"];

	for (const { effect, at } of preparationWrites) {
		for (const until of ["its handlers finish", "its grace passes"] as const) {
			it(`holds the ${effect} for a move made by ${at} until ${until}`, async () => {
				using tempDir = TempDir.createSync("@omp-session-moved-");
				using timers = holdGraceTimers();
				const warn = spyOn(logger, "warn");
				const order: string[] = [];
				const moveStarted = Promise.withResolvers<void>();
				const moveMayFinish = Promise.withResolvers<void>();
				const effectStarted = Promise.withResolvers<void>();
				const moving: { move?: () => Promise<void> } = {};
				const moveAt = async (site: WriteSite): Promise<void> => {
					if (site !== at || order.includes("moved")) return;
					order.push("moved");
					await moving.move?.();
				};
				const ok = { content: [{ type: "text" as const, text: "ok" }], details: {} };
				const probe: AgentTool<typeof schema> = {
					name: "probe",
					label: "Probe",
					description: "Records when it runs",
					parameters: schema,
					concurrency: "exclusive",
					async execute() {
						order.push("effect");
						effectStarted.resolve();
						return ok;
					},
				};
				const earlier: AgentTool<typeof schema> = {
					name: "earlier",
					label: "Earlier",
					description: "Writes while it runs",
					parameters: schema,
					concurrency: "exclusive",
					async execute() {
						await moveAt("an earlier tool call in the batch");
						return ok;
					},
				};
				const toolCalls = [
					...(at === "an earlier tool call in the batch"
						? [{ type: "toolCall" as const, name: "earlier", arguments: {} }]
						: []),
					{ type: "toolCall" as const, name: "probe", arguments: {} },
				];
				let storage: StorageWithContestedFile | undefined;
				const { session, sessionManager } = await sessionOverOwnedFile(
					tempDir,
					pi => {
						pi.on("session_moved", async () => {
							order.push("move started");
							moveStarted.resolve();
							await moveMayFinish.promise;
							order.push("move finished");
						});
						pi.on("context", async () => {
							await moveAt("a context handler");
						});
						pi.on("tool_call", async () => {
							await moveAt("a tool_call handler");
						});
					},
					[earlier, probe],
					{
						responses:
							effect === "tool call"
								? [
										async () => {
											await moveAt("the model's answer, before its tool call");
											await moveAt("the model's answer, with the session's tool-call hook replaced");
											return { content: toolCalls };
										},
										{ content: ["done"] },
									]
								: [{ content: ["done"] }],
					},
					() => {},
					() => (storage = new StorageWithContestedFile()),
					agent => {
						agent.addBeforeModelCallHook(() => moveAt("a host before-model-call hook added before the session"));
					},
				);
				// A full write that meets another writer's change moves the session:
				// one move, here. The session's own writes of the turn can race this
				// rewrite to the contested file; whichever gets there first moves the
				// session, and the rewrite that lost reports the conflict it met.
				moving.move = async () => {
					if (!storage) throw new Error("Expected the session's storage");
					const contested = sessionManager.getSessionFile();
					storage.contested = contested;
					try {
						await sessionManager.rewriteEntries();
					} catch (error) {
						if (sessionManager.getSessionFile() === contested) throw error;
					} finally {
						storage.contested = undefined;
					}
				};
				const agent = session.agent;
				agent.addBeforeModelCallHook(() => moveAt("a host before-model-call hook added after the session"));
				agent.addBeforeModelCall(() => moveAt("a host before-model-call gate"));
				const transform = agent.transformContext;
				agent.transformContext = async (messages, signal) => {
					await moveAt("a host transform that replaced the agent's, before it delegates");
					const prepared = transform ? await transform(messages, signal) : messages;
					await moveAt("a host transform that replaced the agent's, after it delegates");
					return prepared;
				};
				if (
					at === "a host hook that replaced the session's tool-call hook" ||
					at === "the model's answer, with the session's tool-call hook replaced"
				) {
					agent.beforeToolCall = async () => {
						await moveAt("a host hook that replaced the session's tool-call hook");
						return undefined;
					};
				}
				const stream = agent.streamFn;
				agent.streamFn = (...args) => {
					if (effect === "model request" && order.includes("moved") && !order.includes("effect")) {
						order.push("effect");
						effectStarted.resolve();
					}
					return stream(...args);
				};
				try {
					const turn = session.prompt("go");
					// The move's gate starts one grace timer; the request or call held for
					// it, the second. A turn that ends first has gone wrong: say how.
					await Promise.race([
						effectStarted.promise,
						Promise.all([moveStarted.promise, timers.untilStarted(2)]),
						turn.catch(() => undefined),
					]);
					expect(order).toEqual(["moved", "move started"]);
					if (until === "its handlers finish") {
						moveMayFinish.resolve();
						await turn;
						expect(order).toEqual(["moved", "move started", "move finished", "effect"]);
						expect(goneOnWarnings(warn)).toBe(0);
					} else {
						timers.fire();
						await effectStarted.promise;
						expect(order).toEqual(["moved", "move started", "effect"]);
						moveMayFinish.resolve();
						await turn;
						expect(goneOnWarnings(warn)).toBe(1);
					}
				} finally {
					moveMayFinish.resolve();
					await session.dispose();
				}
			}, 30_000);
		}
	}

	/**
	 * Two moves in a row through a live session, each published by the atomic
	 * rewrite or the repair, each publish succeeding or failing: a handler runs
	 * for exactly the moves whose own file holds their transcript, in move
	 * order, once each — never for a move only a later move's file was
	 * written for.
	 */
	for (const firstWriter of ["atomic", "repair"] as const) {
		for (const firstFails of [false, true]) {
			it(`runs handlers only for moves whose own file was written: ${firstWriter} ${firstFails ? "failing" : "publishing"}, then every second publish`, async () => {
				for (const secondWriter of ["atomic", "repair"] as const) {
					for (const secondFails of [false, true]) {
						using tempDir = TempDir.createSync("@omp-session-moved-");
						const seen: { sessionId: string; holdsIt: boolean }[] = [];
						const notices: SessionPersistenceNotice[] = [];
						let storage: StorageFailingNextPublish | undefined;
						const { session, sessionManager } = await sessionOverOwnedFile(
							tempDir,
							pi => {
								pi.on("session_moved", event => {
									const onDisk = fs.existsSync(event.sessionFile)
										? fs.readFileSync(event.sessionFile, "utf8")
										: "";
									seen.push({
										sessionId: event.sessionId,
										holdsIt: onDisk.includes(`"id":"${event.sessionId}"`),
									});
								});
							},
							[],
							{},
							() => {},
							() => (storage = new StorageFailingNextPublish()),
						);
						sessionManager.onPersistenceNotice(notice => notices.push(notice));
						try {
							for (const [writer, fails] of [
								[firstWriter, firstFails],
								[secondWriter, secondFails],
							] as const) {
								if (storage) storage.failNext = fails;
								await (
									writer === "atomic"
										? sessionManager.rewriteEntries()
										: sessionManager.recoverPersistenceFromCurrentState()
								).catch(() => undefined);
								await nextEventLoopTurn();
							}
							await nextEventLoopTurn();
							const written = notices.filter(notice => sessionManager.moveWritten(notice) === true);
							expect(notices.length).toBeGreaterThan(0);
							expect(seen).toEqual(written.map(notice => ({ sessionId: notice.sessionId, holdsIt: true })));
							if (firstFails && secondWriter === "repair" && !secondFails) {
								// The first move's file was never written; the repair moved again
								// and wrote the second. Only the second move's handler runs.
								expect(notices.map(notice => sessionManager.moveWritten(notice))).toEqual([false, true]);
							}
						} finally {
							await session.dispose().catch(() => undefined);
						}
					}
				}
			}, 60_000);
		}
	}

	it("warns when a request goes on past a move whose own grace ended while the context was prepared", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		using timers = holdGraceTimers();
		const warn = spyOn(logger, "warn");
		const order: string[] = [];
		const firstStarted = Promise.withResolvers<void>();
		const firstMayFinish = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const secondMayFinish = Promise.withResolvers<void>();
		const contextEntered = Promise.withResolvers<void>();
		const contextMayPersist = Promise.withResolvers<void>();
		const contextPersisted = Promise.withResolvers<void>();
		const contextMayReturn = Promise.withResolvers<void>();
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
						secondStarted.resolve();
						await secondMayFinish.promise;
					}
					order.push(`move ${move} finished`);
				});
				pi.on("context", async () => {
					if (order.includes("context")) return;
					order.push("context");
					contextEntered.resolve();
					await contextMayPersist.promise;
					// This write moves the session again.
					writer.manager?.appendCustomEntry("context-state", {});
					await writer.manager?.flush();
					contextPersisted.resolve();
					await contextMayReturn.promise;
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
			// The first move's gate starts one grace timer, the request's wait for it the second.
			await timers.untilStarted(2);
			// The first handler finishes: the wait before the context is prepared ends without a warning.
			firstMayFinish.resolve();
			await contextEntered.promise;
			contextMayPersist.resolve();
			await Promise.all([contextPersisted.promise, secondStarted.promise]);
			// Two seconds pass: the request's deadline, and the second move's own grace, which opens its gate.
			timers.fire();
			await nextEventLoopTurn();
			contextMayReturn.resolve();
			await turn;
			expect(order).toContain("model request");
			expect(order).not.toContain("move 2 finished");
			expect(goneOnWarnings(warn)).toBe(1);
		} finally {
			firstMayFinish.resolve();
			contextMayPersist.resolve();
			contextMayReturn.resolve();
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
