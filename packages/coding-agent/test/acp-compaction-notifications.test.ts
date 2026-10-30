import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ACP_BOOTSTRAP_RACE_GUARD_MS, type AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { createAcpConnection } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	type Client,
	ClientSideConnection,
	ndJsonStream,
	type PromptResponse,
	type SessionNotification,
} from "@oh-my-pi/pi-utils/acp";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { drive, driveTurn, until, wait } from "./helpers/fake-clock";

const START = "_omp/compaction/start";
const END = "_omp/compaction/end";
const PRIVATE_SUMMARY = "private compaction summary, not a client notification";
const PRIVATE_TRANSCRIPT = "private transcript and archive contents";

type Notification = { method: string; params: Record<string, unknown> };
type WireMessage = Notification & { jsonrpc: string; id?: number | string; result?: unknown };
type CompactionGate = {
	entered: PromiseWithResolvers<void>;
	release: PromiseWithResolvers<void>;
};

function expectPrivateProjection(notifications: Notification[], sessionId: string): void {
	for (const notification of notifications) {
		expect(notification.params.sessionId).toBe(sessionId);
		const allowed =
			notification.method === START
				? ["sessionId", "reason", "action"]
				: ["sessionId", "action", "aborted", "willRetry", "skipped", "errorMessage", "tokensBefore", "tokensAfter"];
		expect(Object.keys(notification.params).filter(key => !allowed.includes(key))).toEqual([]);
		expect(JSON.stringify(notification.params)).not.toContain(PRIVATE_SUMMARY);
		expect(JSON.stringify(notification.params)).not.toContain(PRIVATE_TRANSCRIPT);
	}
}

async function closeTransport(writable: WritableStream<Uint8Array>): Promise<void> {
	// ndJsonStream releases its transient writer in a queued microtask after delivery.
	await until(() => !writable.locked, "ACP transport writer release");
	await writable.close();
}

