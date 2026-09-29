/** Internal aborts stay silent in live and replayed output without hiding unrelated aborts. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { shouldRenderAbortReason } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function makeAbortedAssistantMessage(text = "partial draft"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "aborted",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function makeStoppedAssistantMessage(text = "done"): AssistantMessage {
	return {
		...makeAbortedAssistantMessage(text),
		stopReason: "stop",
	};
}

interface SessionFixture {
	session: AgentSession;
}

async function createSessionWithObfuscator(
	modelRegistry: ModelRegistry,
	obfuscator?: SecretObfuscator,
): Promise<SessionFixture> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");

	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
	});

	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry,
		obfuscator,
	});

	return { session };
}

async function finishAssistant(
	session: AgentSession,
	message: AssistantMessage,
): Promise<{ emitted: AssistantMessage; persisted: AssistantMessage }> {
	const { promise, resolve } = Promise.withResolvers<AssistantMessage>();
	const unsubscribe = session.subscribe(event => {
		if (event.type === "message_end" && event.message.role === "assistant") resolve(event.message);
	});
	try {
		session.agent.emitExternalEvent({ type: "message_end", message });
		const emitted = await promise;
		await session.settleInFlightMessagePersistence();
		const entry = session.sessionManager.getBranch().at(-1);
		if (entry?.type !== "message" || entry.message.role !== "assistant") {
			throw new Error("Expected a persisted assistant message");
		}
		return { emitted, persisted: entry.message };
	} finally {
		unsubscribe();
	}
}

describe("AgentSession silent-abort marker stamping", () => {
	let fixture: SessionFixture | undefined;
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-silent-abort-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});
	afterEach(async () => {
		if (fixture) {
			await fixture.session.dispose();
			fixture = undefined;
		}
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
	});

	it("suppresses an internal abort in live and saved output but not the next unrelated abort", async () => {
		fixture = await createSessionWithObfuscator(modelRegistry);
		const { session } = fixture;
		session.markPlanInternalAbortPending();

		const internal = await finishAssistant(session, Object.freeze(makeAbortedAssistantMessage()));
		expect(shouldRenderAbortReason(internal.emitted)).toBe(false);
		expect(shouldRenderAbortReason(internal.persisted)).toBe(false);
		expect(session.isPlanInternalAbortPending).toBe(false);

		const unrelated = await finishAssistant(session, makeAbortedAssistantMessage("next draft"));
		expect(shouldRenderAbortReason(unrelated.emitted)).toBe(true);
		expect(shouldRenderAbortReason(unrelated.persisted)).toBe(true);
	});

	it("keeps ordinary aborts visible when no internal transition is pending", async () => {
		fixture = await createSessionWithObfuscator(modelRegistry);
		const { session } = fixture;
		const { emitted, persisted } = await finishAssistant(session, makeAbortedAssistantMessage());

		expect(shouldRenderAbortReason(emitted)).toBe(true);
		expect(shouldRenderAbortReason(persisted)).toBe(true);
		expect(session.isPlanInternalAbortPending).toBe(false);
	});

	it("does not consume pending suppression on successful or failed non-aborted messages", async () => {
		fixture = await createSessionWithObfuscator(modelRegistry);
		const { session } = fixture;
		session.markPlanInternalAbortPending();

		const stopped = await finishAssistant(session, makeStoppedAssistantMessage());
		expect(shouldRenderAbortReason(stopped.emitted)).toBe(true);
		expect(shouldRenderAbortReason(stopped.persisted)).toBe(true);
		expect(session.isPlanInternalAbortPending).toBe(true);

		const failed = await finishAssistant(session, {
			...makeStoppedAssistantMessage("failed draft"),
			stopReason: "error",
			errorMessage: "Provider disconnected",
		});
		expect(failed.emitted.errorMessage).toBe("Provider disconnected");
		expect(failed.persisted.errorMessage).toBe("Provider disconnected");
		expect(shouldRenderAbortReason(failed.emitted)).toBe(true);
		expect(shouldRenderAbortReason(failed.persisted)).toBe(true);
		expect(session.isPlanInternalAbortPending).toBe(true);

		const aborted = await finishAssistant(session, makeAbortedAssistantMessage());
		expect(shouldRenderAbortReason(aborted.emitted)).toBe(false);
		expect(shouldRenderAbortReason(aborted.persisted)).toBe(false);
		expect(session.isPlanInternalAbortPending).toBe(false);
	});

	it("suppresses internal aborts before display deobfuscation while keeping saved secrets obfuscated", async () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "SECRET_VALUE" }]);
		const obfuscatedText = obfuscator.obfuscate("hello SECRET_VALUE world");
		fixture = await createSessionWithObfuscator(modelRegistry, obfuscator);
		const { session } = fixture;
		session.markPlanInternalAbortPending();

		const { emitted, persisted } = await finishAssistant(
			session,
			Object.freeze(makeAbortedAssistantMessage(obfuscatedText)),
		);
		expect(shouldRenderAbortReason(emitted)).toBe(false);
		expect(shouldRenderAbortReason(persisted)).toBe(false);
		expect(emitted.content).toEqual([{ type: "text", text: "hello SECRET_VALUE world" }]);
		expect(persisted.content).toEqual([{ type: "text", text: obfuscatedText }]);
		expect(JSON.stringify(persisted.content)).not.toContain("SECRET_VALUE");
		expect(session.isPlanInternalAbortPending).toBe(false);
	});
});
