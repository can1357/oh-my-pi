/**
 * Two concurrent `prompt()` calls must serialize instead of racing dispatch.
 *
 * `prompt()` checks `isStreaming` at the top, but image normalization (and the
 * vision-description call) suspend before `#promptWithMessage` increments the
 * in-flight count. Two callers that both saw an idle session — the CLI initial
 * message of an `omp "prompt"` launch and a submission typed right after the
 * startup composer opens its submit gate — used to both dispatch: the loser
 * died with AgentBusyError and the prompts could land out of order. The
 * post-await re-check queues the loser as a steer into the winner's turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { assistantMsg } from "./utilities";

describe("AgentSession concurrent prompt dispatch", () => {
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;
	let sessionDir: string | undefined;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		if (sessionDir) await rm(sessionDir, { recursive: true, force: true });
		sessionDir = undefined;
	});

	function createSession(sessionManager = SessionManager.inMemory(), extensionRunner?: ExtensionRunner) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
			streamFn: createMockModel({
				responses: [{ content: ["First done"] }, { content: ["Second done"] }, { content: ["Third done"] }],
			}).stream,
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
	}

	it.each(["navigateTree", "branch", "fork", "branchFromBtw"] as const)(
		"drops an admitted custom prompt when %s replaces its branch before dispatch",
		async transition => {
			sessionDir = await mkdtemp(join(tmpdir(), "omp-prompt-transition-"));
			const manager = SessionManager.create(sessionDir, sessionDir);
			const retained = manager.appendMessage({ role: "user", content: "Retained", timestamp: 1 });
			const abandoned = manager.appendMessage({ role: "user", content: "Abandoned", timestamp: 2 });
			createSession(manager);
			const reached = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const getApiKey = modelRegistry.getApiKey.bind(modelRegistry);
			vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (...args) => {
				reached.resolve();
				await release.promise;
				return getApiKey(...args);
			});
			const releaseFlush = Promise.withResolvers<void>();
			let btwBranch: ReturnType<AgentSession["branchFromBtw"]> | undefined;
			if (transition === "branchFromBtw") {
				// /btw checks idle before flushing. A prompt can be admitted during
				// that await, before the final identity check and branch commit.
				const reachedFlush = Promise.withResolvers<void>();
				const flush = manager.flush.bind(manager);
				vi.spyOn(manager, "flush").mockImplementationOnce(async () => {
					reachedFlush.resolve();
					await releaseFlush.promise;
					await flush();
				});
				btwBranch = session.branchFromBtw(
					"Side question",
					assistantMsg("Side answer"),
					abandoned,
					manager.getSessionId(),
				);
				await reachedFlush.promise;
			}
			const pending = session.promptCustomMessage({
				customType: "collab-prompt",
				content: "Admitted on the abandoned branch",
				display: true,
				attribution: "user",
			});
			try {
				await reached.promise;
				if (transition === "fork") {
					expect(await session.fork()).toBe(true);
				} else if (transition === "branchFromBtw") {
					releaseFlush.resolve();
					expect((await btwBranch)?.cancelled).toBe(false);
				} else {
					expect((await session[transition](abandoned)).cancelled).toBe(false);
					expect(manager.getLeafId()).toBe(retained);
				}
			} finally {
				releaseFlush.resolve();
				release.resolve();
			}
			expect(await pending).toBe(false);
			expect(
				manager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === "collab-prompt"),
			).toBe(false);
		},
	);

	it("preserves an admitted user prompt when a tree hook cancels before commit", async () => {
		const manager = SessionManager.inMemory();
		const target = manager.appendMessage({ role: "user", content: "Original", timestamp: 1 });
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			api => api.on("session_before_tree", async () => ({ cancel: true })),
			manager.getCwd(),
			new EventBus(),
			runtime,
			"cancel-tree",
		);
		createSession(manager, new ExtensionRunner([extension], runtime, manager.getCwd(), manager, modelRegistry));
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const getApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (...args) => {
			reached.resolve();
			await release.promise;
			return getApiKey(...args);
		});
		const pending = session.prompt("Still belongs here");
		try {
			await reached.promise;
			expect((await session.navigateTree(target)).cancelled).toBe(true);
			expect(manager.getLeafId()).toBe(target);
		} finally {
			release.resolve();
		}
		await pending;
		expect(
			manager
				.getEntries()
				.some(
					entry =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						Array.isArray(entry.message.content) &&
						entry.message.content.some(block => block.type === "text" && block.text === "Still belongs here"),
				),
		).toBe(true);
	});

	it("queues a prompt that loses the pre-dispatch race instead of racing a second turn", async () => {
		createSession();

		// Neither call is awaited before the other starts: both pass the
		// top-of-prompt isStreaming check because the pre-dispatch awaits
		// suspend before the in-flight count increments.
		const first = session.prompt("initial CLI prompt", { streamingBehavior: "steer" });
		const second = session.prompt("typed during preflight", { streamingBehavior: "steer" });

		// Pre-fix, the loser reached agent.prompt() on a busy agent and this
		// rejected with AgentBusyError.
		await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

		const users = session.messages.filter(message => message.role === "user");
		const textOf = (message: (typeof users)[number]): string =>
			typeof message.content === "string"
				? message.content
				: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
		const firstIndex = users.findIndex(message => textOf(message) === "initial CLI prompt");
		const secondIndex = users.findIndex(message => textOf(message) === "typed during preflight");
		expect(firstIndex).toBeGreaterThanOrEqual(0);
		expect(secondIndex).toBeGreaterThanOrEqual(0);
		// The first dispatch keeps its turn; the loser steers into it.
		expect(firstIndex).toBeLessThan(secondIndex);
		// The queue path marks the message as steering. Pre-fix the loser was
		// absorbed by the recovery idle-retry instead: it waited for the first
		// turn and ran as a detached second turn (plain user message), and a
		// first turn longer than the retry deadline dropped the prompt.
		expect(users[secondIndex]?.steering).toBe(true);
	});
});