/** Real sessions, real maintenance and disk commits; only summary generation and the LLM are fixtures. */
async function createHarness(options: { recognizesNotifications?: boolean } = {}) {
	const directory = TempDir.createSync("@omp-acp-compaction-notifications-");
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("anthropic", "test-key");
	const registry = new ModelRegistry(auth);
	const sessions: AgentSession[] = [];
	const gates = new Set<CompactionGate>();
	const commandWork = new Set<Promise<void>>();
	const notifications: Notification[] = [];
	const updates: SessionNotification[] = [];
	const bootstrapWaiters = new Map<string, PromiseWithResolvers<void>>();
	const wireMessages: WireMessage[] = [];
	const nextGate = new Map<AgentSession, CompactionGate>();
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");
	const mock = createMockModel({ handler: { content: ["answer after maintenance"] } });
	const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
	const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
	let remainder = "";
	const decoder = new TextDecoder();
	const wireTap = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			remainder += decoder.decode(chunk, { stream: true });
			let newline = remainder.indexOf("\n");
			while (newline !== -1) {
				wireMessages.push(JSON.parse(remainder.slice(0, newline)) as WireMessage);
				remainder = remainder.slice(newline + 1);
				newline = remainder.indexOf("\n");
			}
			controller.enqueue(chunk);
		},
	});
	const handlers: Client = {
		async requestPermission() {
			return { outcome: { outcome: "selected", optionId: "allow_once" } };
		},
		async sessionUpdate(params) {
			updates.push(params);
			if (params.update.sessionUpdate === "available_commands_update") {
				bootstrapWaiters.get(params.sessionId)?.resolve();
			}
		},
		...(options.recognizesNotifications === false
			? {}
			: {
					async extNotification(method: string, params: Record<string, unknown>) {
						if (method.startsWith("_omp/compaction/")) notifications.push({ method, params });
					},
				}),
	};
	const client = new ClientSideConnection(
		() => handlers,
		ndJsonStream(clientToAgent.writable, agentToClient.readable.pipeThrough(wireTap)),
	);
	let acpAgent: AcpAgent | undefined;
	const server = createAcpConnection(
		ndJsonStream(agentToClient.writable, clientToAgent.readable),
		async cwd => {
			const manager = SessionManager.create(cwd, directory.path("sessions"));
			// Two turn boundaries let the actual preparation keep a tail and replace the older transcript.
			manager.appendMessage({ role: "user", content: PRIVATE_TRANSCRIPT.repeat(300), timestamp: Date.now() });
			manager.appendMessage(createAssistantMessage("previous answer"));
			manager.appendMessage({ role: "user", content: "most recent turn", timestamp: Date.now() });
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("session_before_compact", async event => {
						const gate = nextGate.get(session);
						nextGate.delete(session);
						if (gate) {
							gate.entered.resolve();
							await gate.release.promise;
						}
						return {
							compaction: {
								summary: PRIVATE_SUMMARY,
								shortSummary: "private short summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: { transcript: PRIVATE_TRANSCRIPT },
								preserveData: { privateArchive: PRIVATE_TRANSCRIPT },
							},
						};
					});
					// A real ACP prompt can own the turn while idle maintenance runs, without a provider timer.
					pi.registerCommand("fixture-maintenance", {
						handler: async () => {
							const work = session.runIdleCompaction();
							commandWork.add(work);
							try {
								await work;
							} finally {
								commandWork.delete(work);
							}
						},
					});
				},
				cwd,
				new EventBus(),
				runtime,
				"acp-compaction-fixture",
			);
			const agent = new Agent({
				initialState: {
					model: { ...model, contextWindow: 200_000, maxTokens: 8_192 },
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			});
			const session = new AgentSession({
				agent,
				sessionManager: manager,
				settings: Settings.isolated({
					"compaction.methodOrder": ["soft"],
					"compaction.keepRecentTokens": 1,
					"compaction.reserveTokens": 10_000,
					"compaction.autoContinue": false,
					"compaction.asyncEnabled": false,
					"compaction.idleEnabled": false,
					"todo.reminders": false,
					"plan.enabled": false,
				}),
				modelRegistry: registry,
				extensionRunner: new ExtensionRunner([extension], runtime, cwd, manager, registry),
			});
			agent.replaceMessages(session.buildDisplaySessionContext().messages);
			agent.streamFn = mock.stream;
			agent.getApiKey = () => "test-key";
			sessions.push(session);
			return { session, setToolUIContext: () => {} };
		},
		undefined,
		agent => {
			acpAgent = agent;
		},
	);

	async function dispose() {
		for (const gate of gates) gate.release.resolve();
		try {
			await Promise.allSettled(commandWork);
			await acpAgent?.dispose();
		} finally {
			try {
				await closeTransport(clientToAgent.writable);
				await closeTransport(agentToClient.writable);
				await Promise.all([client.closed, server.closed]);
			} finally {
				auth.close();
				await directory.remove();
			}
		}
	}

	try {
		await wait(client.initialize({ protocolVersion: 1, clientCapabilities: {} }));
	} catch (error) {
		await dispose();
		throw error;
	}
	return {
		client,
		notifications,
		updates,
		wireMessages,
		mock,
		dispose,
		async newSession() {
			const created = await wait(client.newSession({ cwd: directory.path(), mcpServers: [] }));
			const session = sessions.find(candidate => candidate.sessionId === created.sessionId);
			if (!session) throw new Error("ACP created no matching real session");
			return session;
		},
		async bootstrap(session: AgentSession) {
			if (
				updates.some(
					update =>
						update.sessionId === session.sessionId && update.update.sessionUpdate === "available_commands_update",
				)
			) {
				return;
			}
			const ready = Promise.withResolvers<void>();
			bootstrapWaiters.set(session.sessionId, ready);
			try {
				await drive(ready.promise);
			} finally {
				bootstrapWaiters.delete(session.sessionId);
			}
		},
		hold(session: AgentSession): CompactionGate {
			const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
			gates.add(gate);
			nextGate.set(session, gate);
			return gate;
		},
	};
}

