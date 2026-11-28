/**
 * A session storage that bounds its queued transcript appends
 * (`SessionStorage.waitForAppendAdmission`) holds an agent turn before each
 * model request and before the loop appends a result from `afterToolCall`.
 * An abort ends that wait at once.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const CALL_ID = "toolu_append_admission";
const TOOL_OUTPUT = [{ type: "text" as const, text: "fixture contents" }];
/**
 * Past what a case waits: three 30 ms holds of admission and the turns of a scripted model, a few
 * milliseconds each. A wait that never comes fails its case at this bound instead of hanging the file.
 */
const CASE_TIMEOUT_MS = 15_000;
/**
 * Past what teardown waits: disposing a session drains its post-prompt tasks for up to 5 s and its async
 * jobs and browser tabs for up to 3 s each, and a case disposes two sessions.
 */
const TEARDOWN_TIMEOUT_MS = 30_000;

/** One admission wait the storage has not granted yet. */
interface PendingAdmission {
	admit(): void;
}

/**
 * In-memory storage whose append admission stays closed until the test admits
 * each wait. A fired signal ends a wait, as the method's contract requires.
 */
class GatedAdmissionStorage extends MemorySessionStorage {
	/** The waits the test has not taken yet ({@link nextWait}), oldest first. */
	readonly #pending: PendingAdmission[] = [];
	/** Every wait not admitted yet, whether the test has taken it or not. */
	readonly #held = new Set<() => void>();
	#arrival: PromiseWithResolvers<void> | undefined;
	#released = false;

