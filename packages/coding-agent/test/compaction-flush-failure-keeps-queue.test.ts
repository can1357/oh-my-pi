/**
 * Contract: when delivering the messages typed during compaction fails, the batch goes back to
 * the compaction queue and the messages that flush queued leave the session queue. Messages other
 * sources queued in the session (an extension's prompt, for example) stay queued whether they
 * arrived before the flush, while it was delivering, or after it finished; they are never
 * discarded with the failed batch.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, vi } from "bun:test";
import { Agent, AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import { initTheme } from "../src/ui/theme/service";

describe("flushCompactionQueue failure", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	const authStorages: AuthStorage[] = [];

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-compaction-flush-failure-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			for (const authStorage of authStorages.splice(0)) authStorage.close();
		}
	});

	afterAll(async () => {
		await tempDir?.remove();
	});

	/** A session whose first turn is still streaming (a 60 s mock delay the abort cancels). */
	async function startStreamingSession(): Promise<{ live: AgentSession; running: Promise<boolean> }> {
		const started = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			convertToLlm,
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		const live = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
		});
		session = live;
		const running = live.prompt("first task");
		await started.promise;
		return { live, running };
	}

	function flushContext(
		live: AgentSession,
		typed: CompactionQueuedMessage[],
		showError: (message: string) => void,
		skillCommands = new Map<string, Skill>(),
	) {
		return createInteractiveModeContext({
			session: live,
			compactionQueuedMessages: [...typed],
			skillCommands,
			fileSlashCommands: new Set<string>(),
			isKnownSlashCommand: () => false,
			recordLocalSubmission: () => () => {},
			withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
			showError,
		});
	}

	it("keeps messages queued before the flush when delivering the compaction queue fails", async () => {
		const { live, running } = await startStreamingSession();

		// Queued in the session before the flush runs: an extension's prompt.
		await live.sendUserMessage("from the extension", { deliverAs: "followUp" });

		// The second typed message fails to deliver.
		const steer = live.steer.bind(live);
		let steers = 0;
		vi.spyOn(live, "steer").mockImplementation(async (text, images, options) => {
			if (++steers === 2) throw new Error("delivery failed");
			return steer(text, images, options);
		});
		const typed: CompactionQueuedMessage[] = [
			{ text: "typed one", mode: "steer" },
			{ text: "typed two", mode: "steer" },
		];
		const ctx = flushContext(live, typed, () => {});

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: true });

		// The failed batch is held for retry, and the input it queued left the session queue ...
		expect(ctx.compactionQueuedMessages).toEqual(typed);
		expect(live.getQueuedMessages().steering).toEqual([]);
		// ... but the extension's prompt queued before the flush is still there.
		expect(live.getQueuedMessages().followUp).toEqual(["from the extension"]);

		await live.abort();
		await running.catch(() => {});
	});

	it("keeps messages queued after the flush returned when its first prompt fails later", async () => {
		const { live, running } = await startStreamingSession();

		// The first typed prompt is fire-and-forget; its setup fails only after the flush returns.
		const setupFails = Promise.withResolvers<void>();
		const prompted = Promise.withResolvers<void>();
		vi.spyOn(live, "prompt").mockImplementation(async () => {
			prompted.resolve();
			await setupFails.promise;
			throw new Error("No API key found");
		});
		const typed: CompactionQueuedMessage[] = [
			{ text: "typed first", mode: "steer" },
			{ text: "typed second", mode: "steer" },
		];
		// The restore reports the failure last, once the queues are settled.
		const reported = Promise.withResolvers<void>();
		const ctx = flushContext(live, typed, () => reported.resolve());

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		await prompted.promise;
		expect(live.getQueuedMessages().steering).toEqual(["typed second"]);

		// Something else queues a prompt while the first prompt is still being set up.
		await live.sendUserMessage("queued afterwards", { deliverAs: "followUp" });
		setupFails.resolve();
		await reported.promise;
		expect(ctx.compactionQueuedMessages).toEqual(typed);

		// The flush took back its own delivered message, not the one queued after it.
		expect(live.getQueuedMessages().steering).toEqual([]);
		expect(live.getQueuedMessages().followUp).toEqual(["queued afterwards"]);

		await live.abort();
		await running.catch(() => {});
	});

	it("stops delivering and takes back the rest when the first prompt fails mid-delivery", async () => {
		const { live, running } = await startStreamingSession();

		// The first typed prompt fails while the second typed message is still being delivered.
		vi.spyOn(live, "prompt").mockImplementation(async () => {
			throw new Error("No API key found");
		});
		const steer = live.steer.bind(live);
		const steerStarted = Promise.withResolvers<void>();
		const steerRelease = Promise.withResolvers<void>();
		vi.spyOn(live, "steer").mockImplementation(async (text, images, options) => {
			steerStarted.resolve();
			await steerRelease.promise;
			return steer(text, images, options);
		});
		const typed: CompactionQueuedMessage[] = [
			{ text: "typed first", mode: "steer" },
			{ text: "typed second", mode: "steer" },
			{ text: "typed third", mode: "steer" },
		];
		const reported = Promise.withResolvers<void>();
		const ctx = flushContext(live, typed, () => reported.resolve());

		const flushing = new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		await steerStarted.promise;
		await reported.promise;
		steerRelease.resolve();
		await flushing;

		// The batch is back in the compaction queue once, and none of it stays in the session queue
		// to be sent now and again on the next flush.
		expect(ctx.compactionQueuedMessages).toEqual(typed);
		expect(live.getQueuedMessages().steering).toEqual([]);

		await live.abort();
		await running.catch(() => {});
	});

	it("keeps an extension prompt queued while the flush was delivering when a later delivery fails", async () => {
		const { live, running } = await startStreamingSession();

		// While the first typed message is being delivered, an extension queues its own prompt;
		// then the second typed message fails to deliver.
		const steer = live.steer.bind(live);
		let steers = 0;
		vi.spyOn(live, "steer").mockImplementation(async (text, images, options) => {
			if (++steers === 2) throw new Error("delivery failed");
			await live.sendUserMessage("from the extension", { deliverAs: "followUp" });
			return steer(text, images, options);
		});
		const typed: CompactionQueuedMessage[] = [
			{ text: "typed one", mode: "steer" },
			{ text: "typed two", mode: "steer" },
		];
		const ctx = flushContext(live, typed, () => {});

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: true });

		// The flush takes back only what it queued itself.
		expect(ctx.compactionQueuedMessages).toEqual(typed);
		expect(live.getQueuedMessages().steering).toEqual([]);
		expect(live.getQueuedMessages().followUp).toEqual(["from the extension"]);

		await live.abort();
		await running.catch(() => {});
	});

	it("keeps an extension prompt queued during the rest delivery when the first prompt fails", async () => {
		const { live, running } = await startStreamingSession();

		// The first typed prompt fails while the second typed message is still being delivered,
		// and an extension queues its own prompt in that window.
		vi.spyOn(live, "prompt").mockImplementation(async () => {
			throw new Error("No API key found");
		});
		const steer = live.steer.bind(live);
		const steerStarted = Promise.withResolvers<void>();
		const steerRelease = Promise.withResolvers<void>();
		vi.spyOn(live, "steer").mockImplementation(async (text, images, options) => {
			steerStarted.resolve();
			await steerRelease.promise;
			return steer(text, images, options);
		});
		const typed: CompactionQueuedMessage[] = [
			{ text: "typed first", mode: "steer" },
			{ text: "typed second", mode: "steer" },
		];
		const reported = Promise.withResolvers<void>();
		const ctx = flushContext(live, typed, () => reported.resolve());

		const flushing = new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		await steerStarted.promise;
		await reported.promise;
		await live.sendUserMessage("from the extension", { deliverAs: "followUp" });
		steerRelease.resolve();
		await flushing;

		expect(ctx.compactionQueuedMessages).toEqual(typed);
		expect(live.getQueuedMessages().steering).toEqual([]);
		expect(live.getQueuedMessages().followUp).toEqual(["from the extension"]);

		await live.abort();
		await running.catch(() => {});
	});

	it("does not send an already-sent first prompt again when a later message fails", async () => {
		const { live, running } = await startStreamingSession();

		// The first typed prompt is queued into the running turn; only then does the next message
		// fail to deliver.
		vi.spyOn(live, "steer").mockImplementation(async () => {
			while (!live.getQueuedMessages().steering.includes("typed first")) await Bun.sleep(1);
			throw new Error("delivery failed");
		});
		const typed: CompactionQueuedMessage[] = [
			{ text: "typed first", mode: "steer" },
			{ text: "typed second", mode: "steer" },
		];
		const ctx = flushContext(live, typed, () => {});

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });

		// The session owns the first prompt and still delivers it; only the failed message goes back,
		// so the next flush does not send the first prompt a second time.
		expect(live.getQueuedMessages().steering).toEqual(["typed first"]);
		expect(ctx.compactionQueuedMessages).toEqual([typed[1]]);

		await live.abort();
		await running.catch(() => {});
	});

	it("puts the first prompt back when it fails after a later message's failure left it out", async () => {
		const { live, running } = await startStreamingSession();

		// The first prompt is admitted (its turn setup begins) and only later fails.
		const setupFails = Promise.withResolvers<void>();
		vi.spyOn(live, "prompt").mockImplementation(async (_text, options) => {
			options?.onPromptAdmitted?.();
			await setupFails.promise;
			throw new Error("No API key found");
		});
		vi.spyOn(live, "steer").mockImplementation(async () => {
			throw new Error("delivery failed");
		});
		const typed: CompactionQueuedMessage[] = [
			{ text: "typed first", mode: "steer" },
			{ text: "typed second", mode: "steer" },
		];
		const reports: string[] = [];
		const secondReport = Promise.withResolvers<void>();
		const ctx = flushContext(live, typed, message => {
			reports.push(message);
			if (reports.length === 2) secondReport.resolve();
		});

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		expect(ctx.compactionQueuedMessages).toEqual([typed[1]]);

		setupFails.resolve();
		await secondReport.promise;
		// Nothing is lost: the failed first prompt returns ahead of the message after it.
		expect(ctx.compactionQueuedMessages).toEqual(typed);

		await live.abort();
		await running.catch(() => {});
	});

	it("puts a skill first prompt back when the session drops it after a later message's failure left it out", async () => {
		const { live, running } = await startStreamingSession();
		const skillPath = tempDir.join("ship.md");
		await Bun.write(skillPath, "---\nname: ship\n---\nShip it.\n");
		const skills = new Map<string, Skill>([
			[
				"skill:ship",
				{ name: "ship", description: "", filePath: skillPath, baseDir: tempDir.path(), source: "test" },
			],
		]);

		// The skill prompt is admitted, then dropped before it is sent (as a usage preflight or cost
		// cap denial does): it resolves `false` instead of rejecting.
		const dropped = Promise.withResolvers<void>();
		const promptCustomMessage = vi
			.spyOn(live, "promptCustomMessage")
			.mockImplementation(async (_message, options) => {
				options?.onPromptAdmitted?.();
				await dropped.promise;
				return false;
			});
		vi.spyOn(live, "steer").mockImplementation(async () => {
			throw new Error("delivery failed");
		});
		const typed: CompactionQueuedMessage[] = [
			{ text: "/skill:ship now", mode: "steer" },
			{ text: "typed second", mode: "steer" },
		];
		const ctx = flushContext(live, typed, () => {}, skills);

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		// The later failure left the admitted skill prompt out of the restored batch.
		expect(ctx.compactionQueuedMessages).toEqual([typed[1]]);

		dropped.resolve();
		// The flush reacts to the dispatch result before this await resumes.
		await promptCustomMessage.mock.results[0]?.value;
		// The skill invocation was never sent, so it returns to the batch instead of being lost.
		expect(ctx.compactionQueuedMessages).toEqual(typed);

		await live.abort();
		await running.catch(() => {});
	});
});

