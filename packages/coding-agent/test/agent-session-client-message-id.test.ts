import { afterEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadedCustomCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { dispatchRpcSkillPrompt } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import {
	RpcExtensionUserMessageTracker,
	RpcPromptResults,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-prompt-results";
import {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type PromptOptions,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm, VIBE_MODE_CONTEXT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// The proposed SDK boundary is deliberately entry/event metadata, not AgentMessage metadata.
interface ClientMessageStatus {
	messages: { clientMessageId: string; message: AgentMessage }[];
	queuedMessages: {
		steering: readonly string[];
		followUp: readonly string[];
		liveSteered: number;
		clientMessageIds?: { steering: (string | null)[]; followUp: (string | null)[] };
	};
	resolvedClientMessageIds: string[];
	persistedClientMessageIds: string[];
	unresolvedClientMessageIds: string[];
}
type CorrelatedSession = AgentSession & {
	getClientMessageStatus(ids: readonly string[], maxBytes: number): Promise<ClientMessageStatus>;
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function setup(
	options: {
		manager?: SessionManager;
		responses?: MockResponseSource;
		config?: Partial<AgentSessionConfig>;
	} = {},
) {
	const directory = TempDir.createSync("@client-message-id-");
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("anthropic", "test-key");
	const manager = options.manager ?? SessionManager.inMemory(directory.path());
	const mock = createMockModel({ responses: options.responses, handler: { content: ["done"] } });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			systemPrompt: ["Test"],
			tools: [],
			messages: manager.buildSessionContext().messages,
		},
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		modelRegistry: new ModelRegistry(auth, path.join(directory.path(), "models.yml")),
		autoTitle: false,
		...options.config,
	}) as CorrelatedSession;
	cleanup.push(async () => {
		await session.dispose();
		auth.close();
		directory.removeSync();
	});
	const events: AgentSessionEvent[] = [];
	session.subscribe(event => {
		events.push(event);
	});
	return { session, manager, mock, events, directory };
}

function intent(clientMessageId: string): PromptOptions & { clientMessageId: string } {
	return { clientMessageId };
}

const STATUS_BYTES = 16 * 1024 * 1024;

async function status(session: CorrelatedSession, ids: readonly string[]) {
	expect(typeof session.getClientMessageStatus).toBe("function");
	return session.getClientMessageStatus(ids, STATUS_BYTES);
}

function expectNoProviderMetadata(mock: { calls: { context: { messages: unknown[] } }[] }, ids: string[]) {
	for (const call of mock.calls) {
		const payload = JSON.stringify(call.context.messages);
		expect(payload).not.toContain("clientMessageId");
		for (const id of ids) expect(payload).not.toContain(id);
	}
}

describe("AgentSession client intent identity", () => {
	test("identifies two identical idle prompts in events and persisted entries without exposing IDs to the model", async () => {
		const { session, manager, mock, events } = setup();
		await session.prompt("same request", intent("intent-idle-a"));
		await session.prompt("same request", intent("intent-idle-b"));
		await session.settleInFlightMessagePersistence();
		const userEvents = events.filter(
			event => (event.type === "message_start" || event.type === "message_end") && event.message.role === "user",
		);
		expect(userEvents).toMatchObject([
			{ type: "message_start", clientMessageId: "intent-idle-a" },
			{ type: "message_end", clientMessageId: "intent-idle-a" },
			{ type: "message_start", clientMessageId: "intent-idle-b" },
			{ type: "message_end", clientMessageId: "intent-idle-b" },
		]);
		const entries = manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user");
		expect(entries).toMatchObject([{ clientMessageId: "intent-idle-a" }, { clientMessageId: "intent-idle-b" }]);
		for (const message of session.messages) expect(message).not.toHaveProperty("clientMessageId");
		const found = await status(session, ["intent-idle-b", "never-submitted"]);
		expect(found.messages.map(item => item.clientMessageId)).toEqual(["intent-idle-b"]);
		expect<unknown>(found.messages[0]?.message).toBe(session.messages.findLast(message => message.role === "user"));
		expect(found.persistedClientMessageIds).toEqual(["intent-idle-b"]);
		expect(found.resolvedClientMessageIds).toEqual([]);
		expect(found.unresolvedClientMessageIds).toEqual(["never-submitted"]);
		expect(mock.calls).toHaveLength(2);
		expectNoProviderMetadata(mock, ["intent-idle-a", "intent-idle-b"]);
	});

	test("journals both IDs when identical prompts share a millisecond", async () => {
		const { session, manager } = setup();
		vi.spyOn(Date, "now").mockReturnValue(Date.now());
		await session.prompt("same request", intent("intent-same-ms-a"));
		await session.prompt("same request", intent("intent-same-ms-b"));
		await session.settleInFlightMessagePersistence();
		const entries = manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user");
		expect(entries).toMatchObject([{ clientMessageId: "intent-same-ms-a" }, { clientMessageId: "intent-same-ms-b" }]);
		const found = await status(session, ["intent-same-ms-a", "intent-same-ms-b"]);
		expect(found.persistedClientMessageIds).toEqual(["intent-same-ms-a", "intent-same-ms-b"]);
	});

	test("resolves a session-switching command's ID in the session that admitted it", async () => {
		const disk = TempDir.createSync("@client-message-command-switch-");
		const auth = createInMemoryAuthStorage();
		cleanup.push(async () => {
			auth.close();
			disk.removeSync();
		});
		const manager = SessionManager.create(disk.path(), disk.path());
		const created = Promise.withResolvers<CorrelatedSession>();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerCommand("fresh", {
					handler: async () => {
						await (await created.promise).newSession();
					},
				});
			},
			disk.path(),
			new EventBus(),
			runtime,
			"fresh-command",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			runtime,
			disk.path(),
			manager,
			new ModelRegistry(auth, path.join(disk.path(), "models.yml")),
		);
		const { session } = setup({ manager, config: { extensionRunner } });
		created.resolve(session);
		const origin = manager.getSessionFile();
		if (!origin) throw new Error("Expected a persistent origin session");
		expect(await session.prompt("/fresh", intent("intent-command"))).toBe(false);
		expect(manager.getSessionFile()).not.toBe(origin);
		// The destination never saw this ID, so it accepts it as a fresh intent.
		await session.followUp("fresh in destination", undefined, intent("intent-command"));
		expect(session.getQueuedMessages().clientMessageIds).toEqual({ steering: [], followUp: ["intent-command"] });
		const reopened = await SessionManager.open(origin, undefined, undefined, { throwIfMissing: true });
		expect(reopened.isClientMessageResolved("intent-command")).toBe(true);
	});

	test("resolves a command's ID when it only rotates the provider session (/fresh)", async () => {
		const disk = TempDir.createSync("@client-message-command-fresh-");
		const auth = createInMemoryAuthStorage();
		cleanup.push(async () => {
			auth.close();
			disk.removeSync();
		});
		const manager = SessionManager.inMemory(disk.path());
		const created = Promise.withResolvers<CorrelatedSession>();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerCommand("rotate", {
					handler: async () => {
						(await created.promise).freshSession();
					},
				});
			},
			disk.path(),
			new EventBus(),
			runtime,
			"rotate-command",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			runtime,
			disk.path(),
			manager,
			new ModelRegistry(auth, path.join(disk.path(), "models.yml")),
		);
		const { session } = setup({ manager, config: { extensionRunner } });
		created.resolve(session);
		const providerSessionId = session.sessionId;
		expect(await session.prompt("/rotate", intent("intent-fresh"))).toBe(false);
		expect(session.sessionId).not.toBe(providerSessionId);
		const found = await status(session, ["intent-fresh"]);
		expect(found.resolvedClientMessageIds).toEqual(["intent-fresh"]);
		expect(found.unresolvedClientMessageIds).toEqual([]);
	});

	test("a command still running after switching sessions never resolves a newer input reusing its ID", async () => {
		const disk = TempDir.createSync("@client-message-stale-finish-");
		const auth = createInMemoryAuthStorage();
		cleanup.push(async () => {
			auth.close();
			disk.removeSync();
		});
		const manager = SessionManager.create(disk.path(), disk.path());
		const created = Promise.withResolvers<CorrelatedSession>();
		const switched = Promise.withResolvers<void>();
		const finishMove = Promise.withResolvers<void>();
		const expanding = Promise.withResolvers<void>();
		const finishExpand = Promise.withResolvers<void>();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerCommand("move", {
					handler: async () => {
						await (await created.promise).newSession();
						switched.resolve();
						await finishMove.promise;
					},
				});
			},
			disk.path(),
			new EventBus(),
			runtime,
			"move-command",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			runtime,
			disk.path(),
			manager,
			new ModelRegistry(auth, path.join(disk.path(), "models.yml")),
		);
		const expand: LoadedCustomCommand = {
			path: "expand",
			resolvedPath: "expand",
			source: "user",
			command: {
				name: "expand",
				description: "Expands into a prompt after a delay",
				execute: async () => {
					expanding.resolve();
					await finishExpand.promise;
					return "expanded request";
				},
			},
		};
		const { session } = setup({ manager, config: { extensionRunner, customCommands: [expand] } });
		created.resolve(session);
		const moving = session.prompt("/move", intent("intent-reused"));
		await withTimeout(switched.promise, 5_000, "The command never switched sessions");
		// The new session never saw the ID, so a new input may reuse it while the old command still runs.
		const expanded = session.prompt("/expand", intent("intent-reused"));
		await withTimeout(expanding.promise, 5_000, "The custom command never started");
		finishMove.resolve();
		expect(await moving).toBe(false);
		finishExpand.resolve();
		await expanded;
		const found = await status(session, ["intent-reused"]);
		expect(found.resolvedClientMessageIds).toEqual([]);
		expect(found.persistedClientMessageIds).toEqual(["intent-reused"]);
	});

	test("an unrelated transition leaves a custom command that is still expanding unresolved", async () => {
		const expanding = Promise.withResolvers<void>();
		const finishExpand = Promise.withResolvers<void>();
		const expand: LoadedCustomCommand = {
			path: "expand",
			resolvedPath: "expand",
			source: "user",
			command: {
				name: "expand",
				description: "Expands into a prompt after a delay",
				execute: async () => {
					expanding.resolve();
					await finishExpand.promise;
					return "expanded request";
				},
			},
		};
		const { session } = setup({ config: { customCommands: [expand] } });
		const expanded = session.prompt("/expand", intent("intent-expanding"));
		await withTimeout(expanding.promise, 5_000, "The custom command never started");
		// Starts a transition, then refuses: it is not the command's, so it must not consume the input.
		await expect(session.branch("missing-entry")).rejects.toThrow("Invalid entry ID for branching");
		finishExpand.resolve();
		await expanded;
		await session.settleInFlightMessagePersistence();
		const found = await status(session, ["intent-expanding"]);
		expect(found.resolvedClientMessageIds).toEqual([]);
		expect(found.persistedClientMessageIds).toEqual(["intent-expanding"]);
	});

	test("a custom command that finishes locally after an unrelated session change resolves in its admitting session", async () => {
		const disk = TempDir.createSync("@client-message-deferred-finish-");
		cleanup.push(async () => disk.removeSync());
		const running = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const local: LoadedCustomCommand = {
			path: "local",
			resolvedPath: "local",
			source: "user",
			command: {
				name: "local",
				description: "Handles the input itself after a delay",
				execute: async () => {
					running.resolve();
					await finish.promise;
				},
			},
		};
		const manager = SessionManager.create(disk.path(), disk.path());
		const { session } = setup({ manager, config: { customCommands: [local] } });
		await session.prompt("history so the admitting session stays on disk");
		const origin = manager.getSessionFile();
		if (!origin) throw new Error("Expected a persistent origin session");
		const handled = session.prompt("/local", intent("intent-deferred"));
		await withTimeout(running.promise, 5_000, "The custom command never started");
		expect(await session.newSession()).toBe(true);
		finish.resolve();
		expect(await handled).toBe(false);
		const reopened = await SessionManager.open(origin, undefined, undefined, { throwIfMissing: true });
		expect(reopened.isClientMessageResolved("intent-deferred")).toBe(true);
		// The destination never admitted the input, so its ID stays free there.
		expect(manager.isClientMessageResolved("intent-deferred")).toBe(false);
	});

	test("refuses a deferred resolution for a journal another process owns instead of moving it", async () => {
		const disk = TempDir.createSync("@client-message-owned-origin-");
		cleanup.push(async () => disk.removeSync());
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(disk.path(), disk.path(), storage);
		manager.appendCustomEntry("history", {}, { forceFileCreation: true });
		await manager.flush();
		const origin = manager.getSessionFile();
		const originId = manager.getSessionId();
		if (!origin) throw new Error("Expected a persistent origin session");
		await manager.newSession();
		const claim = storage.claimSession.bind(storage);
		const owned = vi
			.spyOn(storage, "claimSession")
			.mockImplementation((sessionId, sessionPath) =>
				sessionId === originId ? null : claim(sessionId, sessionPath),
			);
		const journals = () => Array.from(new Bun.Glob("**/*.jsonl").scanSync(disk.path())).sort();
		const filesBefore = journals();
		await expect(manager.resolveClientMessagesInJournal(origin, ["intent-owned"])).rejects.toThrow(
			"owned by another process",
		);
		// Refused, not moved off: no continuation journal appeared.
		expect(journals()).toEqual(filesBefore);
		owned.mockRestore();
		await manager.resolveClientMessagesInJournal(origin, ["intent-owned"]);
		const reopened = await SessionManager.open(origin, undefined, undefined, { throwIfMissing: true });
		expect(reopened.isClientMessageResolved("intent-owned")).toBe(true);
		await manager.close();
	});

	test("a custom expansion retargeted by a session change cannot reuse an ID the destination took", async () => {
		const expanding = Promise.withResolvers<void>();
		const finishExpand = Promise.withResolvers<void>();
		const expand: LoadedCustomCommand = {
			path: "expand",
			resolvedPath: "expand",
			source: "user",
			command: {
				name: "expand",
				description: "Expands into a prompt after a delay",
				execute: async () => {
					expanding.resolve();
					await finishExpand.promise;
					return "expanded request";
				},
			},
		};
		const { session, manager } = setup({ config: { customCommands: [expand] } });
		const expanded = session.prompt("/expand", intent("intent-retargeted"));
		await withTimeout(expanding.promise, 5_000, "The custom command never started");
		expect(await session.newSession()).toBe(true);
		// The destination never saw the ID, so a new prompt there may take it.
		await session.prompt("destination request", intent("intent-retargeted"));
		finishExpand.resolve();
		await expect(expanded).rejects.toThrow("clientMessageId already submitted: intent-retargeted");
		await session.settleInFlightMessagePersistence();
		const carriers = manager
			.getEntries()
			.filter(entry => entry.type === "message" && entry.clientMessageId !== undefined);
		expect(carriers.map(entry => entry.type === "message" && entry.message.role)).toEqual(["user"]);
	});

	test("a queued follow-up keeps its ID taken after a branch changes the journal", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session, manager } = setup({
			responses: [
				async () => ({ content: ["first done"] }),
				async () => {
					entered.resolve();
					await release.promise;
					return { content: ["done"] };
				},
			],
		});
		cleanup.push(async () => release.resolve());
		await session.prompt("first");
		const firstUser = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
		if (!firstUser) throw new Error("Expected a journaled first prompt");
		const running = session.prompt("second");
		await withTimeout(entered.promise, 5_000, "Provider did not reach the held response");
		await session.followUp("queued", undefined, intent("intent-queued"));
		const journal = manager.getSessionId();
		expect((await session.branch(firstUser.id)).cancelled).toBe(false);
		expect(manager.getSessionId()).not.toBe(journal);
		expect(session.getQueuedMessages().clientMessageIds?.followUp).toEqual(["intent-queued"]);
		await expect(session.followUp("duplicate", undefined, intent("intent-queued"))).rejects.toThrow(
			"clientMessageId already submitted: intent-queued",
		);
		release.resolve();
		await running.catch(() => {});
	});

	test.each([
		["released", (manager: SessionManager) => manager.releaseRetainedEntries()],
		["replaced by a new session", (manager: SessionManager) => manager.newSession()],
	])("lets a journal %s be collected after its client message IDs were indexed", async (_, leave) => {
		const manager = SessionManager.inMemory("/cwd");
		const entry = (() => {
			manager.appendMessage(
				{ role: "user", content: "x".repeat(64 * 1024), attribution: "user", timestamp: Date.now() },
				{ clientMessageId: "intent-released" },
			);
			expect(manager.hasClientMessageEntry("intent-released")).toBe(true);
			return new WeakRef(manager.getEntries()[0]!);
		})();
		await leave(manager);
		// Not a timing guess: a WeakRef target stays alive until the current task ends, so yield one task.
		await Bun.sleep(0);
		Bun.gc(true);
		expect(entry.deref()).toBeUndefined();
	});

	test("materializes a correlated first user entry before the assistant produces any output", async () => {
		const disk = TempDir.createSync("@client-message-first-entry-");
		cleanup.push(async () => disk.removeSync());
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session, manager } = setup({
			manager: SessionManager.create(disk.path(), disk.path()),
			responses: [
				async () => {
					entered.resolve();
					await release.promise;
					return { content: ["done"] };
				},
			],
		});
		const running = session.prompt("first input", intent("intent-before-reply"));
		try {
			await withTimeout(entered.promise, 5_000, "Provider did not reach the held first response");
			const found = await status(session, ["intent-before-reply"]);
			expect(found.persistedClientMessageIds).toEqual(["intent-before-reply"]);
			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected a correlated first-user journal");
			const journal = await Bun.file(file).text();
			expect(journal).toContain('"clientMessageId":"intent-before-reply"');
			expect(journal).not.toContain('"role":"assistant"');
			expect(session.isStreaming).toBe(true);
		} finally {
			release.resolve();
			await running;
		}
	});

	test("keeps IDs aligned through template expansion, legacy null slots and follow-up promotion", async () => {
		const { session, events, mock } = setup({
			config: {
				promptTemplates: [{ name: "review", description: "Review", content: "Review $ARGUMENTS", source: "test" }],
			},
		});
		await session.followUp("legacy request");
		await session.followUp("/review queue", undefined, intent("intent-template"));
		expect(session.getQueuedMessages()).toMatchObject({
			followUp: ["legacy request", "Review queue"],
			clientMessageIds: { steering: [], followUp: [null, "intent-template"] },
		});
		expect(session.promoteQueuedMessage("/review queue")).toBe(true);
		expect(session.getQueuedMessages()).toMatchObject({
			steering: ["Review queue"],
			followUp: ["legacy request"],
			clientMessageIds: { steering: ["intent-template"], followUp: [null] },
		});
		await session.waitForIdle();
		const found = await status(session, ["intent-template"]);
		expect(found.messages).toMatchObject([
			{
				clientMessageId: "intent-template",
				message: { role: "user", content: [{ type: "text", text: "Review queue" }] },
			},
		]);
		expect(found.resolvedClientMessageIds).toEqual([]);
		expect(events.filter(event => event.type === "message_end")).toContainEqual(
			expect.objectContaining({ clientMessageId: "intent-template" }),
		);
		expectNoProviderMetadata(mock, ["intent-template"]);
	});

	test("emits a queue_update when identical chip texts exchange only their IDs", async () => {
		const { session, events } = setup();
		await session.followUp("duplicate", undefined, intent("intent-queue-a"));
		await session.followUp("duplicate", undefined, intent("intent-queue-b"));
		const before = events.filter(event => event.type === "queue_update").length;
		const queued = session.agent.peekFollowUpQueue();
		session.agent.replaceQueues([], [queued[1], queued[0]]);
		expect(events.filter(event => event.type === "queue_update")).toHaveLength(before + 1);
		expect(events.at(-1)).toMatchObject({
			type: "queue_update",
			followUp: ["duplicate", "duplicate"],
			clientMessageIds: { steering: [], followUp: ["intent-queue-b", "intent-queue-a"] },
		});
	});

	test("keeps an RPC-expanded queued skill's identity through delivery, custom persistence and reopen", async () => {
		const disk = TempDir.createSync("@client-message-resume-");
		cleanup.push(async () => disk.removeSync());
		const skillPath = path.join(disk.path(), "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);
		const manager = SessionManager.create(disk.path(), disk.path());
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session, mock } = setup({
			manager,
			responses: [
				async () => {
					entered.resolve();
					await release.promise;
					return { content: ["first done"] };
				},
			],
			config: {
				skills: [
					{
						name: "reviewer",
						description: "Review code",
						filePath: skillPath,
						baseDir: disk.path(),
						source: "project",
					},
				],
				skillsSettings: { enableSkillCommands: true },
			},
		});
		const running = session.prompt("before the skill", intent("intent-resume-user"));
		const results = new RpcPromptResults(session, () => {});
		session.subscribe(event => results.observe(event));
		const request = {
			ticket: results.begin("rpc-skill-request"),
			results,
			session,
			message: "/skill:reviewer inspect risks",
			streamingBehavior: "followUp" as const,
			clientMessageId: "intent-skill",
			onError: (error: Error) => {
				throw error;
			},
			extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
		};
		try {
			await withTimeout(entered.promise, 5_000, "Initial skill turn did not reach the model");
			await dispatchRpcSkillPrompt(request);
			expect(session.getQueuedMessages()).toMatchObject({
				followUp: ["/skill:reviewer inspect risks"],
				clientMessageIds: { steering: [], followUp: ["intent-skill"] },
			});
		} finally {
			release.resolve();
			await running;
		}
		await session.waitForIdle();
		await session.settleInFlightMessagePersistence();
		await manager.flush();
		expect(
			manager.getEntries().find(entry => entry.type === "custom_message" && entry.customType === "skill-prompt"),
		).toMatchObject({
			clientMessageId: "intent-skill",
			content: expect.stringContaining("Review the supplied code carefully."),
		});
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected a persisted skill session");
		const journal = await Bun.file(file).text();
		expect(journal).toContain('"clientMessageId":"intent-skill"');
		await session.dispose();
		const resumed = setup({ manager: await SessionManager.open(file) });
		const found = await status(resumed.session, ["intent-resume-user", "intent-skill", "unknown-after-reopen"]);
		expect(found.persistedClientMessageIds).toEqual(["intent-resume-user", "intent-skill"]);
		expect(found.resolvedClientMessageIds).toEqual([]);
		expect(found.unresolvedClientMessageIds).toEqual(["unknown-after-reopen"]);
		await expect(resumed.session.prompt("reuse persisted identity", intent("intent-resume-user"))).rejects.toThrow(
			"already submitted",
		);
		await resumed.session.prompt("continue review");
		expectNoProviderMetadata(mock, ["intent-resume-user", "intent-skill"]);
		expectNoProviderMetadata(resumed.mock, ["intent-resume-user", "intent-skill"]);
	});

	test("records explicit withdrawals durably, never treating a missing or merely queued ID as resolved", async () => {
		const disk = TempDir.createSync("@client-message-withdraw-");
		cleanup.push(async () => disk.removeSync());
		const { session, manager } = setup({ manager: SessionManager.create(disk.path(), disk.path()) });
		await session.followUp("duplicate", undefined, intent("intent-removed"));
		await session.followUp("duplicate", undefined, intent("intent-survivor"));
		expect(session.removeQueuedMessage("duplicate", "followUp")).toBe(true);
		const found = await status(session, ["intent-removed", "intent-survivor", "never-seen"]);
		expect(found.resolvedClientMessageIds).toEqual(["intent-removed"]);
		expect(found.persistedClientMessageIds).toEqual([]);
		expect(found.unresolvedClientMessageIds).toEqual(["never-seen"]);
		expect(found.queuedMessages).toMatchObject({
			followUp: ["duplicate"],
			clientMessageIds: { followUp: ["intent-survivor"] },
		});
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected withdrawal to create a durable session entry");
		await manager.flush();
		expect(await Bun.file(file).exists()).toBe(true);
		expect(await Bun.file(file).text()).toContain('"customType":"client-message-resolution"');
		expect(manager.buildSessionContext().messages).toEqual([]);
		await session.dispose();
		const resumed = setup({
			manager: await SessionManager.open(file, undefined, undefined, { throwIfMissing: true }),
		});
		const after = await status(resumed.session, ["intent-removed", "intent-survivor"]);
		expect(after.resolvedClientMessageIds).toEqual(["intent-removed"]);
		expect(after.unresolvedClientMessageIds).toEqual(["intent-survivor"]);
		await expect(resumed.session.followUp("reuse withdrawal", undefined, intent("intent-removed"))).rejects.toThrow(
			"already resolved",
		);
	});

	test("resolves identity-drop, identity-withdrawal, editor-pop and clear through their distinct removal paths", async () => {
		const { session } = setup();
		let dropped: readonly AgentMessage[] = [];
		await session.followUp("drop by identity", undefined, {
			...intent("intent-drop"),
			onPromptQueued: messages => {
				dropped = messages;
			},
		});
		await session.followUp("pop me", undefined, intent("intent-pop"));
		session.dropQueuedMessages(dropped);
		let withdrawn: readonly AgentMessage[] = [];
		await session.followUp("withdraw by identity", undefined, {
			...intent("intent-withdraw"),
			onPromptQueued: messages => {
				withdrawn = messages;
			},
		});
		expect(session.withdrawQueuedMessage(withdrawn[withdrawn.length - 1])).toBe(true);
		expect(session.popLastQueuedMessage()).toMatchObject({ text: "pop me" });
		await session.followUp("clear me", undefined, intent("intent-clear"));
		session.clearQueue();
		const found = await status(session, ["intent-drop", "intent-pop", "intent-withdraw", "intent-clear"]);
		expect(found.resolvedClientMessageIds).toEqual(["intent-drop", "intent-pop", "intent-withdraw", "intent-clear"]);
		expect(found.unresolvedClientMessageIds).toEqual([]);
		expect(found.messages).toEqual([]);
	});

	test("withdraws queued input and returns it while an atomic journal batch refuses synchronous flushes", async () => {
		const disk = TempDir.createSync("@client-message-atomic-");
		cleanup.push(async () => disk.removeSync());
		const { session, manager } = setup({ manager: SessionManager.create(disk.path(), disk.path()) });
		await session.followUp("take me", undefined, intent("intent-taken"));
		await session.followUp("restore me", undefined, intent("intent-restored"));
		// The callback runs inside the staged batch, as an Esc restore during an atomic rewrite would.
		const { taken, restored } = await manager.appendEntriesAtomically(() => ({
			taken: session.takeQueuedMessage("take me", "followUp"),
			restored: session.clearQueue({ forInterrupt: true }),
		}));
		expect(taken).toMatchObject({ text: "take me" });
		expect(restored.followUp).toMatchObject([{ text: "restore me" }]);
		expect(session.getQueuedMessages()).toMatchObject({ steering: [], followUp: [] });
		const found = await status(session, ["intent-taken", "intent-restored"]);
		expect(found.resolvedClientMessageIds).toEqual(["intent-taken", "intent-restored"]);
		expect(found.unresolvedClientMessageIds).toEqual([]);
	});

	test("queries actual state during streaming without consuming queues or starting another turn", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session, mock } = setup({
			responses: [
				async () => {
					entered.resolve();
					await release.promise;
					return { content: ["done"] };
				},
			],
		});
		const running = session.prompt("long request", intent("intent-stream"));
		try {
			await withTimeout(entered.promise, 5_000, "Provider did not start");
			await session.followUp("wait for turn", undefined, intent("intent-waiting"));
			const messages = [...session.messages];
			const queue = session.getQueuedMessages();
			const found = await withTimeout(
				status(session, ["intent-stream", "intent-waiting", "unknown"]),
				1_000,
				"Status waited for the active turn",
			);
			expect(found.messages).toMatchObject([{ clientMessageId: "intent-stream", message: { role: "user" } }]);
			expect<unknown>(found.messages[0]?.message).toBe(messages.find(message => message.role === "user"));
			expect(found.queuedMessages).toEqual(queue);
			expect(found.unresolvedClientMessageIds).toEqual(["unknown"]);
			expect(session.messages).toEqual(messages);
			expect(session.getQueuedMessages()).toEqual(queue);
			expect(session.isStreaming).toBe(true);
			expect(mock.calls).toHaveLength(1);
		} finally {
			release.resolve();
			await running;
			await session.waitForIdle();
		}
	});

	test("rejects reuse of queued and resolved intent IDs instead of correlating a second input", async () => {
		const { session } = setup();
		await session.followUp("original", undefined, intent("intent-once"));
		await expect(session.followUp("different input", undefined, intent("intent-once"))).rejects.toThrow(
			"already submitted",
		);
		expect(session.getQueuedMessages()).toMatchObject({ followUp: ["original"] });
		expect(session.removeQueuedMessage("original", "followUp")).toBe(true);
		await expect(session.prompt("resubmit withdrawn input", intent("intent-once"))).rejects.toThrow(
			"already submitted",
		);
		const found = await status(session, ["intent-once"]);
		expect(found.resolvedClientMessageIds).toEqual(["intent-once"]);
		expect(found.messages).toEqual([]);
	});

	test("reserves an idle prompt's ID synchronously before asynchronous preparation", async () => {
		const { session } = setup();
		const first = session.prompt("first input", intent("intent-admitting"));
		await expect(session.followUp("second input", undefined, intent("intent-admitting"))).rejects.toThrow(
			"already submitted",
		);
		await first;
		await expect(session.prompt("third input", intent("intent-admitting"))).rejects.toThrow("already submitted");
		expect((await status(session, ["intent-admitting"])).messages).toMatchObject([
			{
				clientMessageId: "intent-admitting",
				message: { role: "user", content: [{ type: "text", text: "first input" }] },
			},
		]);
	});

	test("bounds combined native message payloads without truncating persisted representations", async () => {
		const { session } = setup();
		const padding = " ".repeat(6 * 1024 * 1024);
		await session.prompt(`${padding}first`, intent("intent-large-a"));
		await session.prompt(`${padding}second`, intent("intent-large-b"));
		await session.prompt(`${padding}third`, intent("intent-large-c"));
		const found = await status(session, ["intent-large-a", "intent-large-b", "intent-large-c"]);
		expect(found.messages.map(item => item.clientMessageId)).toEqual(["intent-large-a", "intent-large-b"]);
		expect(Buffer.byteLength(JSON.stringify(found), "utf8")).toBeLessThanOrEqual(STATUS_BYTES);
		expect<unknown>(found.messages[0]?.message).toBe(session.messages.find(message => message.role === "user"));
		expect(found.persistedClientMessageIds).toEqual(["intent-large-a", "intent-large-b", "intent-large-c"]);
		expect(found.resolvedClientMessageIds).toEqual([]);
		expect(found.unresolvedClientMessageIds).toEqual([]);
	});

	test("leaves an oversized nonpersisted native representation unresolved rather than shrinking or resolving it", async () => {
		const { session } = setup();
		const options = intent("intent-large-ephemeral");
		await session.promptCustomMessage(
			{
				customType: VIBE_MODE_CONTEXT_MESSAGE_TYPE,
				content: `${" ".repeat(16 * 1024 * 1024)}ephemeral context`,
				display: false,
				attribution: "user",
			},
			options,
		);
		const native = session.messages.find(
			message => message.role === "custom" && message.customType === VIBE_MODE_CONTEXT_MESSAGE_TYPE,
		);
		expect(native).toBeDefined();
		expect(Buffer.byteLength(JSON.stringify(native), "utf8")).toBeGreaterThan(16 * 1024 * 1024);
		const found = await status(session, ["intent-large-ephemeral"]);
		expect(found.messages).toEqual([]);
		expect(found.persistedClientMessageIds).toEqual([]);
		expect(found.resolvedClientMessageIds).toEqual([]);
		expect(found.unresolvedClientMessageIds).toEqual(["intent-large-ephemeral"]);
	});

	test("surfaces ordinary persistence failure instead of advertising an unconfirmed persisted ID", async () => {
		const { session, manager } = setup();
		await session.prompt("persist this", intent("intent-flush-failure"));
		vi.spyOn(manager, "flush").mockRejectedValueOnce(new Error("disk write failed"));
		await expect(status(session, ["intent-flush-failure"])).rejects.toThrow("disk write failed");
	});

	test("does not confirm an entry journaled while the status flush awaits storage", async () => {
		const storage = new MemorySessionStorage();
		const { session, manager } = setup({ manager: SessionManager.create("/cwd", "/sessions", storage) });
		await session.prompt("flushed before", intent("intent-flushed"));
		const draining = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(storage, "drain").mockImplementation(async () => {
			draining.resolve();
			await release.promise;
		});
		const pending = status(session, ["intent-flushed", "intent-late"]);
		await withTimeout(draining.promise, 2_000, "Status never drained storage");
		// Journaled after the flush handed its writes to storage, so this flush does not cover it.
		manager.appendMessage(
			{ role: "user", content: [{ type: "text", text: "late" }], attribution: "user", timestamp: Date.now() },
			{ clientMessageId: "intent-late" },
		);
		release.resolve();
		const found = await pending;
		expect(found.persistedClientMessageIds).toEqual(["intent-flushed"]);
		expect(found.unresolvedClientMessageIds).toEqual(["intent-late"]);
	});
});