async function persistedCompactions(session: AgentSession): Promise<CompactionEntry[]> {
	await session.sessionManager.flush();
	const file = session.sessionManager.getSessionFile();
	if (!file) throw new Error("Expected a persisted session file");
	const entries = (await Bun.file(file).text())
		.trim()
		.split("\n")
		.map(line => JSON.parse(line) as { type: string });
	return entries.filter((entry): entry is CompactionEntry => entry.type === "compaction");
}

function expectSuccessfulPair(notifications: Notification[], session: AgentSession, entry: CompactionEntry): void {
	expect(notifications.map(({ method, params }) => ({ method, params }))).toEqual([
		{ method: START, params: { sessionId: session.sessionId, reason: "idle", action: "context-full" } },
		{
			method: END,
			params: {
				sessionId: session.sessionId,
				action: "context-full",
				aborted: false,
				willRetry: false,
				tokensBefore: entry.tokensBefore,
				tokensAfter: entry.tokensAfter,
			},
		},
	]);
	expect(entry.tokensBefore).toBeGreaterThanOrEqual(0);
	expect(entry.tokensAfter).toBeNumber();
	expect(entry.tokensAfter).toBeGreaterThanOrEqual(0);
	expectPrivateProjection(notifications, session.sessionId);
}

describe("ACP automatic compaction notifications over NDJSON", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("reports idle maintenance immediately, associates the right session, and projects persisted counts only", async () => {
		const harness = await createHarness();
		let work: Promise<void> | undefined;
		try {
			const session = await harness.newSession();
			const other = await harness.newSession();
			await Promise.all([harness.bootstrap(session), harness.bootstrap(other)]);
			const gate = harness.hold(session);
			work = session.runIdleCompaction();
			await wait(gate.entered.promise);
			await until(() => harness.notifications.length > 0, "idle compaction start at the client");
			// No ACP prompt has ever existed; the summary is still held, so start cannot be an end-time replay.
			expect(harness.notifications).toEqual([
				{ method: START, params: { sessionId: session.sessionId, reason: "idle", action: "context-full" } },
			]);
			expect(await persistedCompactions(session)).toEqual([]);
			gate.release.resolve();
			await wait(work);
			await until(() => harness.notifications.length >= 2, "idle compaction end at the client");
			const entries = await persistedCompactions(session);
			expect(entries).toHaveLength(1);
			expect(entries[0]!.summary).toContain(PRIVATE_SUMMARY);
			expectSuccessfulPair(harness.notifications, session, entries[0]!);
			expect(await persistedCompactions(other)).toEqual([]);
			expect(harness.mock.calls).toHaveLength(0);
		} finally {
			await harness.dispose();
			await work;
		}
	});

	it("delivers the aborted end after cancellation has detached the prompt listener", async () => {
		const harness = await createHarness();
		let prompt: Promise<PromptResponse> | undefined;
		try {
			const session = await harness.newSession();
			await harness.bootstrap(session);
			const gate = harness.hold(session);
			prompt = harness.client.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "/fixture-maintenance" }],
			});
			await wait(gate.entered.promise);
			await until(() => harness.notifications.length === 1, "prompt-owned compaction start");
			await harness.client.cancel({ sessionId: session.sessionId });
			expect((await wait(prompt)).stopReason).toBe("cancelled");
			// The response is not an abort-cleanup barrier. Keep summary generation held until after it arrives.
			expect(harness.notifications.map(notification => notification.method)).toEqual([START]);
			gate.release.resolve();
			await until(() => harness.notifications.length >= 2, "compaction end after cancelled response");
			await wait(session.waitForIdle());
			expect(harness.notifications).toEqual([
				{ method: START, params: { sessionId: session.sessionId, reason: "idle", action: "context-full" } },
				{
					method: END,
					params: { sessionId: session.sessionId, action: "context-full", aborted: true, willRetry: false },
				},
			]);
			expectPrivateProjection(harness.notifications, session.sessionId);
			expect(await persistedCompactions(session)).toEqual([]);
		} finally {
			await harness.dispose();
			await prompt;
		}
	});

	it("captures early maintenance without duplicating subscriptions on bootstrap or reload", async () => {
		vi.useFakeTimers();
		try {
			const harness = await createHarness();
			let prompt: Promise<PromptResponse> | undefined;
			try {
				const session = await harness.newSession();
				const gate = harness.hold(session);
				prompt = harness.client.prompt({
					sessionId: session.sessionId,
					prompt: [{ type: "text", text: "/fixture-maintenance" }],
				});
				await wait(gate.entered.promise);
				await until(() => harness.notifications.length > 0, "first-prompt compaction start before bootstrap timer");
				expect(harness.notifications.map(notification => notification.method)).toEqual([START]);
				gate.release.resolve();
				expect((await wait(prompt)).stopReason).toBe("end_turn");
				await until(() => harness.notifications.length >= 2, "first-prompt compaction end");
				const firstEntries = await persistedCompactions(session);
				expect(firstEntries).toHaveLength(1);
				expectSuccessfulPair(harness.notifications, session, firstEntries[0]!);

				vi.advanceTimersByTime(ACP_BOOTSTRAP_RACE_GUARD_MS);
				await wait(harness.bootstrap(session));
				const commandUpdates = () =>
					harness.updates.filter(
						update =>
							update.sessionId === session.sessionId &&
							update.update.sessionUpdate === "available_commands_update",
					);
				const beforeReload = commandUpdates().length;
				await wait(
					harness.client.loadSession({
						sessionId: session.sessionId,
						cwd: session.sessionManager.getCwd(),
						mcpServers: [],
					}),
				);
				vi.advanceTimersByTime(ACP_BOOTSTRAP_RACE_GUARD_MS);
				await until(() => commandUpdates().length > beforeReload, "bootstrap advertisement after reload");
				const beforeRefresh = commandUpdates().length;
				session.setMCPPromptCommands([]);
				await until(() => commandUpdates().length > beforeRefresh, "command refresh after reload");
				await wait(harness.client.listSessions({ cwd: session.sessionManager.getCwd() }));
				expect(commandUpdates()).toHaveLength(beforeRefresh + 1);

				// Give the second real preparation a fresh turn boundary; do not replay synthetic lifecycle events.
				session.sessionManager.appendMessage(createAssistantMessage("answer after first compaction"));
				session.sessionManager.appendMessage({ role: "user", content: "another turn", timestamp: Date.now() });
				session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
				await wait(session.runIdleCompaction());
				await until(() => harness.notifications.length >= 4, "second compaction end after bootstrap timer");
				const entries = await persistedCompactions(session);
				expect(entries).toHaveLength(2);
				expect(harness.notifications).toHaveLength(4);
				expectSuccessfulPair(harness.notifications.slice(2), session, entries[1]!);
			} finally {
				vi.useRealTimers();
				await harness.dispose();
				await prompt;
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps an unaware client usable after real unrecognized compaction notifications", async () => {
		const harness = await createHarness({ recognizesNotifications: false });
		try {
			const session = await harness.newSession();
			await harness.bootstrap(session);
			await wait(session.runIdleCompaction());
			await until(
				() => harness.wireMessages.filter(frame => frame.method === START || frame.method === END).length >= 2,
				"unrecognized lifecycle frames",
			);
			const entries = await persistedCompactions(session);
			expect(entries).toHaveLength(1);
			const frames = harness.wireMessages.filter(frame => frame.method === START || frame.method === END);
			expectSuccessfulPair(frames, session, entries[0]!);
			expect(frames.every(frame => frame.jsonrpc === "2.0" && !("id" in frame))).toBe(true);

			const response = await driveTurn(
				session,
				harness.client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "continue" }] }),
			);
			expect(response.stopReason).toBe("end_turn");
			expect(harness.mock.calls).toHaveLength(1);
			expect(
				harness.updates.some(
					update =>
						update.sessionId === session.sessionId &&
						update.update.sessionUpdate === "agent_message_chunk" &&
						update.update.content.type === "text" &&
						update.update.content.text.includes("answer after maintenance"),
				),
			).toBe(true);
			expect(harness.client.signal.aborted).toBe(false);
		} finally {
			await harness.dispose();
		}
	});
});