// While the agent streams, a flush must deliver through the session steer/follow-up
// queues (which Alt+Up and the post-stream drain consult) instead of stranding a
// busy-rejected message in compactionQueuedMessages, and its local-submission
// bookkeeping must be undone whenever delivery rejects.
describe("flushCompactionQueue delivery against a streaming session", () => {
	beforeAll(() => {
		initTheme();
	});

	type PromptOpts = { streamingBehavior?: "steer" | "followUp" } | undefined;

	function makeFakeSession() {
		const steering: { text: string }[] = [];
		const followUp: { text: string }[] = [];
		const promptCalls: Array<{ text: string; opts: PromptOpts }> = [];

		const prompt = mock(async (text: string, opts?: PromptOpts): Promise<void> => {
			promptCalls.push({ text, opts });
			// Mirror real agent-session behaviour: when the session is busy and the
			// caller did not supply streamingBehavior, throw AgentBusyError.
			if (!opts?.streamingBehavior) {
				throw new AgentBusyError();
			}
			if (opts.streamingBehavior === "followUp") {
				followUp.push({ text });
			} else {
				steering.push({ text });
			}
		});

		const steer = mock(async (text: string): Promise<void> => {
			steering.push({ text });
		});

		const followUpFn = mock(async (text: string): Promise<void> => {
			followUp.push({ text });
		});

		const session = {
			isStreaming: true,
			isCompacting: false,
			extensionRunner: undefined,
			customCommands: [] as Array<{ command: { name: string } }>,
			getQueuedMessages: () => ({ steering: steering.map(e => e.text), followUp: followUp.map(e => e.text) }),
			// Faithful stub of AgentSession.dropQueuedMessages: removes exactly the given entries.
			dropQueuedMessages: (messages: Iterable<object>) => {
				const dropped = new Set(messages);
				const s = steering.filter(entry => !dropped.has(entry));
				const f = followUp.filter(entry => !dropped.has(entry));
				steering.splice(0, steering.length, ...s);
				followUp.splice(0, followUp.length, ...f);
			},
			prompt,
			steer,
			followUp: followUpFn,
		};

		return { session, steering, followUp, promptCalls };
	}

	function makeFakeFlushContext(initialQueue: CompactionQueuedMessage[]) {
		const fake = makeFakeSession();
		const showError = mock((_msg: string) => {});
		const showStatus = mock((_msg: string) => {});
		const updatePendingMessagesDisplay = mock(() => {});

		const locallySubmittedUserSignatures = new Set<string>();
		const isKnownSlashCommand = (text: string) => text.startsWith("/");
		const ctx = {
			session: fake.session,
			compactionQueuedMessages: [...initialQueue],
			pendingMessagesContainer: { clear: () => {}, addChild: () => {}, removeChild: () => {} },
			editor: { addToHistory: () => {}, setText: () => {}, getText: () => "" },
			keybindings: { getKeys: () => ["alt+up"] },
			fileSlashCommands: new Set<string>(),
			locallySubmittedUserSignatures,
			isKnownSlashCommand,
			recordLocalSubmission(text: string, imageCount = 0) {
				if (isKnownSlashCommand(text)) return () => {};
				const sig = `${text}\u0000${imageCount}`;
				locallySubmittedUserSignatures.add(sig);
				let disposed = false;
				return () => {
					if (disposed) return;
					disposed = true;
					locallySubmittedUserSignatures.delete(sig);
				};
			},
			async withLocalSubmission<T>(
				text: string,
				fn: () => Promise<T>,
				options?: { imageCount?: number },
			): Promise<T> {
				const dispose = ctx.recordLocalSubmission(text, options?.imageCount ?? 0);
				try {
					return await fn();
				} catch (err) {
					dispose();
					throw err;
				}
			},
			updatePendingMessagesDisplay,
			showError,
			showStatus,
		} as unknown as InteractiveModeContext;

		return { ctx, fake, showError, showStatus, updatePendingMessagesDisplay };
	}

	it("AgentBusyError on flush leaves the steer message in the session queue (submittable on next turn)", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "address review feedback", mode: "steer" }];
		const { ctx, fake } = makeFakeFlushContext(queued);

		const helpers = new UiHelpers(ctx);
		await helpers.flushCompactionQueue({ willRetry: false });
		// Drain microtasks so the .catch on the fire-and-forget prompt resolves.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// Contract: the message must end up in the session steering queue —
		// that is what `restoreQueuedMessagesToEditor` (Alt+Up) and the
		// post-stream drain consult. Otherwise it is stranded in
		// compactionQueuedMessages with no consumer.
		expect(fake.steering).toContainEqual({ text: "address review feedback" });

		// And it must not also remain duplicated in compactionQueuedMessages.
		const remaining = (ctx as unknown as { compactionQueuedMessages: CompactionQueuedMessage[] })
			.compactionQueuedMessages;
		expect(remaining.find(m => m.text === "address review feedback")).toBeUndefined();
	});

	it("marks flushed compaction messages as local submissions before delivery", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "draft-safe queued message", mode: "steer" }];
		const { ctx, fake } = makeFakeFlushContext(queued);
		fake.session.isStreaming = false;
		fake.session.prompt = mock(async (text: string, opts?: PromptOpts): Promise<void> => {
			fake.promptCalls.push({ text, opts });
		});

		const helpers = new UiHelpers(ctx);
		await helpers.flushCompactionQueue({ willRetry: false });

		expect(ctx.locallySubmittedUserSignatures.has("draft-safe queued message\u00000")).toBe(true);
	});

	it("removes the local-submission signature when willRetry delivery rejects", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "willRetry boom", mode: "followUp" }];
		const { ctx, fake } = makeFakeFlushContext(queued);
		fake.session.followUp = mock(async () => {
			throw new Error("delivery failed");
		});

		const helpers = new UiHelpers(ctx);
		// flushCompactionQueue funnels rejections through restoreQueue, so it
		// resolves rather than rethrowing — but the signature must still be
		// cleared so the restored queue can be re-flushed without stale state.
		await helpers.flushCompactionQueue({ willRetry: true });

		expect(ctx.locallySubmittedUserSignatures.has("willRetry boom\u00000")).toBe(false);
		// And the message is restored to compactionQueuedMessages for retry.
		const remaining = (ctx as unknown as { compactionQueuedMessages: CompactionQueuedMessage[] })
			.compactionQueuedMessages;
		expect(remaining.find(m => m.text === "willRetry boom")).toBeDefined();
	});

	it("removes the local-submission signature when the fire-and-forget firstPrompt rejects", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "fire and forget", mode: "steer" }];
		const { ctx, fake } = makeFakeFlushContext(queued);
		// Force the firstPrompt path (not willRetry, no slash commands) to reject.
		fake.session.prompt = mock(async () => {
			throw new Error("queue closed");
		});

		const helpers = new UiHelpers(ctx);
		await helpers.flushCompactionQueue({ willRetry: false });
		// Drain microtasks so the .catch on the fire-and-forget prompt resolves.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(ctx.locallySubmittedUserSignatures.has("fire and forget\u00000")).toBe(false);
	});
});
