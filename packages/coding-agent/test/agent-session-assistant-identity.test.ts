import { afterEach, expect, test, vi } from "bun:test";
import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { planTurnPersistence, sessionMessagePersistenceKey } from "@oh-my-pi/pi-coding-agent/session/turn-persistence";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function harness(error = false, obfuscator?: SecretObfuscator, storage?: FileSessionStorage) {
	const dir = TempDir.createSync("assistant-identity-");
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("mock", "test-key");
	const mock = createMockModel({
		handler: error
			? { content: [], stopReason: "error", errorMessage: "terminal failure" }
			: { content: [obfuscator?.obfuscate("identical identity-secret") ?? "identical reply"] },
	});
	const manager = SessionManager.create(dir.path(), dir.path(), storage);
	const agent = new Agent({
		initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [] },
		getApiKey: () => "test-key",
		convertToLlm,
		streamFn: mock.stream,
	});
	const turns: AssistantMessage[] = [];
	const ends: Extract<AgentEvent, { type: "agent_end" }>[] = [];
	const snapshots: AssistantMessage[] = [];
	agent.subscribe(event => {
		if (event.type === "agent_end") ends.push(event);
		if (event.type === "message_end" && event.message.role === "assistant") snapshots.push(event.message);
	});
	const setOnTurnEnd = agent.setOnTurnEnd.bind(agent);
	vi.spyOn(agent, "setOnTurnEnd").mockImplementation(handler => {
		setOnTurnEnd(async (messages, signal, context) => {
			if (context?.message.role === "assistant") turns.push(context.message);
			await handler?.(messages, signal, context);
		});
	});
	const session = new AgentSession({
		agent,
		obfuscator,
		sessionManager: manager,
		modelRegistry: new ModelRegistry(auth),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		}),
	});
	cleanups.push(async () => {
		await session.dispose();
		auth.close();
		dir.removeSync();
	});
	return { agent, session, manager, turns, ends, snapshots, auth, dir };
}

function replies(manager: SessionManager): AssistantMessage[] {
	return manager
		.getEntries()
		.flatMap(entry => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
}

for (const error of [false, true]) {
	test(`distinct same-ms ${error ? "terminal errors" : "replies"} survive persistence and reopen`, async () => {
		const { session, manager } = await harness(error);
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		await session.prompt("first");
		await session.waitForIdle();
		await session.prompt("second");
		await session.waitForIdle();
		await manager.flush();
		const memory = replies(manager);
		const reopened = await SessionManager.open(manager.getSessionFile()!);
		try {
			const disk = replies(reopened);
			expect({ memory: memory.length, disk: disk.length }).toEqual({ memory: 2, disk: 2 });
			expect(memory[0]!.timestamp).toBe(memory[1]!.timestamp);
			expect(memory[0]!.responseId).toBeUndefined();
			expect(memory[1]!.responseId).toBeUndefined();
			expect(memory[0]!.content).toEqual(memory[1]!.content);
		} finally {
			await reopened.close();
		}
	});

	test(`rehandling one ${error ? "terminal error" : "reply"} and its core snapshot is idempotent`, async () => {
		const { agent, session, manager, turns, ends, snapshots } = await harness(error);
		await session.prompt("first");
		await session.waitForIdle();
		const persisted = replies(manager)[0]!;
		const original = error ? ends[0]!.messages.find(message => message.role === "assistant")! : turns[0]!;
		expect(original.role).toBe("assistant");
		expect(original).not.toBe(snapshots[0]);
		if (error) {
			expect(original).toMatchObject({ stopReason: "error", errorMessage: "terminal failure" });
			// agent_end routes terminal errors through TurnRecovery, unlike message_end.
			agent.emitExternalEvent({ ...ends[0]!, messages: [original] });
			await session.waitForIdle();
			agent.emitExternalEvent({ ...ends[0]!, messages: [snapshots[0]!] });
		} else {
			agent.emitExternalEvent({ type: "message_end", message: original });
			agent.emitExternalEvent({ type: "message_end", message: persisted });
		}
		await session.waitForIdle();
		await manager.flush();
		expect(replies(manager)).toHaveLength(1);
		const reopened = await SessionManager.open(manager.getSessionFile()!);
		try {
			expect(replies(reopened)).toHaveLength(1);
		} finally {
			await reopened.close();
		}
	});
}

test("btw promotion and redelivery preserve journal and reopened counts", async () => {
	const { agent, session, manager, turns } = await harness();
	await session.prompt("first");
	await session.waitForIdle();
	const answer: AssistantMessage = {
		...turns[0]!,
		content: [{ type: "text", text: "side-channel answer" }],
	};
	await session.branchFromBtw("question", answer, manager.getLeafId()!, manager.getSessionId());
	expect(replies(manager)).toHaveLength(2);
	agent.emitExternalEvent({ type: "message_end", message: answer });
	await session.waitForIdle();
	await manager.flush();
	const reopened = await SessionManager.open(manager.getSessionFile()!);
	try {
		expect({ memory: replies(manager).length, disk: replies(reopened).length }).toEqual({ memory: 2, disk: 2 });
	} finally {
		await reopened.close();
	}
});

test("atomic rollback with a surviving leaf permits the removed assistant to retry", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let fail = false;
	class GatedStorage extends FileSessionStorage {
		override async writeTextAtomic(...args: Parameters<FileSessionStorage["writeTextAtomic"]>): Promise<void> {
			if (fail) {
				fail = false;
				started.resolve();
				await release.promise;
				throw new Error("injected atomic publication failure");
			}
			return super.writeTextAtomic(...args);
		}
	}
	const { agent, session, manager, turns } = await harness(false, undefined, new GatedStorage());
	await session.prompt("first");
	await session.waitForIdle();
	await manager.flush();
	const answer: AssistantMessage = { ...turns[0]!, content: [{ type: "text", text: "staged answer" }] };
	fail = true;
	const batch = manager.appendEntriesAtomically(() => manager.appendMessage(answer)).catch(error => error);
	await started.promise;
	manager.appendCustomEntry("concurrent-survivor");
	const leaf = manager.getLeafEntry();
	try {
		agent.emitExternalEvent({ type: "message_end", message: answer });
		await session.waitForIdle();
	} finally {
		release.resolve();
	}
	expect(await batch).toMatchObject({ message: "injected atomic publication failure" });
	expect(manager.getLeafEntry()).toBe(leaf);
	expect(replies(manager)).toHaveLength(1);
	agent.emitExternalEvent({ type: "message_end", message: answer });
	await session.waitForIdle();
	await manager.flush();
	const reopened = await SessionManager.open(manager.getSessionFile()!);
	try {
		expect({ memory: replies(manager).length, disk: replies(reopened).length }).toEqual({ memory: 2, disk: 2 });
	} finally {
		await reopened.close();
	}
});

