import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, AppendOnlyContextManager } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const cleanup: Array<() => Promise<void>> = [];
let sharedDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

async function setup(): Promise<void> {
	sharedDir = TempDir.createSync("@pi-new-session-boundary-shared-");
	authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
	modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
}

async function teardown(): Promise<void> {
	authStorage.close();
	sharedDir.removeSync();
}

async function createHarness(options?: {
	extension?: {
		name: string;
		register: (api: ExtensionAPI) => void;
	};
}): Promise<{ agent: Agent; session: AgentSession; sessionManager: SessionManager }> {
	const tempDir = TempDir.createSync("@pi-new-session-boundary-");
	const cwd = tempDir.path();
	const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const agent = new Agent({
		initialState: {
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
	});
	let extensionRunner: ExtensionRunner | undefined;
	if (options?.extension) {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			options.extension.register,
			cwd,
			new EventBus(),
			runtime,
			options.extension.name,
		);
		extensionRunner = new ExtensionRunner([extension], runtime, cwd, sessionManager, modelRegistry);
	}
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry,
		extensionRunner,
	});
	cleanup.push(async () => {
		await session.dispose();
		tempDir.removeSync();
	});
	return { agent, session, sessionManager };
}

describe("AgentSession.newSession boundary", () => {
	beforeAll(setup);
	afterAll(teardown);
	afterEach(async () => {
		while (cleanup.length > 0) {
			const run = cleanup.pop();
			if (run) await run();
		}
	});

	it("invalidates a primed append-only context so pre-/new bytes never reach the next turn", async () => {
		const { agent, session } = await createHarness();
		const appendOnlyContext = new AppendOnlyContextManager();
		agent.setAppendOnlyContext(appendOnlyContext);
		appendOnlyContext.syncMessages([
			{ role: "user", content: "previous conversation" },
			{ role: "assistant", content: "previous answer" },
		]);
		appendOnlyContext.build({ systemPrompt: ["Test"], messages: [], tools: [] }, { intentTracing: false });
		expect(appendOnlyContext.log.length).toBeGreaterThan(0);
		expect(appendOnlyContext.prefix.built).toBe(true);

		expect(await session.newSession()).toBe(true);

		expect(appendOnlyContext.log.length).toBe(0);
		expect(appendOnlyContext.prefix.built).toBe(false);
	});

	it("tracks provider routing identity to the new local session, not the previous conversation", async () => {
		const { session, sessionManager } = await createHarness();
		const previousSessionId = session.sessionId;

		expect(await session.newSession()).toBe(true);

		expect(session.sessionId).not.toBe(previousSessionId);
		expect(session.sessionId).toBe(sessionManager.getSessionId());
	});

	it("does not persist a delayed old-session message into the new session", async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { agent, session, sessionManager } = await createHarness({
			extension: {
				name: "block-old-message-persistence",
				register: pi => {
					pi.on("message_end", async () => {
						reached.resolve();
						await release.promise;
					});
				},
			},
		});
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "previous conversation answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
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
		};

		agent.emitExternalEvent({ type: "message_end", message });
		await reached.promise;
		expect(sessionManager.getEntries()).toHaveLength(0);

		expect(await session.newSession()).toBe(true);
		const newSessionFile = sessionManager.getSessionFile();
		if (!newSessionFile) throw new Error("Expected persisted new session file");
		release.resolve();
		await session.settleInFlightMessagePersistence();
		await sessionManager.flush();

		expect(JSON.stringify(sessionManager.getEntries())).not.toContain("previous conversation answer");
		const reopened = await SessionManager.open(newSessionFile);
		try {
			expect(JSON.stringify(reopened.getEntries())).not.toContain("previous conversation answer");
		} finally {
			await reopened.close();
		}
	});

	it("reports the replacement identity to session_switch extensions before /new returns", async () => {
		let reported:
			| {
					reason: string;
					sessionId: string;
					sessionFile: string | undefined;
			  }
			| undefined;
		const { session, sessionManager } = await createHarness({
			extension: {
				name: "observe-new-session",
				register: pi => {
					pi.on("session_switch", (event, ctx) => {
						reported = {
							reason: event.reason,
							sessionId: ctx.sessionManager.getSessionId(),
							sessionFile: ctx.sessionManager.getSessionFile(),
						};
					});
				},
			},
		});
		const previousSessionId = sessionManager.getSessionId();

		expect(await session.newSession()).toBe(true);

		expect(reported?.reason).toBe("new");
		expect(reported?.sessionId).toBe(sessionManager.getSessionId());
		expect(reported?.sessionId).not.toBe(previousSessionId);
		const reportedFile = reported?.sessionFile;
		if (!reportedFile) throw new Error("Expected session_switch to report a persisted session file");
		expect(await Bun.file(reportedFile).exists()).toBe(true);
	});
});