	waitForAppendAdmission(signal?: AbortSignal): Promise<void> {
		if (this.#released) return Promise.resolve();
		const admitted = Promise.withResolvers<void>();
		const admit = (): void => {
			this.#held.delete(admit);
			signal?.removeEventListener("abort", admit);
			admitted.resolve();
		};
		this.#held.add(admit);
		if (signal?.aborted) admit();
		else signal?.addEventListener("abort", admit, { once: true });
		this.#pending.push({ admit });
		this.#arrival?.resolve();
		return admitted.promise;
	}

	/**
	 * The next wait the session starts, once it has started it. Rejects once
	 * `prompt` settles with no wait left to take: the wait looked for can no
	 * longer come.
	 */
	async nextWait(prompt: Promise<unknown>): Promise<PendingAdmission> {
		let settled = false;
		const promptSettled = prompt.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		while (true) {
			const next = this.#pending.shift();
			if (next) return next;
			if (settled) throw new Error("The prompt settled without waiting for append admission");
			this.#arrival = Promise.withResolvers<void>();
			await Promise.race([this.#arrival.promise, promptSettled]);
		}
	}

	/**
	 * Admit every wait not admitted yet, also one the test took and has not
	 * admitted (a case that failed while it held one), and each later wait at
	 * once.
	 */
	releaseAll(): void {
		this.#released = true;
		this.#pending.length = 0;
		// Each admit deletes its own entry, which a Set's iteration allows.
		for (const admit of this.#held) admit();
	}
}

/**
 * Hold admission closed for a while before the test looks at the turn. Real time on purpose: what must not
 * happen (a request or append that skipped the wait) has no event to await, and the agent loop reaches its
 * next request through a timer turn of its own, so only letting real time pass would show it.
 */
function holdClosed(): Promise<void> {
	return Bun.sleep(30);
}

/** The tool results the session saved for the test's tool call. */
function savedToolResults(sessionManager: SessionManager): { content: unknown; isError: boolean }[] {
	return sessionManager
		.getEntries()
		.flatMap(entry =>
			entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === CALL_ID
				? [{ content: entry.message.content, isError: entry.message.isError }]
				: [],
		);
}

/** A session a case started, with its session manager, its scripted model, and how often its tool ran. */
interface StartedSession {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
	toolRuns: () => number;
}

describe("AgentSession waits for its storage's append admission", () => {
	/** What the running case acquired, each released after it, newest first, even when one before it throws. */
	let cleanup: AsyncDisposableStack;
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeEach(() => {
		cleanup = new AsyncDisposableStack();
		tempDir = cleanup.adopt(TempDir.createSync("@omp-append-admission-"), dir => dir.removeSync());
		authStorage = cleanup.adopt(createInMemoryAuthStorage(), storage => storage.close());
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	// Every cleanup runs, also after one throws, and their errors are thrown together once all have run.
	afterEach(() => cleanup.disposeAsync(), TEARDOWN_TIMEOUT_MS);

	/** A session over `storage` whose scripted model calls one tool, then answers. */
	function startSession(storage: SessionStorage): StartedSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		let toolRuns = 0;
		const tool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Reads the fixture",
			parameters: type({}),
			execute: async () => {
				toolRuns++;
				return { content: TOOL_OUTPUT };
			},
		};
		const mock = createMockModel({
			responses: [{ content: [{ type: "toolCall", id: CALL_ID, name: "read", arguments: {} }] }],
			handler: { content: ["done"] },
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [tool] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"), storage);
		// Disposing the session closes its session manager.
		const session = cleanup.adopt(
			new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			}),
			started => started.dispose(),
		);
		return { session, sessionManager, mock, toolRuns: () => toolRuns };
	}

	/**
	 * {@link startSession} over a {@link GatedAdmissionStorage}, whose waits
	 * teardown admits before it disposes the session, also after a case that
	 * failed while one was held.
	 */
	function startGatedSession(): StartedSession & { storage: GatedAdmissionStorage } {
		const storage = new GatedAdmissionStorage();
		const started = startSession(storage);
		// Released newest first: before the session is disposed.
		cleanup.defer(() => storage.releaseAll());
		return { ...started, storage };
	}

	it(
		"waits before each model request and before appending a tool result from afterToolCall",
		async () => {
			// If this regresses, a process whose SQL store falls behind keeps sending model requests and
			// queuing tool results, and the transcript lines it has queued grow its memory without bound.
			const gated = startGatedSession();
			const { storage } = gated;
			const prompt = gated.session.prompt("read the fixture");

			try {
				const beforeFirstRequest = await storage.nextWait(prompt);
				await holdClosed();
				expect(gated.mock.calls).toHaveLength(0);
				beforeFirstRequest.admit();

				const beforeToolResult = await storage.nextWait(prompt);
				await holdClosed();
				expect(gated.toolRuns()).toBe(1);
				expect(savedToolResults(gated.sessionManager)).toEqual([]);
				beforeToolResult.admit();

				const beforeSecondRequest = await storage.nextWait(prompt);
				await holdClosed();
				expect(savedToolResults(gated.sessionManager)).toEqual([{ content: TOOL_OUTPUT, isError: false }]);
				expect(gated.mock.calls).toHaveLength(1);
				beforeSecondRequest.admit();

				await prompt;
				await gated.session.waitForIdle();
			} finally {
				storage.releaseAll();
				await prompt;
				await storage.drain();
			}
			expect(gated.mock.calls).toHaveLength(2);

			const plainStorage = new MemorySessionStorage();
			const plain = startSession(plainStorage);
			await plain.session.prompt("read the fixture");
			await plain.session.waitForIdle();
			// What a resume reads back: each saved message's role and content.
			const storedMessages = async (manager: SessionManager, source: MemorySessionStorage) => {
				await manager.flush();
				const target = manager.getSessionFile();
				if (!target) throw new Error("Expected a persisted session");
				return parseSessionContent(await source.readText(target)).entries.flatMap(entry =>
					entry.type === "message"
						? [
								{
									role: entry.message.role,
									content: "content" in entry.message ? entry.message.content : undefined,
								},
							]
						: [],
				);
			};
			const gatedMessages = await storedMessages(gated.sessionManager, storage);
			expect(gatedMessages).toContainEqual({ role: "toolResult", content: TOOL_OUTPUT });
			expect(gatedMessages).toEqual(await storedMessages(plain.sessionManager, plainStorage));
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"keeps the completed tool result when its admission wait throws synchronously",
		async () => {
			class ThrowingAdmissionStorage extends MemorySessionStorage {
				waits = 0;

				waitForAppendAdmission(): Promise<void> {
					if (++this.waits === 2) throw new Error("admission unavailable");
					return Promise.resolve();
				}
			}
			const storage = new ThrowingAdmissionStorage();
			const { session, sessionManager, mock, toolRuns } = startSession(storage);
			await session.prompt("read the fixture");
			await session.waitForIdle();
			expect({ requests: mock.calls.length, waits: storage.waits, runs: toolRuns() }).toEqual({
				requests: 2,
				waits: 3,
				runs: 1,
			});
			expect(savedToolResults(sessionManager)).toEqual([{ content: TOOL_OUTPUT, isError: false }]);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"ends the admission wait when the turn is aborted",
		async () => {
			// If this regresses, pressing Esc while the SQL store is behind leaves the turn stuck until the
			// database catches up (here `abort()` never settles and the test times out), or the tool that
			// already ran loses its result to an error in the transcript.
			const gated = startGatedSession();
			const { storage } = gated;
			const prompt = gated.session.prompt("read the fixture");
			try {
				(await storage.nextWait(prompt)).admit();
				await storage.nextWait(prompt);
				expect(gated.toolRuns()).toBe(1);

				await gated.session.abort();
				await prompt;
			} finally {
				storage.releaseAll();
				await prompt;
				await storage.drain();
			}

			expect(gated.mock.calls).toHaveLength(1);
			expect(savedToolResults(gated.sessionManager)).toEqual([{ content: TOOL_OUTPUT, isError: false }]);
			const lastAssistant = gated.session.agent.state.messages.findLast(message => message.role === "assistant");
			expect(lastAssistant?.stopReason).toBe("aborted");
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"ends the admission wait before a model request when the turn is aborted",
		async () => {
			// If this regresses, pressing Esc while the SQL store is behind leaves a turn that has not yet
			// asked the model anything stuck until the database catches up (here `abort()` never settles
			// and the test times out).
			const gated = startGatedSession();
			const { storage } = gated;
			const prompt = gated.session.prompt("read the fixture");
			try {
				await storage.nextWait(prompt);
				await gated.session.abort();
				await prompt;
			} finally {
				storage.releaseAll();
				await prompt;
				await storage.drain();
			}

			expect(gated.mock.calls).toHaveLength(0);
			const lastAssistant = gated.session.agent.state.messages.findLast(message => message.role === "assistant");
			expect(lastAssistant?.stopReason).toBe("aborted");
		},
		CASE_TIMEOUT_MS,
	);
});