test("reloaded deobfuscated history remains persisted at the compaction boundary", async () => {
	const obfuscator = new SecretObfuscator([{ type: "plain", content: "identity-secret" }], "identity-test-key");
	const { agent, session, manager } = await harness(false, obfuscator);
	await session.prompt("first");
	await session.waitForIdle();
	await manager.flush();
	const previous = replies(manager)[0]!;
	const file = manager.getSessionFile()!;
	expect(await session.switchSession(file)).toBe(true);
	const canonical = replies(manager)[0]!;
	const display = agent.state.messages.find(message => message.role === "assistant")!;
	expect(canonical).not.toBe(previous);
	expect(display).not.toBe(canonical);
	expect(display.content).toEqual([{ type: "text", text: "identical identity-secret" }]);
	const keys = new Set(
		manager
			.getBranch()
			.flatMap(entry => (entry.type === "message" ? [sessionMessagePersistenceKey(entry.message)!] : [])),
	);
	// A later persisted tool result makes a missing assistant an ordering violation.
	keys.add("toolResult:later");
	expect(planTurnPersistence([sessionMessagePersistenceKey(display), "toolResult:later"], keys)).toEqual({
		kind: "ok",
		toPersist: [],
	});
	// Exercise the session's already-populated key cache after same-file reload.
	agent.emitExternalEvent({ type: "message_end", message: display });
	await session.waitForIdle();
	await manager.flush();
	expect(replies(manager)).toHaveLength(1);
	const reopened = await SessionManager.open(file);
	try {
		expect(replies(reopened)).toHaveLength(1);
	} finally {
		await reopened.close();
	}
});

test("no-op context extensions retain history and the Anthropic assistant cache breakpoint", async () => {
	const { session, manager, turns, auth, dir } = await harness();
	await session.prompt("first");
	await session.waitForIdle();
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("context", () => {});
		},
		dir.path(),
		new EventBus(),
		runtime,
		"identity-noop-context",
	);
	const runner = new ExtensionRunner([extension], runtime, dir.path(), manager, new ModelRegistry(auth));
	const transformed = await runner.emitContext([turns[0]!]);
	const model = buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});
	let body: MessageCreateParams | undefined;
	await streamAnthropic(
		model,
		{
			messages: [{ role: "user", content: "first", timestamp: 1 }, ...convertToLlm(transformed)],
		},
		{
			apiKey: "sk-ant-api-test",
			cacheRetention: "short",
			fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
				body = JSON.parse(String(init?.body)) as MessageCreateParams;
				return new Response(
					JSON.stringify({
						type: "error",
						error: { type: "invalid_request_error", message: "fixture capture" },
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}) as typeof fetch,
		},
	).result();
	expect(body).toBeDefined();
	const assistant = body!.messages.find(message => message.role === "assistant");
	expect(assistant).toBeDefined();
	expect({
		perCall: isPerCallContextMessage(transformed[0]!),
		assistantCacheBreakpoint:
			Array.isArray(assistant!.content) &&
			assistant!.content.some(block => "cache_control" in block && Boolean(block.cache_control)),
	}).toEqual({ perCall: false, assistantCacheBreakpoint: true });
});
