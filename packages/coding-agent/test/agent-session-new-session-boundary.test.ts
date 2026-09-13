import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
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
import { assistantMsg } from "./utilities";

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

	for (const transition of ["new", "fork", "branch", "btw"] as const) {
		it(`keeps ${transition} unavailable through before/after hooks and exposes only the final context`, async () => {
			const beforeReached = Promise.withResolvers<void>();
			const beforeRelease = Promise.withResolvers<void>();
			const afterReached = Promise.withResolvers<void>();
			const afterRelease = Promise.withResolvers<void>();
			const { session, sessionManager, agent } = await createHarness({
				extension: {
					name: `gate-${transition}-readiness`,
					register: pi => {
						const before = async () => {
							beforeReached.resolve();
							await beforeRelease.promise;
						};
						const after = async () => {
							afterReached.resolve();
							await afterRelease.promise;
						};
						pi.on("session_before_switch", before);
						pi.on("session_before_branch", before);
						pi.on("session_switch", after);
						pi.on("session_branch", after);
					},
				},
			});
			sessionManager.appendMessage({ role: "user", content: "ancestor", timestamp: 1 });
			const entryId = sessionManager.appendMessage({ role: "user", content: "branch point", timestamp: 2 });
			agent.replaceMessages(sessionManager.buildSessionContext().messages);
			await sessionManager.flush();
			const previousId = sessionManager.getSessionId();
			const operation =
				transition === "new"
					? session.newSession()
					: transition === "fork"
						? session.fork()
						: transition === "branch"
							? session.branch(entryId)
							: session.branchFromBtw("side question", assistantMsg("side answer"), entryId, previousId);
			try {
				await beforeReached.promise;
				expect(session.isSessionTransitioning).toBe(true);
				let ready = false;
				const waiting = session.waitForSessionTransition().then(() => {
					ready = true;
					return { id: sessionManager.getSessionId(), messages: [...session.messages] };
				});
				beforeRelease.resolve();
				await afterReached.promise;
				expect(sessionManager.getSessionId()).not.toBe(previousId);
				expect(session.isSessionTransitioning).toBe(true);
				expect(ready).toBe(false);
				afterRelease.resolve();
				await operation;
				const observed = await waiting;
				expect(session.isSessionTransitioning).toBe(false);
				expect(observed.id).toBe(sessionManager.getSessionId());
				const expectedTexts =
					transition === "new"
						? []
						: transition === "branch"
							? ["ancestor"]
							: transition === "fork"
								? ["ancestor", "branch point"]
								: ["ancestor", "branch point", "side question", "side answer"];
				expect(
					observed.messages.map(message => {
						const content = "content" in message ? message.content : undefined;
						return typeof content === "string"
							? content
							: content
									?.filter(part => part.type === "text")
									.map(part => part.text)
									.join("");
					}),
				).toEqual(expectedTexts);
			} finally {
				beforeRelease.resolve();
				afterRelease.resolve();
				await operation;
			}
		});
	}

	it("waits through full switch rollback before exposing the restored session", async () => {
		const { session, sessionManager, agent } = await createHarness();
		const target = await createHarness();
		sessionManager.appendMessage({ role: "user", content: "source", timestamp: 1 });
		agent.replaceMessages(sessionManager.buildSessionContext().messages);
		const originalId = sessionManager.getSessionId();
		target.sessionManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await target.sessionManager.ensureOnDisk();
		await target.sessionManager.flush();
		const targetFile = target.sessionManager.getSessionFile();
		if (!targetFile) throw new Error("Expected persisted target session");
		const adopted = Promise.withResolvers<void>();
		const failAdoption = Promise.withResolvers<void>();
		const rollbackReached = Promise.withResolvers<void>();
		const rollbackRelease = Promise.withResolvers<void>();
		session.setSessionSwitchReconciler(async () => {
			rollbackReached.resolve();
			await rollbackRelease.promise;
		});
		let firstCwdChange = true;
		const failure = new Error("settings adoption failed");
		const operation = session.switchSession(targetFile, {
			onCwdChange: async () => {
				if (!firstCwdChange) return true;
				firstCwdChange = false;
				adopted.resolve();
				await failAdoption.promise;
				throw failure;
			},
		});
		try {
			await adopted.promise;
			expect(sessionManager.getSessionId()).toBe(target.sessionManager.getSessionId());
			expect(session.isSessionTransitioning).toBe(true);
			let ready = false;
			const waiting = session.waitForSessionTransition().then(() => {
				ready = true;
			});
			failAdoption.resolve();
			await rollbackReached.promise;
			expect(sessionManager.getSessionId()).toBe(originalId);
			expect(session.isSessionTransitioning).toBe(true);
			expect(ready).toBe(false);
			rollbackRelease.resolve();
			await expect(operation).rejects.toBe(failure);
			await waiting;
			expect(session.isSessionTransitioning).toBe(false);
			expect(session.messages).toEqual([{ role: "user", content: "source", timestamp: 1 }]);
		} finally {
			failAdoption.resolve();
			rollbackRelease.resolve();
			await operation.catch(() => {});
		}
	});

	it("keeps the outer transition pending after an awaited reset finishes inside its hook", async () => {
		const resetFinished = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const { session } = await createHarness({
			extension: {
				name: "nested-reset-readiness",
				register: pi => {
					pi.on("session_switch", async () => {
						await session.resetSessionContext();
						resetFinished.resolve();
						await releaseHook.promise;
					});
				},
			},
		});
		const operation = session.newSession();
		try {
			await resetFinished.promise;
			expect(session.isSessionTransitioning).toBe(true);
			let ready = false;
			const waiting = session.waitForSessionTransition().then(() => {
				ready = true;
			});
			await Promise.resolve();
			expect(ready).toBe(false);
			releaseHook.resolve();
			await operation;
			await waiting;
			expect(session.isSessionTransitioning).toBe(false);
		} finally {
			releaseHook.resolve();
			await operation;
		}
	});

	it("keeps an in-place reset unavailable until system-prompt refresh finishes", async () => {
		const { session, sessionManager, agent } = await createHarness();
		sessionManager.appendMessage({ role: "user", content: "discard", timestamp: 1 });
		agent.replaceMessages(sessionManager.buildSessionContext().messages);
		const originalId = sessionManager.getSessionId();
		const refreshReached = Promise.withResolvers<void>();
		const refreshRelease = Promise.withResolvers<void>();
		const refresh = spyOn(session, "refreshBaseSystemPrompt").mockImplementation(async () => {
			refreshReached.resolve();
			await refreshRelease.promise;
		});
		const operation = session.resetSessionContext();
		try {
			await refreshReached.promise;
			expect(session.isSessionTransitioning).toBe(true);
			let ready = false;
			const waiting = session.waitForSessionTransition().then(() => {
				ready = true;
			});
			await Promise.resolve();
			expect(ready).toBe(false);
			refreshRelease.resolve();
			expect(await operation).toEqual({ droppedCount: 1 });
			await waiting;
			expect(session.isSessionTransitioning).toBe(false);
			expect(sessionManager.getSessionId()).toBe(originalId);
			expect(session.messages).toEqual([]);
		} finally {
			refreshRelease.resolve();
			await operation;
			refresh.mockRestore();
		}
	});

	it("releases readiness after a tree hook cancels without moving the leaf", async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session, sessionManager } = await createHarness({
			extension: {
				name: "cancel-tree-readiness",
				register: pi => {
					pi.on("session_before_tree", async () => {
						reached.resolve();
						await release.promise;
						return { cancel: true };
					});
				},
			},
		});
		const root = sessionManager.appendMessage({ role: "user", content: "ancestor", timestamp: 1 });
		const leaf = sessionManager.appendMessage({ role: "user", content: "leaf", timestamp: 2 });
		const operation = session.navigateTree(root);
		try {
			await reached.promise;
			expect(session.isSessionTransitioning).toBe(true);
			const waiting = session.waitForSessionTransition();
			release.resolve();
			expect(await operation).toMatchObject({ cancelled: true });
			await waiting;
			expect(session.isSessionTransitioning).toBe(false);
			expect(sessionManager.getLeafId()).toBe(leaf);
		} finally {
			release.resolve();
			await operation;
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
