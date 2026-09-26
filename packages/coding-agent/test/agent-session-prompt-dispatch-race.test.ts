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
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	convertToLlm,
	type CustomMessage,
	SKILL_PROMPT_MESSAGE_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import * as imageVisionFallback from "@oh-my-pi/pi-coding-agent/utils/image-vision-fallback";
import { assistantMsg } from "./utilities";

interface BtwBranchResult {
	cancelled: boolean;
	sessionFile: string | undefined;
}

describe("AgentSession concurrent prompt dispatch", () => {
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;
	let sessionDir: string | undefined;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		if (sessionDir) await fs.rm(sessionDir, { recursive: true, force: true });
		sessionDir = undefined;
	});

	function createSession(
		responses?: MockHandler[],
		textOnly = false,
		sessionManager = SessionManager.inMemory(),
		extensionRunner?: ExtensionRunner,
	) {
		const bundledModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundledModel) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const model = textOnly ? { ...bundledModel, input: ["text" as const] } : bundledModel;

		const agent = new Agent({
			getApiKey: () => "test-key",
			convertToLlm,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
			streamFn: createMockModel({
				responses: responses ?? [
					{ content: ["First done"] },
					{ content: ["Second done"] },
					{ content: ["Third done"] },
				],
			}).stream,
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"magicKeywords.enabled": true,
				"magicKeywords.ultrathink": true,
			}),
			modelRegistry,
			extensionRunner,
		});
	}

	it.each(["navigateTree", "branch", "fork", "branchFromBtw"] as const)(
		"drops an admitted custom prompt when %s replaces its branch before dispatch",
		async transition => {
			sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prompt-transition-"));
			const manager = SessionManager.create(sessionDir, sessionDir);
			const retained = manager.appendMessage({ role: "user", content: "Retained", timestamp: 1 });
			const abandoned = manager.appendMessage({ role: "user", content: "Abandoned", timestamp: 2 });
			createSession(undefined, false, manager);
			const reached = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const getApiKey = modelRegistry.getApiKey.bind(modelRegistry);
			vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (...args) => {
				reached.resolve();
				await release.promise;
				return getApiKey(...args);
			});
			const releaseFlush = Promise.withResolvers<void>();
			let btwBranch: Promise<BtwBranchResult> | undefined;
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
		createSession(
			undefined,
			false,
			manager,
			new ExtensionRunner([extension], runtime, manager.getCwd(), manager, modelRegistry),
		);
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

	it("does not dispatch a custom image prompt after aborting its normalization", async () => {
		createSession();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementationOnce(async images => {
			entered.resolve();
			await release.promise;
			return images;
		});
		const provider = vi.spyOn(session.agent, "streamFn");
		const prompt = session.promptCustomMessage({
			customType: "collab-prompt",
			content: [
				{ type: "text", text: "cancel this attachment" },
				{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
			],
			display: true,
			attribution: "user",
		});
		await entered.promise;
		const abort = session.abort();
		release.resolve();
		expect(await prompt).toBe(false);
		await abort;
		expect(provider).not.toHaveBeenCalled();
		expect(session.messages).toEqual([]);
	});

	for (const mode of ["steer", "followUp"] as const) {
		for (const stage of ["normalization", "description"] as const) {
			it(`drops ${mode} attachment preparation when abort overtakes ${stage}`, async () => {
				createSession(undefined, stage === "description");
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				if (stage === "normalization") {
					vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementationOnce(async images => {
						entered.resolve();
						await release.promise;
						return images;
					});
				} else {
					vi.spyOn(imageVisionFallback, "describeAttachedImagesForTextModel").mockImplementationOnce(async () => {
						entered.resolve();
						await release.promise;
						return [{ type: "text", text: "CANCELLED_IMAGE_DESCRIPTION" }];
					});
				}
				const provider = vi.spyOn(session.agent, "streamFn");
				const queued = session[mode]("CANCELLED_ATTACHMENT", [
					{
						type: "image",
						mimeType: "image/png",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=",
					},
				]);
				try {
					await entered.promise;
					await session.abort();
				} finally {
					release.resolve();
				}
				await queued;
				await session.waitForIdle();
				expect(provider).not.toHaveBeenCalled();
				expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
				expect(session.messages).toEqual([]);
			});
		}
	}

	it("resolves a queued prompt as unpublished when abort overtakes its attachment preparation", async () => {
		const active = Promise.withResolvers<void>();
		const finishActive = Promise.withResolvers<void>();
		createSession([
			async () => {
				active.resolve();
				await finishActive.promise;
				return { content: ["Active done"] };
			},
			{ content: ["Unexpected orphan turn"] },
		]);
		const run = session.prompt("ACTIVE_TURN");
		await active.promise;

		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementationOnce(async images => {
			entered.resolve();
			await release.promise;
			return images;
		});
		const queued = session.prompt("CANCELLED_QUEUED", {
			streamingBehavior: "steer",
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=",
				},
			],
		});
		await entered.promise;
		await session.abort();
		release.resolve();

		// An RPC caller waits on this result: reporting `true` for a prompt that
		// never reached a queue leaves it waiting for an `agent_end` that no
		// replacement turn will emit.
		expect(await queued).toBe(false);
		finishActive.resolve();
		await run.catch(() => undefined);
		await session.waitForIdle();
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
	});

	it("never publishes queued magic or vision companions without their cancelled user prompt", async () => {
		const active = Promise.withResolvers<void>();
		const finishActive = Promise.withResolvers<void>();
		createSession(
			[
				async () => {
					active.resolve();
					await finishActive.promise;
					return { content: ["Active done"] };
				},
				{ content: ["Unexpected orphan turn"] },
			],
			true,
		);
		const provider = vi.spyOn(session.agent, "streamFn");
		const run = session.prompt("ACTIVE_BEFORE_ATTACHMENT");
		await active.promise;
		const describing = Promise.withResolvers<void>();
		const finishDescription = Promise.withResolvers<void>();
		vi.spyOn(imageVisionFallback, "describeAttachedImagesForTextModel").mockImplementationOnce(async () => {
			describing.resolve();
			await finishDescription.promise;
			return [{ type: "text", text: "CANCELLED_IMAGE_DESCRIPTION" }];
		});
		const pending = session.prompt("ultrathink CANCELLED_USER", {
			streamingBehavior: "followUp",
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
				},
			],
		});
		try {
			await describing.promise;
			finishActive.resolve();
			await run;
			await session.waitForIdle();
			await session.abort();
		} finally {
			finishActive.resolve();
			finishDescription.resolve();
			await pending;
		}
		await session.waitForIdle();
		expect(provider).toHaveBeenCalledTimes(1);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		const transcript = JSON.stringify(session.messages);
		expect(transcript).not.toContain("ultrathink-notice");
		expect(transcript).not.toContain("image-attachment-description");
		expect(transcript).not.toContain("CANCELLED_USER");
	});

	it("keeps a skill's image companion and queue metadata together while an idle description is in flight", async () => {
		createSession(undefined, true);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const describeImages = vi
			.spyOn(imageVisionFallback, "describeAttachedImagesForTextModel")
			.mockImplementationOnce(async () => {
				entered.resolve();
				await release.promise;
				return [{ type: "text", text: "DESCRIBED_SKILL_IMAGE" }];
			});
		const image = {
			type: "image" as const,
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
		};
		const normalizedImages = (await imageLoading.normalizeModelContextImages([image], { model: session.model }))!;
		const skill: Pick<CustomMessage, "customType" | "content" | "display" | "details" | "attribution"> = {
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: [{ type: "text", text: "FIRST_SKILL" }, image],
			display: true,
			details: { name: "first", args: "image", path: "/skills/first/SKILL.md", lineCount: 1 },
			attribution: "user",
		};
		const first = session.promptCustomMessage(skill, { streamingBehavior: "steer" });
		await entered.promise;
		const queuedSkill = {
			...skill,
			content: "SECOND_SKILL",
			details: { name: "second", args: "queued", path: "/skills/second/SKILL.md", lineCount: 1 },
		};
		expect(
			await session.promptCustomMessage(queuedSkill, {
				streamingBehavior: "followUp",
				queueChipText: "/skill:second queued",
			}),
		).toBe(true);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: ["/skill:second queued"] });
		release.resolve();
		expect(await first).toBe(true);
		await session.waitForIdle();
		const custom = session.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" &&
				(message.customType === "image-attachment-description" || message.customType === SKILL_PROMPT_MESSAGE_TYPE),
		);
		expect(custom.map(message => message.customType)).toEqual([
			"image-attachment-description",
			SKILL_PROMPT_MESSAGE_TYPE,
			SKILL_PROMPT_MESSAGE_TYPE,
		]);
		expect(custom[1]).toMatchObject({
			content: [{ type: "text", text: "FIRST_SKILL" }, ...normalizedImages],
			details: skill.details,
			attribution: "user",
		});
		expect(custom[2]).toMatchObject({
			content: "SECOND_SKILL",
			details: { ...queuedSkill.details, __queueChipText: "/skill:second queued" },
			attribution: "user",
		});
		expect(describeImages).toHaveBeenCalledTimes(1);
	});

	it("restores an image skill from the queue without leaving its hidden companions behind", async () => {
		const active = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		createSession(
			[
				async () => {
					active.resolve();
					await release.promise;
					return { content: ["Active done"] };
				},
			],
			true,
		);
		vi.spyOn(imageVisionFallback, "describeAttachedImagesForTextModel").mockResolvedValueOnce([
			{ type: "text", text: "RESTORABLE_SKILL_IMAGE" },
		]);
		const run = session.prompt("active");
		await active.promise;
		const image = {
			type: "image" as const,
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
		};
		const normalizedImages = (await imageLoading.normalizeModelContextImages([image], { model: session.model }))!;
		await session.promptCustomMessage(
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: [{ type: "text", text: "QUEUED_SKILL" }, image],
				display: true,
				details: { name: "queued", args: "ultrathink" },
				attribution: "user",
			},
			{ streamingBehavior: "followUp", queueChipText: "/skill:queued ultrathink" },
		);
		try {
			const queued = session.agent.peekFollowUpQueue().filter(message => message.role === "custom");
			expect(queued.map(message => message.customType)).toEqual([
				"ultrathink-notice",
				"image-attachment-description",
				SKILL_PROMPT_MESSAGE_TYPE,
			]);
			expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: ["/skill:queued ultrathink"] });
			expect(session.clearQueue()).toEqual({
				steering: [],
				followUp: [{ text: "/skill:queued ultrathink", images: normalizedImages }],
			});
		} finally {
			release.resolve();
			await run;
		}
		expect(JSON.stringify(session.messages)).not.toContain("RESTORABLE_SKILL_IMAGE");
		expect(JSON.stringify(session.messages)).not.toContain("ultrathink-notice");
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	for (const transition of ["abort", "newSession"] as const) {
		it(`keeps an image aside across abort but not a session replacement: ${transition}`, async () => {
			createSession(undefined, true);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			vi.spyOn(imageVisionFallback, "describeAttachedImagesForTextModel").mockImplementationOnce(async () => {
				entered.resolve();
				await release.promise;
				return [{ type: "text", text: "ASIDE_IMAGE_DESCRIPTION" }];
			});
			const aside = session.promptCustomMessage(
				{
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: [
						{ type: "text", text: "ASIDE_SKILL" },
						{
							type: "image",
							mimeType: "image/png",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
						},
					],
					display: true,
					details: { name: "aside", args: "image" },
					attribution: "user",
				},
				{ queueOnly: true, streamingBehavior: "aside" },
			);
			await entered.promise;
			try {
				if (transition === "abort") await session.abort();
				else await session.newSession();
			} finally {
				release.resolve();
			}
			expect(await aside).toBe(transition === "abort");
			await session.waitForIdle();
			const custom = session.messages.filter(
				(message): message is CustomMessage =>
					message.role === "custom" &&
					(message.customType === "image-attachment-description" ||
						message.customType === SKILL_PROMPT_MESSAGE_TYPE),
			);
			if (transition === "abort") {
				expect(custom.map(message => message.customType)).toEqual([
					"image-attachment-description",
					SKILL_PROMPT_MESSAGE_TYPE,
				]);
				expect(custom[0]).toMatchObject({ attribution: "user", display: false });
				expect(custom[1]).toMatchObject({ attribution: "user", details: { name: "aside", args: "image" } });
			} else {
				expect(session.messages).toEqual([]);
				expect(session.agent.hasQueuedMessages()).toBe(false);
			}
		});
	}

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
