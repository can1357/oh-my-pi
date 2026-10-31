import { describe, expect, it } from "bun:test";
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
	 * owner, before this process opens it.
	 */
	async function sessionOverOwnedFile(
		tempDir: TempDir,
		register: Parameters<typeof loadExtensionFromFactory>[0],
		tools: AgentTool[] = [],
		responses: Parameters<typeof createMockModel>[0] = {},
		seed: (owner: SessionManager) => void = () => {},
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
		const sessionManager = await SessionManager.open(
			sessionFile,
			sessionDir,
			new StorageWithForeignOwner(sessionId),
			{
				suppressBreadcrumb: true,
			},
		);
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

	it("runs no tool under the new id until the session_moved handlers have finished", async () => {
		using tempDir = TempDir.createSync("@omp-session-moved-");
		const order: string[] = [];
		const handlerStarted = Promise.withResolvers<void>();
		const handlerMayFinish = Promise.withResolvers<void>();
		const schema = type({});
		const probe: AgentTool<typeof schema> = {
			name: "probe",
			label: "Probe",
			description: "Records when it runs",
			parameters: schema,
			async execute() {
				order.push("tool ran");
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
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

			// The hook the agent loop runs before every tool call, asked while
			// the handler is still running by a caller that is cancelled: one
			// that waits for the handler can only answer with the cancellation.
			const cancelled = AbortSignal.abort(new Error("cancelled by the caller"));
			const toolCall = { type: "toolCall" as const, id: "probe-1", name: "probe", arguments: {} };
			const gate = await Promise.resolve(
				session.agent.beforeToolCall?.(
					{
						assistantMessage: { role: "assistant", content: [toolCall] } as unknown as AssistantMessage,
						toolCall,
						tool: probe as AgentTool,
						args: {},
						context: { systemPrompt: [], messages: [], tools: [] } as unknown as AgentContext,
					},
					cancelled,
				),
			).then(
				() => "went ahead",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			expect(gate).toBe("cancelled by the caller");

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
