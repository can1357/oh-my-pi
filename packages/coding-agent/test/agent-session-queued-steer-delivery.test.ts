/**
 * Contract: a custom message steered into a streaming session (the collab-host
 * and skill-prompt path: `promptCustomMessage(..., { streamingBehavior: "steer" })`)
 * is always delivered — never silently stranded in the agent's steering queue.
 *
 * Two regression seams, both observed as "guest messages just disappear" in
 * collab sessions:
 *  1. A steer landing at the run's yield boundary (after the stop-boundary
 *     dequeue) must force another turn instead of stranding.
 *  2. A steer landing while the prompt unwinds (isStreaming stays true through
 *     post-prompt recovery, but the loop is already done) must be drained when
 *     the session settles.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as autoPrewalkClassifier from "@oh-my-pi/pi-coding-agent/auto-prewalk/classifier";
import * as autoThinkingClassifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { PromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { tryRunRpcSkillCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { cfgMagicKeyword, cfgMagicKeywordsEnabled } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, type CustomMessage, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgPrewalkAuto } from "@oh-my-pi/pi-coding-agent/session/settings";
import { tagImageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { AUTO_THINKING, resolveProvisionalAutoLevel } from "@oh-my-pi/pi-tui/thinking";
import { removeSyncWithRetries, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";
import manualContinuePrompt from "../src/prompts/system/manual-continue.md" with { type: "text" };
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const COLLAB_PROMPT_TYPE = "collab-prompt";
const IMAGE_SOURCE_PATH = "/tmp/private-project/screenshot.png";
/** A path-pasted image: its source path rides in a hidden `image-attachment` companion. */
const PATH_PASTED_IMAGE = tagImageAttachmentSource(
	{
		type: "image",
		mimeType: "image/png",
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
	},
	IMAGE_SOURCE_PATH,
	"image",
);

interface SteerHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
}

describe("AgentSession queued steer delivery", () => {
	let tempDir: string;
	let fixtureDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;

	beforeAll(async () => {
		fixtureDir = path.join(os.tmpdir(), `pi-steer-strand-fixture-${Snowflake.next()}`);
		fs.mkdirSync(fixtureDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(fixtureDir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir, "models.yml"));
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-steer-strand-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		removeSyncWithRetries(tempDir);
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(fixtureDir);
	});

	async function createSession(
		responses: MockHandler[],
		promptTemplates: PromptTemplate[] = [],
		modelId = "claude-sonnet-4-5",
		thinkingLevelCeiling?: Effort,
	): Promise<SteerHarness> {
		const model = getBundledModel("anthropic", modelId)!;
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false });

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			promptTemplates,
			thinkingLevelCeiling,
		});
		return { session, sessionManager, mock };
	}

	function queueCollabPrompt(
		target: AgentSession,
		text: string,
		streamingBehavior: "steer" | "followUp" = "steer",
		attribution: "user" | "agent" = "user",
	): Promise<boolean> {
		return target.promptCustomMessage(
			{
				customType: COLLAB_PROMPT_TYPE,
				content: text,
				display: true,
				details: { from: "guest" },
				attribution,
			},
			{ streamingBehavior },
		);
	}

	function pauseCollabPreparation(target: AgentSession, text: string) {
		const prepare = target.agent.prepareQueuedMessages;
		if (!prepare) throw new Error("Expected queued message preparation");
		const staged = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let paused = false;
		target.agent.prepareQueuedMessages = async (messages, signal, queue) => {
			const preparation = await prepare(messages, signal, queue);
			if (
				!paused &&
				messages.some(
					message =>
						message.role === "custom" && message.customType === COLLAB_PROMPT_TYPE && message.content === text,
				)
			) {
				paused = true;
				staged.resolve();
				await release.promise;
			}
			return preparation;
		};
		return { staged: staged.promise, release: release.resolve };
	}

	function controlLiveSteering(target: AgentSession, mock: MockModel) {
		const started = Promise.withResolvers<void>();
		const claimed = Promise.withResolvers<void>();
		const accepted = Promise.withResolvers<void>();
		const allowAccept = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let firstEffort: Effort | undefined;
		let claimedMessages = "";
		let calls = 0;
		target.agent.streamFn = async (model, context, options) => {
			if (calls++ > 0) return mock.stream(model, context, options);
			const live = options?.liveSteering;
			const signal = options?.signal;
			if (!live || !signal) throw new Error("Expected live steering");
			firstEffort = options?.reasoning;
			started.resolve();
			await live.wait(signal);
			const claim = await live.claim(signal);
			if (!claim) throw new Error("Expected a live steering claim");
			claimedMessages = JSON.stringify(claim.messages);
			claimed.resolve();
			await allowAccept.promise;
			claim.accept();
			accepted.resolve();
			await finish.promise;
			return mock.stream(model, context, options);
		};
		return {
			started: started.promise,
			claimed: claimed.promise,
			accepted: accepted.promise,
			accept: allowAccept.resolve,
			finish: finish.resolve,
			get firstEffort() {
				return firstEffort;
			},
			get claimedMessages() {
				return claimedMessages;
			},
		};
	}

	async function queueLiveUltrathink(target: AgentSession, origin: "typed" | "Collab", text: string): Promise<void> {
		if (origin === "typed") {
			await target.steer(text);
			return;
		}
		target.agent.steer({
			role: "custom",
			customType: COLLAB_PROMPT_TYPE,
			content: text,
			display: true,
			details: { from: "guest" },
			attribution: "user",
			timestamp: Date.now(),
		});
	}

	function nextUserMessage(target: AgentSession, expected: string): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = target.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "user") return;
			const content = event.message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("");
			if (text !== expected) return;
			unsubscribe();
			resolve();
		});
		return promise;
	}

	/** Resolves with the entry text when a collab-prompt entry is persisted. */
	function nextCollabEntry(sessionManager: SessionManager): Promise<string> {
		const { promise, resolve } = Promise.withResolvers<string>();
		sessionManager.onEntryAppended = entry => {
			if (entry.type === "custom_message" && entry.customType === COLLAB_PROMPT_TYPE) {
				resolve(typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content));
			}
		};
		return promise;
	}

	it("delivers a collab steer that lands at the run's yield boundary", async () => {
		const { session, sessionManager, mock } = await createSession([
			{ content: ["host answer"] },
			{ content: ["ack guest"] },
		]);
		const entryAppended = nextCollabEntry(sessionManager);

		let streamingAtInject: boolean | undefined;
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			// The session is still mid-prompt here, so this takes the steer path.
			streamingAtInject = session.isStreaming;
			await queueCollabPrompt(session, "guest steer at yield");
		});

		await session.prompt("hello");

		expect(streamingAtInject).toBe(true);
		expect(await entryAppended).toBe("guest steer at yield");
		expect(mock.calls.length).toBe(2);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	describe("queued Collab auto thinking", () => {
		for (const { modelId, expected } of [
			{ modelId: "claude-sonnet-4-5", expected: Effort.XHigh },
			{ modelId: "claude-opus-4-7", expected: Effort.Max },
		]) {
			for (const streamingBehavior of ["steer", "followUp"] as const) {
				it(`sends queued Collab ${streamingBehavior} ultrathink at ${expected} on ${modelId} under auto`, async () => {
					const { session, mock } = await createSession(
						[{ content: ["initial"] }, { content: ["guest response"] }],
						[],
						modelId,
					);
					cfgMagicKeywordsEnabled.set(session.settings, true);
					cfgMagicKeyword.ultrathink.set(session.settings, true);
					const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
					session.setThinkingLevel(AUTO_THINKING);
					session.setSteeringMode("one-at-a-time");
					session.agent.setFollowUpMode("one-at-a-time");

					const text = "guest asks to ultrathink about the problem";
					let levelWhenQueued: string | undefined;
					let injected = false;
					session.agent.setOnBeforeYield(async () => {
						if (injected) return;
						injected = true;
						await queueCollabPrompt(session, text, streamingBehavior);
						levelWhenQueued = session.thinkingLevel;
					});

					await session.prompt("initial request");
					await session.waitForIdle();

					expect(levelWhenQueued).toBe(Effort.Low);
					expect(mock.calls).toHaveLength(2);
					expect(mock.calls[0].options?.reasoning).toBe(Effort.Low);
					expect(JSON.stringify(mock.calls[1].context.messages)).toContain(text);
					expect(mock.calls[1].options?.reasoning).toBe(expected);
					expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
					expect(session.autoResolvedThinkingLevel()).toBe(expected);
					expect(classifier).toHaveBeenCalledTimes(1);
				});
			}
		}

		for (const origin of ["typed", "Collab"] as const) {
			it(`applies an accepted live ${origin} ultrathink to the next model request`, async () => {
				const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["steered"] }]);
				cfgMagicKeywordsEnabled.set(session.settings, true);
				cfgMagicKeyword.ultrathink.set(session.settings, true);
				const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
				session.setThinkingLevel(AUTO_THINKING);
				const live = controlLiveSteering(session, mock);
				const text = "live ultrathink request";
				const run = session.prompt("initial request");
				try {
					await withTimeout(live.started, 2_000, "first model request did not start");
					expect(live.firstEffort).toBe(Effort.Low);
					await queueLiveUltrathink(session, origin, text);
					await withTimeout(live.claimed, 2_000, "provider did not claim the steer");
					expect(live.claimedMessages).toContain(text);
					expect(session.getQueuedMessages().liveSteered).toBe(1);
					expect(session.agent.state.thinkingLevel).toBe(Effort.Low);
					live.accept();
					await withTimeout(live.accepted, 2_000, "provider did not accept the steer");
					expect(live.firstEffort).toBe(Effort.Low);
					live.finish();
					await run;
					await session.waitForIdle();

					expect(mock.calls).toHaveLength(2);
					expect(mock.calls[0].options?.reasoning).toBe(Effort.Low);
					expect(mock.calls[1].options?.reasoning).toBe(Effort.XHigh);
					expect(JSON.stringify(mock.calls[1].context.messages)).toContain(text);
					expect(classifier).toHaveBeenCalledTimes(1);
				} finally {
					live.accept();
					live.finish();
					if (session.agent.state.isStreaming) await session.abort({ reason: USER_INTERRUPT_LABEL });
					await run;
				}
			});

			it(`does not retain auto effort after an aborted live ${origin} ultrathink is restored and removed`, async () => {
				const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["ordinary"] }]);
				cfgMagicKeywordsEnabled.set(session.settings, true);
				cfgMagicKeyword.ultrathink.set(session.settings, true);
				const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
				session.setThinkingLevel(AUTO_THINKING);
				const live = controlLiveSteering(session, mock);
				const text = "live ultrathink to remove";
				const run = session.prompt("initial request");
				let restored = false;
				let removed = false;
				let unsubscribe: (() => void) | undefined;
				let interrupt: Promise<void> | undefined;
				try {
					await withTimeout(live.started, 2_000, "first model request did not start");
					await queueLiveUltrathink(session, origin, text);
					await withTimeout(live.claimed, 2_000, "provider did not claim the steer");
					expect(live.firstEffort).toBe(Effort.Low);
					expect(session.agent.state.thinkingLevel).toBe(Effort.Low);
					live.accept();
					await withTimeout(live.accepted, 2_000, "provider did not accept the steer");
					unsubscribe = session.agent.onQueueChange(() => {
						const queued = session.getQueuedMessages();
						if (restored || queued.liveSteered !== 0 || !queued.steering.includes(text)) return;
						restored = true;
						removed = session.removeQueuedMessage(text, "steering");
					});
					interrupt = session.abort({ reason: USER_INTERRUPT_LABEL });
					live.finish();
					await interrupt;
					await run;
					await session.waitForIdle();

					expect(restored).toBe(true);
					expect(removed).toBe(true);
					expect(session.agent.hasQueuedMessages()).toBe(false);
					expect(session.autoResolvedThinkingLevel()).toBe(Effort.Low);
					expect(session.agent.state.thinkingLevel).toBe(Effort.Low);
					await session.prompt("ordinary request");
					expect(mock.calls).toHaveLength(2);
					expect(mock.calls[0].options?.reasoning).toBe(Effort.Low);
					expect(mock.calls[1].options?.reasoning).toBe(Effort.Low);
					expect(JSON.stringify(mock.calls[1].context.messages)).not.toContain(text);
					expect(classifier).toHaveBeenCalledTimes(2);
				} finally {
					live.accept();
					live.finish();
					if (!interrupt && session.agent.state.isStreaming) {
						interrupt = session.abort({ reason: USER_INTERRUPT_LABEL });
					}
					if (interrupt) await interrupt;
					await run;
					unsubscribe?.();
				}
			});
		}

		it("raises auto effort for a Collab ultrathink delivered at a tool boundary", async () => {
			const { session, mock } = await createSession([
				{ content: [{ type: "toolCall", id: "call-1", name: "pause", arguments: { value: "work" } }] },
				{ content: ["steered"] },
			]);
			cfgMagicKeywordsEnabled.set(session.settings, true);
			cfgMagicKeyword.ultrathink.set(session.settings, true);
			const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
			session.setThinkingLevel(AUTO_THINKING);
			session.setInterruptMode("wait");
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const schema = type({ value: "string" });
			const tool: AgentTool<typeof schema> = {
				name: "pause",
				label: "Pause",
				description: "Wait for the queued steer",
				parameters: schema,
				concurrency: "exclusive",
				interruptible: false,
				async execute(_id, params) {
					started.resolve();
					await release.promise;
					return { content: [{ type: "text", text: params.value }], details: {} };
				},
			};
			session.agent.setTools([tool]);
			const text = "guest asks to ultrathink at the tool boundary";
			const run = session.prompt("initial request");
			try {
				await withTimeout(started.promise, 2_000, "tool did not start");
				expect(mock.calls[0].options?.reasoning).toBe(Effort.Low);
				await queueCollabPrompt(session, text);
				expect(session.agent.state.thinkingLevel).toBe(Effort.Low);
			} finally {
				release.resolve();
				await run;
			}
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(2);
			expect(mock.calls[1].options?.reasoning).toBe(Effort.XHigh);
			expect(JSON.stringify(mock.calls[1].context.messages)).toContain(text);
			expect(classifier).toHaveBeenCalledTimes(1);
		});

		for (const streamingBehavior of ["steer", "followUp"] as const) {
			it(`uses maximum auto effort for a typed queued ${streamingBehavior} ultrathink`, async () => {
				const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["typed response"] }]);
				cfgMagicKeywordsEnabled.set(session.settings, true);
				cfgMagicKeyword.ultrathink.set(session.settings, true);
				const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
				session.setThinkingLevel(AUTO_THINKING);
				session.setSteeringMode("one-at-a-time");
				session.agent.setFollowUpMode("one-at-a-time");
				let injected = false;
				session.agent.setOnBeforeYield(async () => {
					if (injected) return;
					injected = true;
					await session.prompt("typed ultrathink request", { streamingBehavior });
				});

				await session.prompt("initial request");
				await session.waitForIdle();

				expect(mock.calls).toHaveLength(2);
				expect(JSON.stringify(mock.calls[1].context.messages)).toContain("typed ultrathink request");
				expect(mock.calls[0].options?.reasoning).toBe(Effort.Low);
				expect(mock.calls[1].options?.reasoning).toBe(Effort.XHigh);
				expect(classifier).toHaveBeenCalledTimes(1);
			});
		}

		for (const origin of ["typed", "Collab"] as const) {
			it(`keeps the current auto effort without classifying an ordinary ${origin} steer`, async () => {
				const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["steered"] }]);
				const classifier = vi
					.spyOn(autoThinkingClassifier, "classifyDifficulty")
					.mockResolvedValueOnce(Effort.High)
					.mockResolvedValue(Effort.Low);
				session.setThinkingLevel(AUTO_THINKING);
				let injected = false;
				session.agent.setOnBeforeYield(async () => {
					if (injected) return;
					injected = true;
					if (origin === "typed") {
						await session.prompt("ordinary correction", { streamingBehavior: "steer" });
					} else {
						await queueCollabPrompt(session, "ordinary correction");
					}
				});

				await session.prompt("initial request");
				await session.waitForIdle();

				expect(mock.calls).toHaveLength(2);
				expect(JSON.stringify(mock.calls[1].context.messages)).toContain("ordinary correction");
				expect(mock.calls[0].options?.reasoning).toBe(Effort.High);
				expect(mock.calls[1].options?.reasoning).toBe(Effort.High);
				expect(session.autoResolvedThinkingLevel()).toBe(Effort.High);
				expect(classifier).toHaveBeenCalledTimes(1);
			});
		}

		for (const origin of ["synthetic user", "visible non-turn custom"] as const) {
			for (const streamingBehavior of ["steer", "followUp"] as const) {
				it(`ignores ${origin} ultrathink in a mixed queued ${streamingBehavior} batch`, async () => {
					const { session, mock } = await createSession([
						{ content: ["initial"] },
						{ content: ["queued response"] },
					]);
					cfgMagicKeywordsEnabled.set(session.settings, true);
					cfgMagicKeyword.ultrathink.set(session.settings, true);
					const classifier = vi
						.spyOn(autoThinkingClassifier, "classifyDifficulty")
						.mockResolvedValueOnce(Effort.High)
						.mockResolvedValue(Effort.Low);
					session.setThinkingLevel(AUTO_THINKING);
					session.setSteeringMode("all");
					session.agent.setFollowUpMode("all");
					const ignoredText = "injected ultrathink context";
					let injected = false;
					session.agent.setOnBeforeYield(async () => {
						if (injected) return;
						injected = true;
						if (origin === "synthetic user") {
							const message: AgentMessage = {
								role: "user",
								content: ignoredText,
								synthetic: true,
								attribution: "user",
								timestamp: Date.now(),
							};
							if (streamingBehavior === "steer") session.agent.steer(message);
							else session.agent.followUp(message);
						} else {
							await session.promptCustomMessage(
								{
									customType: "visible-non-turn",
									content: ignoredText,
									display: true,
									attribution: "user",
								},
								{ streamingBehavior },
							);
						}
						await queueCollabPrompt(session, "ordinary guest request", streamingBehavior);
					});

					await session.prompt("initial request");
					await session.waitForIdle();

					expect(mock.calls).toHaveLength(2);
					const delivered = JSON.stringify(mock.calls[1].context.messages);
					expect(delivered).toContain(ignoredText);
					expect(delivered).toContain("ordinary guest request");
					expect(mock.calls[1].options?.reasoning).toBe(streamingBehavior === "steer" ? Effort.High : Effort.Low);
					expect(classifier).toHaveBeenCalledTimes(streamingBehavior === "steer" ? 1 : 2);
				});
			}
		}

		it("uses maximum auto effort for ultrathink split across queued Collab text parts", async () => {
			const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["guest response"] }]);
			cfgMagicKeywordsEnabled.set(session.settings, true);
			cfgMagicKeyword.ultrathink.set(session.settings, true);
			const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
			session.setThinkingLevel(AUTO_THINKING);
			let injected = false;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await session.promptCustomMessage(
					{
						customType: COLLAB_PROMPT_TYPE,
						content: [
							{ type: "text", text: "guest requests ultra" },
							{ type: "text", text: "think about the fix" },
						],
						display: true,
						details: { from: "guest" },
						attribution: "user",
					},
					{ streamingBehavior: "steer" },
				);
			});

			await session.prompt("initial request");
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(2);
			const delivered = JSON.stringify(mock.calls[1].context.messages);
			expect(delivered).toContain("guest requests ultra");
			expect(delivered).toContain("think about the fix");
			expect(mock.calls[1].options?.reasoning).toBe(Effort.XHigh);
			expect(classifier).toHaveBeenCalledTimes(1);
		});

		it("respects the session effort ceiling for queued Collab ultrathink", async () => {
			const { session, mock } = await createSession(
				[{ content: ["initial"] }, { content: ["guest response"] }],
				[],
				"claude-opus-4-7",
				Effort.Medium,
			);
			cfgMagicKeywordsEnabled.set(session.settings, true);
			cfgMagicKeyword.ultrathink.set(session.settings, true);
			const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
			session.setThinkingLevel(AUTO_THINKING);
			let injected = false;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await queueCollabPrompt(session, "guest ultrathink request");
			});

			await session.prompt("initial request");
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(2);
			expect(JSON.stringify(mock.calls[1].context.messages)).toContain("guest ultrathink request");
			expect(mock.calls[1].options?.reasoning).toBe(Effort.Medium);
			expect(session.autoResolvedThinkingLevel()).toBe(Effort.Medium);
			expect(classifier).toHaveBeenCalledTimes(1);
		});

		for (const level of [Effort.Low, "off"] as const) {
			it(`keeps ${level} when queued Collab ultrathink is delivered with auto disabled`, async () => {
				const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["guest response"] }]);
				cfgMagicKeywordsEnabled.set(session.settings, true);
				cfgMagicKeyword.ultrathink.set(session.settings, true);
				const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.High);
				session.setThinkingLevel(level);
				let injected = false;
				session.agent.setOnBeforeYield(async () => {
					if (injected) return;
					injected = true;
					await queueCollabPrompt(session, "guest ultrathink request");
				});

				await session.prompt("initial request");
				await session.waitForIdle();

				expect(mock.calls).toHaveLength(2);
				expect(JSON.stringify(mock.calls[1].context.messages)).toContain("guest ultrathink request");
				expect(mock.calls[1].options?.reasoning).toBe(level === "off" ? undefined : level);
				if (level === "off") expect(mock.calls[1].options?.disableReasoning).toBe(true);
				expect(session.configuredThinkingLevel()).toBe(level);
				expect(classifier).not.toHaveBeenCalled();
			});
		}

		it("does not raise auto effort for an agent-attributed Collab ultrathink", async () => {
			const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["guest response"] }]);
			cfgMagicKeywordsEnabled.set(session.settings, true);
			cfgMagicKeyword.ultrathink.set(session.settings, true);
			const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
			session.setThinkingLevel(AUTO_THINKING);
			let injected = false;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await queueCollabPrompt(session, "agent ultrathink request", "steer", "agent");
			});

			await session.prompt("initial request");
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(2);
			expect(JSON.stringify(mock.calls[1].context.messages)).toContain("agent ultrathink request");
			expect(mock.calls[1].options?.reasoning).toBe(Effort.Low);
			expect(session.autoResolvedThinkingLevel()).toBe(Effort.Low);
			expect(classifier).toHaveBeenCalledTimes(1);
		});

		it("ignores agent-attributed ultrathink in a mixed queued Collab batch", async () => {
			const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["guest response"] }]);
			cfgMagicKeywordsEnabled.set(session.settings, true);
			cfgMagicKeyword.ultrathink.set(session.settings, true);
			const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
			session.setThinkingLevel(AUTO_THINKING);
			session.setSteeringMode("all");
			let injected = false;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await queueCollabPrompt(session, "agent ultrathink request", "steer", "agent");
				await queueCollabPrompt(session, "ordinary guest request");
			});

			await session.prompt("initial request");
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(2);
			const delivered = JSON.stringify(mock.calls[1].context.messages);
			expect(delivered).toContain("agent ultrathink request");
			expect(delivered).toContain("ordinary guest request");
			expect(mock.calls[1].options?.reasoning).toBe(Effort.Low);
			expect(classifier).toHaveBeenCalledTimes(1);
		});

		it("classifies queued Collab ultrathink normally when the keyword is disabled", async () => {
			const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["guest response"] }]);
			cfgMagicKeywordsEnabled.set(session.settings, true);
			cfgMagicKeyword.ultrathink.set(session.settings, false);
			const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
			session.setThinkingLevel(AUTO_THINKING);
			let injected = false;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await queueCollabPrompt(session, "guest ultrathink request", "followUp");
			});

			await session.prompt("initial request");
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(2);
			expect(JSON.stringify(mock.calls[1].context.messages)).toContain("guest ultrathink request");
			expect(mock.calls[1].options?.reasoning).toBe(Effort.Low);
			expect(classifier).toHaveBeenCalledTimes(2);
		});

		it("does not classify a Collab ultrathink steer when the keyword is disabled", async () => {
			const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["steered"] }]);
			cfgMagicKeywordsEnabled.set(session.settings, true);
			cfgMagicKeyword.ultrathink.set(session.settings, false);
			const classifier = vi
				.spyOn(autoThinkingClassifier, "classifyDifficulty")
				.mockResolvedValueOnce(Effort.High)
				.mockResolvedValue(Effort.Low);
			session.setThinkingLevel(AUTO_THINKING);
			let injected = false;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await queueCollabPrompt(session, "guest ultrathink request");
			});

			await session.prompt("initial request");
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(2);
			expect(JSON.stringify(mock.calls[1].context.messages)).toContain("guest ultrathink request");
			expect(mock.calls[1].options?.reasoning).toBe(Effort.High);
			expect(classifier).toHaveBeenCalledTimes(1);
		});

		it("reclassifies the next queued Collab follow-up after ultrathink", async () => {
			const { session, mock } = await createSession([
				{ content: ["initial"] },
				{ content: ["ultrathink response"] },
				{ content: ["ordinary response"] },
			]);
			cfgMagicKeywordsEnabled.set(session.settings, true);
			cfgMagicKeyword.ultrathink.set(session.settings, true);
			const classifier = vi
				.spyOn(autoThinkingClassifier, "classifyDifficulty")
				.mockResolvedValueOnce(Effort.Low)
				.mockResolvedValueOnce(Effort.Medium);
			session.setThinkingLevel(AUTO_THINKING);
			session.agent.setFollowUpMode("one-at-a-time");
			let injected = false;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await queueCollabPrompt(session, "first guest asks ultrathink", "followUp");
				await queueCollabPrompt(session, "second guest asks a routine question", "followUp");
			});

			await session.prompt("initial request");
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(3);
			expect(mock.calls[0].options?.reasoning).toBe(Effort.Low);
			expect(mock.calls[1].options?.reasoning).toBe(Effort.XHigh);
			expect(mock.calls[2].options?.reasoning).toBe(Effort.Medium);
			expect(JSON.stringify(mock.calls[1].context.messages)).toContain("first guest asks ultrathink");
			expect(JSON.stringify(mock.calls[2].context.messages)).toContain("second guest asks a routine question");
			expect(classifier).toHaveBeenCalledTimes(2);
		});

		for (const origin of ["typed", "Collab"] as const) {
			for (const order of ["steer first", "follow-up first"] as const) {
				it(`keeps ${origin} ultrathink over a combined ordinary follow-up when queued ${order}`, async () => {
					const { session, mock } = await createSession([
						{ content: ["initial"] },
						{ content: ["combined"] },
						{ content: ["later"] },
					]);
					cfgMagicKeywordsEnabled.set(session.settings, true);
					cfgMagicKeyword.ultrathink.set(session.settings, true);
					const classifier = vi
						.spyOn(autoThinkingClassifier, "classifyDifficulty")
						.mockResolvedValueOnce(Effort.Low)
						.mockResolvedValueOnce(Effort.Low)
						.mockResolvedValueOnce(Effort.Medium);
					session.setThinkingLevel(AUTO_THINKING);
					session.setSteeringMode("one-at-a-time");
					session.agent.setFollowUpMode("one-at-a-time");
					const steerText = "ultrathink about the combined request";
					const firstFollowUp = "first ordinary follow-up";
					const laterFollowUp = "later ordinary follow-up";
					let yields = 0;
					session.agent.setOnBeforeYield(async () => {
						yields++;
						if (yields === 1) {
							const operations: Array<"steer" | "followUp"> =
								order === "steer first" ? ["steer", "followUp"] : ["followUp", "steer"];
							for (const operation of operations) {
								if (operation === "followUp") {
									await session.prompt(firstFollowUp, { streamingBehavior: "followUp" });
								} else if (origin === "typed") {
									await session.prompt(steerText, { streamingBehavior: "steer" });
								} else {
									await queueCollabPrompt(session, steerText);
								}
							}
						} else if (yields === 2) {
							await session.prompt(laterFollowUp, { streamingBehavior: "followUp" });
						}
					});

					await session.prompt("initial request");
					await session.waitForIdle();

					expect(mock.calls).toHaveLength(3);
					expect(mock.calls[0].options?.reasoning).toBe(Effort.Low);
					expect(mock.calls[1].options?.reasoning).toBe(Effort.XHigh);
					expect(mock.calls[2].options?.reasoning).toBe(Effort.Medium);
					const combined = JSON.stringify(mock.calls[1].context.messages);
					expect(combined).toContain(steerText);
					expect(combined).toContain(firstFollowUp);
					expect(combined).not.toContain(laterFollowUp);
					expect(JSON.stringify(mock.calls[2].context.messages)).toContain(laterFollowUp);
					expect(classifier).toHaveBeenCalledTimes(3);
					expect(classifier.mock.calls[1][0].request).toBe(firstFollowUp);
					expect(classifier.mock.calls[2][0].request).toBe(laterFollowUp);
				});
			}
		}

		for (const origin of ["typed", "Collab"] as const) {
			it(`retains ${origin} ultrathink across a gate-stopped combined request and resume`, async () => {
				const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["resumed"] }]);
				cfgMagicKeywordsEnabled.set(session.settings, true);
				cfgMagicKeyword.ultrathink.set(session.settings, true);
				const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
				session.setThinkingLevel(AUTO_THINKING);
				let gateCalls = 0;
				session.agent.setBeforeModelCall(() => {
					if (++gateCalls === 2) return { stop: true, reason: "test gate" };
				});
				const steerText = "ultrathink about the gated request";
				const followUpText = "ordinary follow-up";
				let injected = false;
				session.agent.setOnBeforeYield(async () => {
					if (injected) return;
					injected = true;
					if (origin === "typed") {
						await session.prompt(steerText, { streamingBehavior: "steer" });
					} else {
						await queueCollabPrompt(session, steerText);
					}
					await session.prompt(followUpText, { streamingBehavior: "followUp" });
				});

				await session.prompt("initial request");
				await session.waitForIdle();

				expect(gateCalls).toBe(2);
				expect(mock.calls).toHaveLength(1);
				const recorded = JSON.stringify(session.messages);
				expect(recorded).toContain(steerText);
				expect(recorded).toContain(followUpText);
				expect(session.autoResolvedThinkingLevel()).toBe(Effort.XHigh);

				await session.resume();
				await session.waitForIdle();

				expect(mock.calls).toHaveLength(2);
				expect(mock.calls[1].options?.reasoning).toBe(Effort.XHigh);
				const resumed = JSON.stringify(mock.calls[1].context.messages);
				expect(resumed).toContain(steerText);
				expect(resumed).toContain(followUpText);
				expect(classifier).toHaveBeenCalledTimes(2);
				expect(classifier.mock.calls[1][0].request).toBe(followUpText);
			});
		}

		it("classifies a combined ordinary follow-up when Collab ultrathink is disabled", async () => {
			const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["combined"] }]);
			cfgMagicKeywordsEnabled.set(session.settings, true);
			cfgMagicKeyword.ultrathink.set(session.settings, false);
			const classifier = vi
				.spyOn(autoThinkingClassifier, "classifyDifficulty")
				.mockResolvedValueOnce(Effort.High)
				.mockResolvedValueOnce(Effort.Low);
			session.setThinkingLevel(AUTO_THINKING);
			let injected = false;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await queueCollabPrompt(session, "guest asks to ultrathink");
				await session.prompt("ordinary follow-up", { streamingBehavior: "followUp" });
			});

			await session.prompt("initial request");
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(2);
			expect(mock.calls[0].options?.reasoning).toBe(Effort.High);
			expect(mock.calls[1].options?.reasoning).toBe(Effort.Low);
			const combined = JSON.stringify(mock.calls[1].context.messages);
			expect(combined).toContain("guest asks to ultrathink");
			expect(combined).toContain("ordinary follow-up");
			expect(classifier).toHaveBeenCalledTimes(2);
		});

		it("uses maximum Collab effort for a mixed follow-up prepared with auto prewalk", async () => {
			const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["follow-up response"] }]);
			cfgMagicKeywordsEnabled.set(session.settings, true);
			cfgMagicKeyword.ultrathink.set(session.settings, true);
			cfgPrewalkAuto.set(session.settings, "suggest");
			const prewalk = vi.spyOn(autoPrewalkClassifier, "classifyAutoPrewalk").mockResolvedValue(undefined);
			const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
			session.setThinkingLevel(AUTO_THINKING);
			session.agent.setFollowUpMode("all");
			let injected = false;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await queueCollabPrompt(session, "guest asks to ultrathink", "followUp");
				await session.prompt("ordinary typed follow-up", { streamingBehavior: "followUp" });
			});

			await session.prompt("initial request");
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(2);
			const delivered = JSON.stringify(mock.calls[1].context.messages);
			expect(delivered).toContain("guest asks to ultrathink");
			expect(delivered).toContain("ordinary typed follow-up");
			expect(mock.calls[1].options?.reasoning).toBe(Effort.XHigh);
			expect(prewalk).toHaveBeenCalledTimes(2);
			expect(prewalk.mock.calls[1][0].request).toContain("ordinary typed follow-up");
			expect(classifier).toHaveBeenCalledTimes(1);
		});

		for (const streamingBehavior of ["steer", "followUp"] as const) {
			it(`does not commit auto effort for a cancelled claimed Collab ${streamingBehavior} ultrathink`, async () => {
				const { session, sessionManager, mock } = await createSession([
					{ content: ["initial"] },
					{ content: ["ordinary response"] },
				]);
				cfgMagicKeywordsEnabled.set(session.settings, true);
				cfgMagicKeyword.ultrathink.set(session.settings, true);
				const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
				let thinkingEventCount = 0;
				session.subscribe(event => {
					if (event.type === "thinking_level_changed") thinkingEventCount++;
				});
				session.setThinkingLevel(AUTO_THINKING);
				const text = "cancel guest ultrathink request";
				const pause = pauseCollabPreparation(session, text);
				let priorThinkingEvents = -1;
				let priorThinkingEntries = -1;
				let injected = false;
				session.agent.setOnBeforeYield(async () => {
					if (injected) return;
					injected = true;
					priorThinkingEvents = thinkingEventCount;
					priorThinkingEntries = sessionManager
						.getEntries()
						.filter(entry => entry.type === "thinking_level_change").length;
					await queueCollabPrompt(session, text, streamingBehavior);
				});

				const run = session.prompt("initial request");
				try {
					await withTimeout(pause.staged, 2_000, "queued Collab preparation did not finish");
					expect(session.autoResolvedThinkingLevel()).toBe(Effort.Low);
					expect(session.agent.state.thinkingLevel).toBe(Effort.Low);
					expect(session.removeQueuedMessage(text, streamingBehavior === "steer" ? "steering" : "followUp")).toBe(
						true,
					);
				} finally {
					pause.release();
					await run;
				}
				await session.waitForIdle();
				expect(mock.calls).toHaveLength(1);
				expect(session.autoResolvedThinkingLevel()).toBe(Effort.Low);
				expect(priorThinkingEvents).toBeGreaterThan(0);
				expect(priorThinkingEntries).toBeGreaterThan(0);
				expect(thinkingEventCount).toBe(priorThinkingEvents);
				expect(sessionManager.getEntries().filter(entry => entry.type === "thinking_level_change")).toHaveLength(
					priorThinkingEntries,
				);

				await session.prompt("ordinary request");
				expect(mock.calls).toHaveLength(2);
				expect(mock.calls[1].options?.reasoning).toBe(Effort.Low);
				expect(JSON.stringify(mock.calls[1].context.messages)).not.toContain(text);
				expect(classifier).toHaveBeenCalledTimes(2);
			});
		}

		it("cancels a queued Collab classification without applying its late result", async () => {
			const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["ordinary response"] }]);
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const text = "cancel the ordinary guest request";
			let classifierSignal: AbortSignal | undefined;
			const classifier = vi
				.spyOn(autoThinkingClassifier, "classifyDifficulty")
				.mockImplementation(async (input, deps) => {
					if (input.request === text) {
						classifierSignal = deps.signal;
						started.resolve();
						await release.promise;
						return Effort.XHigh;
					}
					return Effort.Low;
				});
			session.setThinkingLevel(AUTO_THINKING);
			let injected = false;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await queueCollabPrompt(session, text, "followUp");
			});

			const run = session.prompt("initial request");
			try {
				await withTimeout(started.promise, 2_000, "queued Collab classification did not start");
				expect(session.removeQueuedMessage(text, "followUp")).toBe(true);
				expect(classifierSignal?.aborted).toBe(true);
			} finally {
				release.resolve();
				await run;
			}
			await session.waitForIdle();
			expect(mock.calls).toHaveLength(1);
			expect(session.autoResolvedThinkingLevel()).toBe(Effort.Low);

			await session.prompt("ordinary request");
			expect(mock.calls).toHaveLength(2);
			expect(mock.calls[1].options?.reasoning).toBe(Effort.Low);
			expect(JSON.stringify(mock.calls[1].context.messages)).not.toContain(text);
			expect(classifier).toHaveBeenCalledTimes(3);
		});

		it("keeps a pinned effort when auto is disabled during claimed Collab preparation", async () => {
			const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["guest response"] }]);
			cfgMagicKeywordsEnabled.set(session.settings, true);
			cfgMagicKeyword.ultrathink.set(session.settings, true);
			const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
			session.setThinkingLevel(AUTO_THINKING);
			const text = "guest ultrathink request";
			const pause = pauseCollabPreparation(session, text);
			let injected = false;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await queueCollabPrompt(session, text);
			});

			const run = session.prompt("initial request");
			try {
				await withTimeout(pause.staged, 2_000, "queued Collab preparation did not finish");
				expect(session.autoResolvedThinkingLevel()).toBe(Effort.Low);
				session.setThinkingLevel(Effort.Low);
			} finally {
				pause.release();
				await run;
			}
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(2);
			expect(JSON.stringify(mock.calls[1].context.messages)).toContain(text);
			expect(mock.calls[1].options?.reasoning).toBe(Effort.Low);
			expect(session.configuredThinkingLevel()).toBe(Effort.Low);
			expect(session.autoResolvedThinkingLevel()).toBeUndefined();
			expect(classifier).toHaveBeenCalledTimes(1);
		});

		it("does not apply a stale Collab effort after auto is disabled and re-enabled during preparation", async () => {
			const { session, mock } = await createSession(
				[{ content: ["initial"] }, { content: ["guest response"] }],
				[],
				"claude-opus-4-7",
			);
			cfgMagicKeywordsEnabled.set(session.settings, true);
			cfgMagicKeyword.ultrathink.set(session.settings, true);
			const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
			session.setThinkingLevel(AUTO_THINKING);
			const text = "guest ultrathink request";
			const pause = pauseCollabPreparation(session, text);
			const expected = resolveProvisionalAutoLevel(session.model);
			expect(expected).toBeDefined();
			expect(expected).not.toBe(Effort.Max);
			let injected = false;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await queueCollabPrompt(session, text);
			});

			const run = session.prompt("initial request");
			try {
				await withTimeout(pause.staged, 2_000, "queued Collab preparation did not finish");
				expect(session.autoResolvedThinkingLevel()).toBe(Effort.Low);
				session.setThinkingLevel(Effort.Low);
				session.setThinkingLevel(AUTO_THINKING);
				expect(session.agent.state.thinkingLevel).toBe(expected);
			} finally {
				pause.release();
				await run;
			}
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(2);
			expect(JSON.stringify(mock.calls[1].context.messages)).toContain(text);
			expect(mock.calls[1].options?.reasoning).toBe(expected);
			expect(session.configuredThinkingLevel()).toBe(AUTO_THINKING);
			expect(session.autoResolvedThinkingLevel()).toBeUndefined();
			expect(classifier).toHaveBeenCalledTimes(1);
		});

		it("does not apply a stale model effort to a claimed Collab ultrathink", async () => {
			const { session, mock } = await createSession(
				[{ content: ["initial"] }, { content: ["guest response"] }],
				[],
				"claude-opus-4-7",
			);
			cfgMagicKeywordsEnabled.set(session.settings, true);
			cfgMagicKeyword.ultrathink.set(session.settings, true);
			const classifier = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
			session.setThinkingLevel(AUTO_THINKING);
			const text = "guest ultrathink request";
			const pause = pauseCollabPreparation(session, text);
			const replacement = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			const expected = resolveProvisionalAutoLevel(replacement);
			expect(expected).toBeDefined();
			expect(expected).not.toBe(Effort.Max);
			let injected = false;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await queueCollabPrompt(session, text);
			});

			const run = session.prompt("initial request");
			try {
				await withTimeout(pause.staged, 2_000, "queued Collab preparation did not finish");
				await session.setModelTemporary(replacement, AUTO_THINKING);
				expect(session.agent.state.thinkingLevel).toBe(expected);
			} finally {
				pause.release();
				await run;
			}
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(2);
			expect(JSON.stringify(mock.calls[1].context.messages)).toContain(text);
			expect(session.model?.id).toBe(replacement.id);
			expect(mock.calls[1].options?.reasoning).toBe(expected);
			expect(session.autoResolvedThinkingLevel()).toBeUndefined();
			expect(classifier).toHaveBeenCalledTimes(1);
		});
	});

	// `.`/`c` on a running turn interrupts it and continues. A host driving the
	// session to a result (the subagent executor) awaits the interrupted prompt,
	// then waitForIdle(): reporting idle between the interrupt and the
	// continuation would end its run on the interrupted turn.
	it("resume interrupts a streaming request and reruns the unanswered prompt without an idle gap", async () => {
		const turnStarted = Promise.withResolvers<void>();
		const { session, mock } = await createSession([
			() => {
				turnStarted.resolve();
				return { content: ["slow response"], delayMs: 60_000 };
			},
			{ content: ["resumed"] },
		]);

		const run = session.prompt("hello");
		await turnStarted.promise;
		const resumed = session.resume();
		await run;
		await session.waitForIdle();

		expect(mock.calls.length).toBe(2);
		expect(JSON.stringify(mock.calls[1].context.messages)).not.toContain("<system-notice>");
		expect(session.getLastAssistantMessage()?.content).toEqual([{ type: "text", text: "resumed" }]);
		await resumed;
	});

	it("resume interrupts a running tool and continues with the hidden directive without an idle gap", async () => {
		const toolStarted = Promise.withResolvers<void>();
		const { session, mock } = await createSession([
			{ content: ["checking", { type: "toolCall", id: "pause", name: "pause", arguments: {} }] },
			{ content: ["resumed"] },
		]);
		const schema = type({});
		const tool: AgentTool<typeof schema> = {
			name: "pause",
			label: "Pause",
			description: "Wait for interruption",
			parameters: schema,
			async execute(_id, _params, signal) {
				const aborted = Promise.withResolvers<void>();
				signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				toolStarted.resolve();
				await aborted.promise;
				return { content: [{ type: "text", text: "interrupted" }], details: {} };
			},
		};
		session.agent.setTools([tool]);

		const run = session.prompt("hello");
		await withTimeout(toolStarted.promise, 2_000, "tool did not start");
		const resumed = session.resume();
		await run;
		await withTimeout(session.waitForIdle(), 2_000, "continuation did not finish");

		expect(mock.calls.length).toBe(2);
		expect(JSON.stringify(mock.calls[1].context.messages)).toContain(
			JSON.stringify(manualContinuePrompt).slice(1, -1),
		);
		expect(session.getLastAssistantMessage()?.content).toEqual([{ type: "text", text: "resumed" }]);
		await resumed;
	});

	it("persists an agent-authored steer with its steering marker", async () => {
		const { session, sessionManager } = await createSession([
			{ content: ["host answer"] },
			{ content: ["ack parent"] },
		]);
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			await session.sendUserMessage("parent budget notice", {
				deliverAs: "steer",
				attribution: "agent",
			});
		});

		await session.prompt("hello");

		const entry = sessionManager.getEntries().find(candidate => {
			if (candidate.type !== "message" || candidate.message.role !== "user") return false;
			const content = candidate.message.content;
			return (
				Array.isArray(content) && content.some(part => part.type === "text" && part.text === "parent budget notice")
			);
		});
		if (entry?.type !== "message" || entry.message.role !== "user") {
			throw new Error("Expected persisted parent steer");
		}
		expect(entry.message.attribution).toBe("agent");
		expect(entry.message.steering).toBe(true);
	});

	it("defaults direct user steers and idle prompts to user attribution", async () => {
		const { session } = await createSession([{ content: ["ack user"] }]);

		await session.sendUserMessage("typed normally");
		const promptMessage = session.state.messages.find(candidate => {
			if (candidate.role !== "user") return false;
			const content = candidate.content;
			return (
				content === "typed normally" ||
				(Array.isArray(content) && content.some(part => part.type === "text" && part.text === "typed normally"))
			);
		});
		if (promptMessage?.role !== "user") {
			throw new Error("Expected user prompt in session state");
		}
		expect(promptMessage.attribution).toBe("user");

		await session.steer("user steer");
		const steer = session.agent.popLastSteer();
		if (steer?.role !== "user") throw new Error("Expected queued user steer");
		expect(steer.attribution).toBe("user");
		expect(steer.steering).toBe(true);
	});

	it("preserves explicit agent attribution across queued text-message APIs", async () => {
		const { session } = await createSession([]);

		await session.steer("parent steer", undefined, { attribution: "agent" });
		const steer = session.agent.popLastSteer();
		if (steer?.role !== "user") throw new Error("Expected queued agent-attributed steer");
		expect(steer.attribution).toBe("agent");
		expect(steer.steering).toBe(true);

		await session.followUp("parent follow-up", undefined, { attribution: "agent" });
		const followUp = session.agent.popLastFollowUp();
		if (followUp?.role !== "user") throw new Error("Expected queued agent-attributed follow-up");
		expect(followUp.attribution).toBe("agent");

		await session.sendUserMessage("host steer", { deliverAs: "steer", attribution: "agent" });
		const hostSteer = session.agent.popLastSteer();
		if (hostSteer?.role !== "user") throw new Error("Expected queued host steer");
		expect(hostSteer.attribution).toBe("agent");
	});

	it("drains a steer stranded in the agent queue when the session settles", async () => {
		const { session, sessionManager, mock } = await createSession([
			{ content: ["host answer"] },
			{ content: ["ack guest"] },
		]);
		const entryAppended = nextCollabEntry(sessionManager);

		// Inject from the wire agent_end subscriber: it fires synchronously while
		// the session settles (#promptInFlightCount just hit 0), after the agent
		// loop's final queue poll — a message queued here is invisible to the run
		// and must be picked up by the settle-time drain.
		const secondRunDone = Promise.withResolvers<void>();
		let agentEnds = 0;
		session.subscribe(event => {
			if (event.type !== "agent_end") return;
			agentEnds++;
			if (agentEnds === 1) {
				session.agent.steer({
					role: "custom",
					customType: COLLAB_PROMPT_TYPE,
					content: "guest steer at settle",
					display: true,
					details: { from: "guest" },
					attribution: "user",
					timestamp: Date.now(),
				});
			} else if (agentEnds === 2) {
				secondRunDone.resolve();
			}
		});

		await session.prompt("hello");
		expect(await entryAppended).toBe("guest steer at settle");
		await secondRunDone.promise;

		expect(mock.calls.length).toBe(2);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("drains steering left after aborting an auto-continued queued turn", async () => {
		const { session, mock } = await createSession([
			{ content: ["initial response"] },
			{ content: ["first queued response"], delayMs: 1_000 },
			{ content: ["second queued response"] },
		]);
		await session.prompt("hello");
		expect(mock.calls.length).toBe(1);

		const firstDelivered = nextUserMessage(session, "first queued");
		await session.steer("first queued");
		await firstDelivered;
		expect(mock.calls.length).toBe(2);

		await session.steer("second queued");
		expect(session.getQueuedMessages().steering).toContain("second queued");

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();

		expect(
			session.agent.state.messages.some(message => message.role === "assistant" && message.stopReason === "aborted"),
		).toBe(true);

		expect(mock.calls.length).toBe(3);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.getQueuedMessages().steering).toEqual([]);
	});

	// Interrupt-and-send (empty Enter with a queued steer): the abort's own drain
	// resumes the run, so its settle must not read as a stop — otherwise the UI
	// flips to idle (title, OSC 7501, loader) for one frame before the steer runs.
	it("settles an interrupt non-terminally when a queued steer resumes the run", async () => {
		const { session } = await createSession([
			{ content: ["slow response"], delayMs: 1_000 },
			{ content: ["steered response"] },
		]);
		const settles: Array<boolean | undefined> = [];
		const streaming = Promise.withResolvers<void>();
		const steered = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "message_start" && event.message.role === "assistant") streaming.resolve();
			if (event.type !== "agent_end") return;
			settles.push(event.isTerminal);
			if (settles.length === 2) steered.resolve();
		});

		const run = session.prompt("hello").catch(() => {});
		await withTimeout(streaming.promise, 2_000, "first turn never streamed");
		await session.steer("change course");
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await withTimeout(steered.promise, 2_000, "queued steer never resumed the run");
		await run;

		expect(settles).toEqual([false, true]);
	});

	// A host driving the session to a result (the subagent executor) awaits the
	// interrupted prompt, then waitForIdle(). The steer's turn is scheduled only as
	// abort() finishes unwinding; reporting idle before then ended a subagent run on
	// the interrupted turn and dropped the steer.
	it("stays busy through an interrupt's unwind until the queued steer is answered", async () => {
		const turnStarted = Promise.withResolvers<void>();
		const { session, mock } = await createSession([
			() => {
				turnStarted.resolve();
				return { content: ["slow response"], delayMs: 60_000 };
			},
			{ content: ["steered response"] },
		]);

		const run = session.prompt("hello");
		await turnStarted.promise;
		await session.steer("change course");
		const interrupt = session.abort({ reason: USER_INTERRUPT_LABEL });
		await run;
		await session.waitForIdle();

		expect(mock.calls.length).toBe(2);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
		await interrupt;
	});

	it("answers a message submitted and forced with Enter while a tool is running", async () => {
		const { session, mock } = await createSession([
			{ content: [{ type: "toolCall", id: "pause", name: "pause", arguments: {} }] },
			{ content: ["answered steering"] },
		]);
		const toolStarted = Promise.withResolvers<void>();
		const releaseTool = Promise.withResolvers<void>();
		const schema = type({});
		const tool: AgentTool<typeof schema> = {
			name: "pause",
			label: "Pause",
			description: "Wait for interruption",
			parameters: schema,
			async execute(_id, _params, signal) {
				signal?.addEventListener("abort", () => releaseTool.resolve(), { once: true });
				toolStarted.resolve();
				await releaseTool.promise;
				return { content: [{ type: "text", text: "interrupted" }], details: {} };
			},
		};
		session.agent.setTools([tool]);
		const ctx = createInteractiveModeContext({
			session,
			sessionManager: session.sessionManager,
			editor: {
				pendingImages: [],
				pendingImageLinks: [],
				addToHistory: () => {},
			},
			withLocalSubmission: async (_text, submit) => submit(),
			hasActiveBtw: () => false,
			hasActiveOmfg: () => false,
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		const run = session.prompt("start");
		try {
			await withTimeout(toolStarted.promise, 2_000, "tool did not start");
			await ctx.editor.onSubmit?.("change direction");
			await ctx.editor.onSubmit?.("");
			await withTimeout(session.waitForIdle(), 2_000, "steer did not finish");
			await run;
			expect(mock.calls).toHaveLength(2);
			expect(JSON.stringify(mock.calls[1].context.messages)).toContain("change direction");
			expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
		} finally {
			releaseTool.resolve();
		}
	});

	it("answers a queued follow-up when an empty submit interrupts the running tool", async () => {
		const { session, mock } = await createSession([
			{ content: [{ type: "toolCall", id: "pause", name: "pause", arguments: {} }] },
			{ content: ["answered follow-up"] },
		]);
		const toolStarted = Promise.withResolvers<void>();
		const releaseTool = Promise.withResolvers<void>();
		const schema = type({});
		const tool: AgentTool<typeof schema> = {
			name: "pause",
			label: "Pause",
			description: "Wait for interruption",
			parameters: schema,
			async execute(_id, _params, signal) {
				signal?.addEventListener("abort", () => releaseTool.resolve(), { once: true });
				toolStarted.resolve();
				await releaseTool.promise;
				return { content: [{ type: "text", text: "interrupted" }], details: {} };
			},
		};
		session.agent.setTools([tool]);
		const run = session.prompt("start");
		try {
			await withTimeout(toolStarted.promise, 2_000, "tool did not start");
			await session.followUp("change direction");
			await withTimeout(
				session.abort({ reason: USER_INTERRUPT_LABEL, deliverQueuedMessages: true }),
				2_000,
				"interrupt did not finish",
			);
			await withTimeout(session.waitForIdle(), 2_000, "follow-up did not finish");
			await run;
			expect(mock.calls).toHaveLength(2);
			expect(JSON.stringify(mock.calls[1].context.messages)).toContain("change direction");
			expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
		} finally {
			releaseTool.resolve();
		}
	});

	for (const throwOnAbort of [false, true]) {
		it(`answers a steer interrupted during model preparation (${throwOnAbort ? "abort error" : "gate stop"})`, async () => {
			const { session, mock } = await createSession([
				{ content: [{ type: "toolCall", id: "pause", name: "pause", arguments: {} }] },
				{ content: ["answered steering"] },
			]);
			const toolStarted = Promise.withResolvers<void>();
			const releaseTool = Promise.withResolvers<void>();
			const preparing = Promise.withResolvers<void>();
			const releasePreparation = Promise.withResolvers<void>();
			const schema = type({});
			const tool: AgentTool<typeof schema> = {
				name: "pause",
				label: "Pause",
				description: "Wait for release",
				parameters: schema,
				async execute() {
					toolStarted.resolve();
					await releaseTool.promise;
					return { content: [{ type: "text", text: "finished" }], details: {} };
				},
			};
			session.agent.setTools([tool]);
			let calls = 0;
			const removeHook = session.agent.addBeforeModelCallHook(async signal => {
				if (++calls !== 2) return;
				preparing.resolve();
				await releasePreparation.promise;
				if (throwOnAbort) signal?.throwIfAborted();
			});
			const run = session.prompt("start");
			try {
				await withTimeout(toolStarted.promise, 2_000, "tool did not start");
				await session.steer("change direction");
				releaseTool.resolve();
				await withTimeout(preparing.promise, 2_000, "steered call was not prepared");
				expect(session.hasInterruptibleInput).toBe(true);
				const interrupt = session.abort({ reason: USER_INTERRUPT_LABEL });
				releasePreparation.resolve();
				await withTimeout(interrupt, 2_000, "interrupt did not finish");
				await withTimeout(session.waitForIdle(), 2_000, "steer did not finish");
				await run;
				expect(mock.calls).toHaveLength(2);
				expect(JSON.stringify(mock.calls[1].context.messages)).toContain("change direction");
				expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
			} finally {
				releaseTool.resolve();
				releasePreparation.resolve();
				removeHook();
			}
		});
	}

	it("settles an interrupt terminally when nothing is queued to resume it", async () => {
		const { session } = await createSession([{ content: ["slow response"], delayMs: 1_000 }]);
		const settles: Array<boolean | undefined> = [];
		const streaming = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "message_start" && event.message.role === "assistant") streaming.resolve();
			if (event.type === "agent_end") settles.push(event.isTerminal);
		});

		const run = session.prompt("hello").catch(() => {});
		await withTimeout(streaming.promise, 2_000, "first turn never streamed");
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		await run;

		expect(settles).toEqual([true]);
	});

	it("dequeuing an ultrathink prompt mid-stream restores the text and drops its companion notice", async () => {
		const { session } = await createSession([{ content: ["host answer"] }]);
		let queuedShape: string[] | undefined;
		let clearedSteering: unknown;
		let hasQueuedAfterClear: boolean | undefined;
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			// Real path: a magic-keyword prompt steered mid-stream enqueues the hidden
			// notice immediately before the user message.
			await session.prompt("ultrathink fix it", { streamingBehavior: "steer" });
			queuedShape = session.agent.peekSteeringQueue().map(m => (m.role === "custom" ? m.customType : m.role));
			// Alt+Up restore mid-flight: only the user's text returns; the companion
			// notice must not be left orphaned in the queue.
			const cleared = session.clearQueue();
			clearedSteering = cleared.steering;
			hasQueuedAfterClear = session.agent.hasQueuedMessages();
		});

		await session.prompt("hello");

		expect(queuedShape).toEqual(["ultrathink-notice", "user"]);
		expect(clearedSteering).toEqual([{ text: "ultrathink fix it", images: undefined }]);
		expect(hasQueuedAfterClear).toBe(false);
	});

	it("keeps the attachment of a keyword prompt steered mid-stream", async () => {
		const { session } = await createSession([{ content: ["host answer"] }]);
		const image = {
			type: "image" as const,
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
		};
		let queuedUserContent: string[] | undefined;
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			// The mid-stream branch queues before normalization runs: its
			// companion notices must not be mistaken for prepared attachments,
			// or the image never reaches the queued message.
			await session.prompt("ultrathink look at this", { images: [image], streamingBehavior: "steer" });
			const queued = session.agent.peekSteeringQueue();
			const userMessage = queued.find(message => message.role === "user");
			queuedUserContent = Array.isArray(userMessage?.content)
				? userMessage.content.map(part => part.type)
				: undefined;
		});

		await session.prompt("hello");

		expect(queuedUserContent).toEqual(["text", "image"]);
	});

	it("delivers a queued path-pasted image prompt in the same one-at-a-time turn as its source path", async () => {
		const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["image answer"] }]);
		session.agent.setFollowUpMode("one-at-a-time");
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			await session.followUp("What is in [Image #1]?", [PATH_PASTED_IMAGE]);
		});

		await session.prompt("start");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		const delivered = JSON.stringify(mock.calls[1].context.messages);
		expect(delivered).toContain(IMAGE_SOURCE_PATH);
		expect(delivered).toContain("What is in [Image #1]?");
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("keeps a path-pasted image's source path with a prompt sent as an aside mid-stream", async () => {
		const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["image answer"] }]);
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			await session.prompt("What is in [Image #1]?", { images: [PATH_PASTED_IMAGE], streamingBehavior: "aside" });
		});

		await session.prompt("start");
		await session.waitForIdle();

		const delivered = JSON.stringify(mock.calls.at(-1)?.context.messages);
		expect(delivered).toContain("What is in [Image #1]?");
		expect(delivered).toContain(IMAGE_SOURCE_PATH);
	});

	it("a fresh user prompt delivers queued steer and follow-up work", async () => {
		const { session } = await createSession([{ content: ["one"] }, { content: ["two"] }, { content: ["three"] }]);
		// Queue real pending work before the user's next send.
		session.agent.steer({
			role: "user",
			content: [{ type: "text", text: "queued steer" }],
			steering: true,
			attribution: "user",
			timestamp: Date.now(),
		});
		session.agent.followUp({
			role: "user",
			content: [{ type: "text", text: "queued follow-up" }],
			attribution: "user",
			timestamp: Date.now(),
		});
		expect(session.agent.hasQueuedMessages()).toBe(true);

		await session.prompt("hello");
		await session.waitForIdle();

		// Sending a fresh prompt is the opportunity to drain everything: the steer folds
		// into the new turn and the follow-up runs as its continuation — nothing stranded.
		const userTexts = session.agent.state.messages
			.filter(message => message.role === "user")
			.map(message =>
				typeof message.content === "string"
					? message.content
					: message.content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join(""),
			);
		expect(userTexts).toContain("hello");
		expect(userTexts).toContain("queued steer");
		expect(userTexts).toContain("queued follow-up");
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("resumes a queued steer left behind a non-advisor custom transcript tail", async () => {
		const { session } = await createSession([{ content: ["first answer"] }, { content: ["resumed"] }]);
		await session.prompt("first");
		// A non-advisor custom (e.g. a flushed irc:incoming aside) is the literal transcript tail.
		// A queued steer must resume regardless of tail role — Agent.continue injects it via the
		// initial steering poll — so the old advisor-only look-back can no longer strand it.
		const aside = {
			role: "custom" as const,
			customType: "irc:incoming",
			content: "peer pinged you",
			display: true,
			attribution: "agent" as const,
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_start", message: aside });
		session.agent.emitExternalEvent({ type: "message_end", message: aside });

		const delivered = nextUserMessage(session, "resume me");
		await session.steer("resume me");
		await delivered;
		await session.waitForIdle();

		expect(session.agent.peekSteeringQueue()).toEqual([]);
	});

	it("delivers an RPC skill through the default steering queue with its invocation intact", async () => {
		const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["skill response"] }]);
		const skillPath = path.join(tempDir, "SKILL.md");
		await Bun.write(skillPath, "---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code.\n");
		const invocation = "/skill:reviewer  focus on risks\nand correctness";
		let queued: { steering: readonly string[]; followUp: readonly string[]; liveSteered: number } | undefined;
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			await tryRunRpcSkillCommand(
				{
					buildUserSkillPrompt: session.buildUserSkillPrompt.bind(session),
					renderUserSkillPrompt: session.renderUserSkillPrompt.bind(session),
					skillsSettings: { enableSkillCommands: true },
					skills: [
						{
							name: "reviewer",
							description: "Review code",
							filePath: skillPath,
							baseDir: tempDir,
							source: "project",
						},
					],
					promptCustomMessage: session.promptCustomMessage.bind(session),
				},
				invocation,
			);
			queued = session.getQueuedMessages();
		});

		await session.prompt("start");
		await session.waitForIdle();

		expect(queued).toEqual({ steering: [invocation], followUp: [], liveSteered: 0 });
		const delivered = session.messages.filter(
			(message): message is CustomMessage => message.role === "custom" && message.customType === "skill-prompt",
		);
		expect(delivered).toHaveLength(1);
		expect(delivered[0].content).toContain("focus on risks\nand correctness");
		expect(mock.calls).toHaveLength(2);
		expect(JSON.stringify(mock.calls[1].context.messages)).toContain("Review the supplied code.");
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	describe("removeQueuedMessage", () => {
		for (const kind of ["prompt", "skill"] as const) {
			it(`claims concurrent ${kind} companions atomically in one-at-a-time mode`, async () => {
				const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["kept B"] }]);
				const queue = kind === "prompt" ? "steering" : "followUp";
				const streamingBehavior = kind === "prompt" ? "steer" : "followUp";
				session.agent.setSteeringMode("one-at-a-time");
				session.agent.setFollowUpMode("one-at-a-time");
				const chip = (name: string) =>
					kind === "prompt" ? `ultrathink ${name}` : `/skill:reviewer ultrathink ${name}`;
				const submit = (name: string) =>
					kind === "prompt"
						? session.prompt(chip(name), { streamingBehavior })
						: session.promptCustomMessage(
								{
									customType: "skill-prompt",
									content: `Expanded review context for ${name}`,
									display: true,
									attribution: "user",
									details: { name: "reviewer", args: `ultrathink ${name}` },
								},
								{ streamingBehavior, queueChipText: chip(name) },
							);
				let queued: readonly AgentMessage[] = [];
				let remaining: readonly AgentMessage[] = [];
				let pendingAtFirstRecord: readonly string[] | undefined;
				let removedAfterClaim: boolean | undefined;
				let removed = false;
				let injected = false;
				session.agent.subscribe(event => {
					if (event.type !== "message_start" || event.message !== remaining[0]) return;
					pendingAtFirstRecord = session.getQueuedMessages()[queue];
					removedAfterClaim = session.removeQueuedMessage(chip("keep B"), queue);
				});
				session.agent.setOnBeforeYield(async () => {
					if (injected) return;
					injected = true;
					// Hold the running turn while both real submissions cross their async
					// preprocessing from the same barrier, without serializing either call.
					const release = Promise.withResolvers<void>();
					const first = release.promise.then(() => submit("cancel A"));
					const second = release.promise.then(() => submit("keep B"));
					release.resolve();
					await Promise.all([first, second]);
					queued = [
						...(queue === "steering" ? session.agent.peekSteeringQueue() : session.agent.peekFollowUpQueue()),
					];
					removed = session.removeQueuedMessage(chip("cancel A"), queue);
					remaining = [
						...(queue === "steering" ? session.agent.peekSteeringQueue() : session.agent.peekFollowUpQueue()),
					];
				});

				await session.prompt("start");
				await session.waitForIdle();

				const userRole = kind === "prompt" ? "user" : "skill-prompt";
				expect(queued.map(message => (message.role === "custom" ? message.customType : message.role))).toEqual([
					"ultrathink-notice",
					userRole,
					"ultrathink-notice",
					userRole,
				]);
				expect(removed).toBe(true);
				expect(remaining).toEqual(queued.slice(2));
				expect(pendingAtFirstRecord).toEqual([]);
				expect(removedAfterClaim).toBe(false);
				const notices = session.messages.filter(
					(message): message is CustomMessage =>
						message.role === "custom" && message.customType === "ultrathink-notice",
				);
				expect<readonly AgentMessage[]>(notices).toEqual([queued[2]]);
				expect(mock.calls).toHaveLength(2);
				const delivered = JSON.stringify(mock.calls[1].context.messages);
				expect(delivered).toContain("keep B");
				expect(delivered).not.toContain("cancel A");
				expect(delivered).toContain(JSON.stringify(notices[0].content).slice(1, -1));
				expect(session.agent.hasQueuedMessages()).toBe(false);
			});
		}

		for (const queue of ["steering", "followUp"] as const) {
			it(`prevents delivery of a ${queue} prompt and its hidden companions`, async () => {
				const { session, mock } = await createSession([{ content: ["initial"] }]);
				let injected = false;
				let removed: boolean | undefined;
				session.agent.setOnBeforeYield(async () => {
					if (injected) return;
					injected = true;
					await session.prompt("cancel this ultrathink", {
						streamingBehavior: queue === "steering" ? "steer" : "followUp",
					});
					removed = session.removeQueuedMessage("cancel this ultrathink", queue);
				});

				await session.prompt("start");
				await session.waitForIdle();

				expect(removed).toBe(true);
				expect(session.removeQueuedMessage("cancel this ultrathink", queue)).toBe(false);
				expect(session.agent.hasQueuedMessages()).toBe(false);
				expect(mock.calls).toHaveLength(1);
				expect(session.messages.filter(message => message.role === "user" || message.role === "custom")).toEqual([
					expect.objectContaining({ role: "user", content: [{ type: "text", text: "start" }] }),
				]);
			});

			it(`removes only the first user match and its companions from ${queue}`, async () => {
				const { session } = await createSession([]);
				const internal: AgentMessage = {
					role: "custom",
					customType: "advisor",
					content: "duplicate",
					attribution: "agent",
					display: true,
					timestamp: 1,
				};
				const internalUser: AgentMessage = {
					role: "user",
					content: "duplicate",
					attribution: "agent",
					timestamp: 1,
				};
				const companion: AgentMessage = {
					role: "custom",
					customType: "image-attachment-description",
					content: "hidden",
					attribution: "user",
					display: false,
					timestamp: 2,
				};
				const keyword: AgentMessage = { ...companion, customType: "ultrathink-notice" };
				const video: AgentMessage = { ...companion, customType: "video-attachment" };
				const first: AgentMessage = { role: "user", content: "duplicate", timestamp: 3 };
				const keptCompanion: AgentMessage = { ...companion, timestamp: 4 };
				const duplicate: AgentMessage = { ...first, timestamp: 5 };
				const selected = [internal, internalUser, keyword, video, companion, first, keptCompanion, duplicate];
				const other = [
					{ ...companion, timestamp: 6 },
					{ ...first, timestamp: 7 },
				];
				session.agent.replaceQueues(
					queue === "steering" ? selected : other,
					queue === "followUp" ? selected : other,
				);

				expect(session.getQueuedMessages()[queue]).toEqual(["duplicate", "duplicate"]);
				expect(session.removeQueuedMessage("duplicate", queue)).toBe(true);
				const remaining = [internal, internalUser, keptCompanion, duplicate];
				expect(session.agent.peekSteeringQueue()).toEqual(queue === "steering" ? remaining : other);
				expect(session.agent.peekFollowUpQueue()).toEqual(queue === "followUp" ? remaining : other);
				expect(session.removeQueuedMessage("hidden", queue)).toBe(false);
				expect(session.removeQueuedMessage("absent", queue)).toBe(false);
				expect(session.removeQueuedMessage("duplicate", queue)).toBe(true);
				expect(session.removeQueuedMessage("duplicate", queue)).toBe(false);
				expect(session.agent.peekSteeringQueue()).toEqual(queue === "steering" ? [internal, internalUser] : other);
				expect(session.agent.peekFollowUpQueue()).toEqual(queue === "followUp" ? [internal, internalUser] : other);
				expect(session.getQueuedMessages()[queue]).toEqual([]);
			});
		}

		it("removes a queued path-pasted image prompt together with its private source path", async () => {
			const { session, mock } = await createSession([{ content: ["initial"] }]);
			let injected = false;
			let removed: boolean | undefined;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await session.followUp("What is in [Image #1]?", [PATH_PASTED_IMAGE]);
				removed = session.removeQueuedMessage("What is in [Image #1]?", "followUp");
			});

			await session.prompt("start");
			await session.waitForIdle();

			expect(removed).toBe(true);
			expect(session.agent.hasQueuedMessages()).toBe(false);
			expect(mock.calls).toHaveLength(1);
			expect(session.messages.filter(message => message.role === "user" || message.role === "custom")).toEqual([
				expect.objectContaining({ role: "user", content: [{ type: "text", text: "start" }] }),
			]);
		});

		it("matches raw and expanded prompt-template chips without changing surviving work", async () => {
			const { session } = await createSession(
				[],
				[{ name: "review", description: "Review", content: "Review $1", source: "(test)" }],
			);
			await session.followUp("/review raw", undefined, { expandPromptTemplates: false });
			await session.followUp("/review expanded");
			await session.followUp("keep");

			expect(session.removeQueuedMessage("/review raw", "followUp")).toBe(true);
			expect(session.removeQueuedMessage("/review expanded", "followUp")).toBe(true);
			expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: ["keep"], liveSteered: 0 });
		});

		it("removes a queued file-based slash command by its raw /cmd invocation", async () => {
			const { session } = await createSession([]);
			session.setSlashCommands([{ name: "cmd", description: "Test", content: "Expanded $1", source: "(test)" }]);

			// #dispatchPrompt's slash-command rewrite only runs on prompt(); force
			// the busy-session queueing branch without a real turn.
			session.agent.state.isStreaming = true;
			try {
				const queued = await session.prompt("/cmd args", { streamingBehavior: "steer" });
				expect(queued).toBe(true);
				expect(session.getQueuedMessages().steering).toEqual(["Expanded args"]);

				// The caller only ever holds its raw "/cmd args" invocation; removal
				// must still find the slash-command-expanded queued chip.
				expect(session.removeQueuedMessage("/cmd args", "steering")).toBe(true);
				expect(session.getQueuedMessages().steering).toEqual([]);
			} finally {
				session.agent.state.isStreaming = false;
			}
		});

		it("cancels a skill queued through RPC by its original invocation before it reaches the model", async () => {
			const { session, mock } = await createSession([{ content: ["initial"] }]);
			const skillPath = path.join(tempDir, "SKILL.md");
			await Bun.write(
				skillPath,
				"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code.\n",
			);
			const invocation = "/skill:reviewer  ultrathink focus on risks\nand correctness";
			let injected = false;
			let removed: boolean | undefined;
			let queued: readonly string[] | undefined;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await tryRunRpcSkillCommand(
					{
						buildUserSkillPrompt: session.buildUserSkillPrompt.bind(session),
						renderUserSkillPrompt: session.renderUserSkillPrompt.bind(session),
						skillsSettings: { enableSkillCommands: true },
						skills: [
							{
								name: "reviewer",
								description: "Review code",
								filePath: skillPath,
								baseDir: tempDir,
								source: "project",
							},
						],
						promptCustomMessage: session.promptCustomMessage.bind(session),
					},
					invocation,
					"followUp",
				);
				queued = session.getQueuedMessages().followUp;
				removed = session.removeQueuedMessage(invocation, "followUp");
			});

			await session.prompt("start");
			await session.waitForIdle();

			expect(queued).toEqual([invocation]);
			expect(removed).toBe(true);
			expect(session.agent.hasQueuedMessages()).toBe(false);
			expect(mock.calls).toHaveLength(1);
			expect(session.messages.filter(message => message.role === "user" || message.role === "custom")).toEqual([
				expect.objectContaining({ role: "user", content: [{ type: "text", text: "start" }] }),
			]);
		});
	});

	describe("promoteQueuedMessage", () => {
		it("promotes a skill queued through RPC by its original invocation and delivers it once", async () => {
			const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["skill response"] }]);
			const skillPath = path.join(tempDir, "SKILL.md");
			await Bun.write(
				skillPath,
				"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code.\n",
			);
			const invocation = "/skill:reviewer  focus on risks\nand correctness";
			let injected = false;
			let promoted: boolean | undefined;
			let promotedAgain: boolean | undefined;
			let queueAfterPromotion:
				| { steering: readonly string[]; followUp: readonly string[]; liveSteered: number }
				| undefined;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				const queued = Promise.withResolvers<void>();
				void tryRunRpcSkillCommand(
					{
						buildUserSkillPrompt: session.buildUserSkillPrompt.bind(session),
						renderUserSkillPrompt: session.renderUserSkillPrompt.bind(session),
						skillsSettings: { enableSkillCommands: true },
						skills: [
							{
								name: "reviewer",
								description: "Review code",
								filePath: skillPath,
								baseDir: tempDir,
								source: "project",
							},
						],
						async promptCustomMessage(message, options) {
							const result = await session.promptCustomMessage(message, options);
							queued.resolve();
							return result;
						},
					},
					invocation,
					"followUp",
				).catch(error => queued.reject(error));
				await withTimeout(queued.promise, 2_000, "Skill did not reach the native queue");
				promoted = session.promoteQueuedMessage(invocation);
				queueAfterPromotion = session.getQueuedMessages();
				promotedAgain = session.promoteQueuedMessage(invocation);
			});

			await session.prompt("start");
			await session.waitForIdle();

			expect(promoted).toBe(true);
			expect(queueAfterPromotion).toEqual({ steering: [invocation], followUp: [], liveSteered: 0 });
			expect(promotedAgain).toBe(false);
			const delivered = session.messages.filter(
				(message): message is CustomMessage => message.role === "custom" && message.attribution === "user",
			);
			expect(delivered).toHaveLength(1);
			expect(delivered[0].content).toContain("Review the supplied code.");
			expect(delivered[0].content).toContain("focus on risks\nand correctness");
			expect(JSON.stringify(mock.calls[1].context.messages)).toContain("Review the supplied code.");
			expect(session.agent.hasQueuedMessages()).toBe(false);
		});

		it("moves the first duplicate behind existing steering and delivers every queued occurrence once", async () => {
			const { session } = await createSession([
				{ content: ["initial"] },
				{ content: ["steered"] },
				{ content: ["followed up"] },
			]);
			session.setSteeringMode("all");
			session.setFollowUpMode("all");
			let promoted: boolean | undefined;
			let queued: object | undefined;
			let injected = false;
			let first: AgentMessage | undefined;
			let second: AgentMessage | undefined;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await session.steer("existing");
				await session.followUp("duplicate");
				await session.followUp("unrelated");
				await session.followUp("duplicate");
				[first, , second] = session.agent.peekFollowUpQueue();
				first!.timestamp = 1_000;
				second!.timestamp = 2_000;
				promoted = session.promoteQueuedMessage("duplicate");
				queued = session.getQueuedMessages();
			});

			await session.prompt("start");
			await session.waitForIdle();

			expect(promoted).toBe(true);
			expect(queued).toEqual({
				steering: ["existing", "duplicate"],
				followUp: ["unrelated", "duplicate"],
				liveSteered: 0,
			});
			const delivered = session.messages.filter(message => message.role === "user");
			expect(delivered.map(message => message.content)).toEqual(
				["start", "existing", "duplicate", "unrelated", "duplicate"].map(text => [{ type: "text", text }]),
			);
			expect(delivered[2]).toMatchObject({ timestamp: first!.timestamp, steering: true });
			expect<AgentMessage | undefined>(delivered[4]).toEqual(second);
			expect(delivered[4]).not.toHaveProperty("steering");
			expect(session.agent.hasQueuedMessages()).toBe(false);
		});

		it("leaves both queues untouched when only agent-authored or hidden messages match", async () => {
			const { session } = await createSession([]);
			session.agent.steer({ role: "user", content: "existing", timestamp: 1 });
			session.agent.followUp({
				role: "custom",
				customType: "advisor",
				content: "target",
				attribution: "agent",
				display: true,
				timestamp: 2,
			});
			// An agent handoff is a user-role turn but not user input; it must never be promotable.
			session.agent.followUp({ role: "user", content: "target", attribution: "agent", timestamp: 2 });
			session.agent.followUp({
				role: "custom",
				customType: "ultrathink-notice",
				content: "target",
				attribution: "user",
				display: false,
				timestamp: 3,
			});
			const steering = structuredClone(session.agent.peekSteeringQueue());
			const followUp = structuredClone(session.agent.peekFollowUpQueue());

			expect(session.promoteQueuedMessage("target")).toBe(false);
			expect(session.promoteQueuedMessage("absent")).toBe(false);
			expect(session.agent.peekSteeringQueue()).toEqual(steering);
			expect(session.agent.peekFollowUpQueue()).toEqual(followUp);
		});

		it("matches raw and expanded template chips without expanding a queued prompt again", async () => {
			const { session } = await createSession(
				[{ content: ["initial"] }, { content: ["steered"] }],
				[{ name: "review", description: "Review", content: "Review $1", source: "(test)" }],
			);
			session.setSteeringMode("all");
			let promoted: boolean[] = [];
			let injected = false;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await session.followUp("/review raw", undefined, { expandPromptTemplates: false });
				await session.followUp("/review expanded");
				await session.followUp("/review chip");
				promoted = [
					session.promoteQueuedMessage("/review raw"),
					session.promoteQueuedMessage("/review expanded"),
					session.promoteQueuedMessage("Review chip"),
				];
			});

			await session.prompt("start");
			await session.waitForIdle();

			expect(promoted).toEqual([true, true, true]);
			expect(session.messages.filter(message => message.role === "user").map(message => message.content)).toEqual(
				["start", "/review raw", "Review expanded", "Review chip"].map(text => [{ type: "text", text }]),
			);
			expect(session.agent.hasQueuedMessages()).toBe(false);
		});

		it("promotes a queued file-based slash command by its raw invocation, then removes it from steering", async () => {
			const { session } = await createSession([]);
			session.setSlashCommands([{ name: "cmd", description: "Test", content: "Expanded $1", source: "(test)" }]);

			// #dispatchPrompt's slash-command rewrite only runs on prompt(); force
			// the busy-session queueing branch without a real turn.
			session.agent.state.isStreaming = true;
			try {
				const queued = await session.prompt("/cmd args", { streamingBehavior: "followUp" });
				expect(queued).toBe(true);
				expect(session.getQueuedMessages().followUp).toEqual(["Expanded args"]);

				// Promotion moves the same message object into the steering queue; its
				// raw-text record must follow so the caller can still remove it by the
				// exact "/cmd args" it originally submitted.
				expect(session.promoteQueuedMessage("/cmd args")).toBe(true);
				expect(session.getQueuedMessages()).toEqual({ steering: ["Expanded args"], followUp: [], liveSteered: 0 });

				expect(session.removeQueuedMessage("/cmd args", "steering")).toBe(true);
				expect(session.getQueuedMessages().steering).toEqual([]);
			} finally {
				session.agent.state.isStreaming = false;
			}
		});

		it("delivers each promoted companion group in one model turn in one-at-a-time mode", async () => {
			const { session, sessionManager, mock } = await createSession([
				{ content: ["initial"] },
				{ content: ["steered"] },
				{ content: ["custom prompt"] },
				{ content: ["followed up"] },
			]);
			session.setSteeringMode("one-at-a-time");
			session.setFollowUpMode("one-at-a-time");
			const companion: AgentMessage = {
				role: "custom",
				customType: "image-attachment-description",
				content: "The attached image contains a diagram.",
				attribution: "user",
				display: false,
				timestamp: 10,
			};
			const keywordNotice: AgentMessage = {
				...companion,
				customType: "ultrathink-notice",
				content: "Use extended reasoning for this request.",
				timestamp: 9,
			};
			const videoNotice: AgentMessage = {
				...companion,
				customType: "video-attachment",
				content: "Video source: /tmp/clip.mp4",
				timestamp: 8,
			};
			const image = {
				type: "image" as const,
				mimeType: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
			};
			const imagePrompt: AgentMessage = {
				role: "user",
				content: [image],
				attribution: "user",
				timestamp: 11,
			};
			const customPrompt: AgentMessage = {
				role: "custom",
				customType: COLLAB_PROMPT_TYPE,
				content: "Expanded guest request",
				attribution: "user",
				display: true,
				details: { from: "guest", __queueChipText: "/guest request", nested: { preserve: true } },
				timestamp: 12,
			};
			const otherCompanion: AgentMessage = { ...companion, content: "Other image description", timestamp: 13 };
			const otherPrompt: AgentMessage = { role: "user", content: "Other request", timestamp: 14 };
			let promoted: boolean[] = [];
			let injected = false;
			session.subscribe(event => {
				if (event.type !== "turn_end" || injected) return;
				injected = true;
				session.agent.replaceQueues(
					[],
					[videoNotice, keywordNotice, companion, imagePrompt, customPrompt, otherCompanion, otherPrompt],
				);
				promoted = [session.promoteQueuedMessage("[Image]"), session.promoteQueuedMessage("/guest request")];
			});

			await session.prompt("start");
			await session.waitForIdle();

			expect(promoted).toEqual([true, true]);
			const delivered = session.messages.filter(message => message.role === "custom" || message.role === "user");
			expect(delivered.slice(1)).toEqual([
				videoNotice,
				keywordNotice,
				companion,
				{ ...imagePrompt, steering: true },
				customPrompt,
				otherCompanion,
				otherPrompt,
			]);
			expect(
				mock.calls[1].context.messages.some(
					message =>
						message.role === "user" &&
						Array.isArray(message.content) &&
						message.content.some(part => part.type === "image" && part.data === image.data),
				),
			).toBe(true);
			const firstSteeredContext = JSON.stringify(mock.calls[1].context.messages);
			expect(firstSteeredContext).toContain(companion.content as string);
			expect(firstSteeredContext).toContain(keywordNotice.content as string);
			expect(firstSteeredContext).toContain(videoNotice.content as string);
			expect(firstSteeredContext).not.toContain(customPrompt.content as string);
			expect(firstSteeredContext).not.toContain(otherPrompt.content as string);
			expect(JSON.stringify(mock.calls[2].context.messages)).toContain(customPrompt.content as string);
			expect(JSON.stringify(mock.calls[2].context.messages)).not.toContain(otherCompanion.content as string);
			expect(mock.calls).toHaveLength(4);
			expect(
				sessionManager
					.getEntries()
					.filter(entry => entry.type === "custom_message" && entry.customType === COLLAB_PROMPT_TYPE),
			).toMatchObject([
				{ content: customPrompt.content, details: { from: "guest", nested: { preserve: true } }, display: true },
			]);
			expect(session.agent.hasQueuedMessages()).toBe(false);
		});

		it("promotes a file-backed image prompt together with its hidden source-path notice", async () => {
			const { session } = await createSession([{ content: ["initial"] }, { content: ["steered"] }]);
			let promoted = false;
			let steering: AgentMessage[] = [];
			let followUp: AgentMessage[] = [];
			let injected = false;
			session.agent.setOnBeforeYield(async () => {
				if (injected) return;
				injected = true;
				await session.followUp("Inspect [Image #1]", [PATH_PASTED_IMAGE]);
				promoted = session.promoteQueuedMessage("Inspect [Image #1]");
				steering = [...session.agent.peekSteeringQueue()];
				followUp = [...session.agent.peekFollowUpQueue()];
			});

			await session.prompt("start");
			await session.waitForIdle();

			expect(promoted).toBe(true);
			expect(followUp).toEqual([]);
			expect(steering.map(message => (message.role === "custom" ? message.customType : message.role))).toEqual([
				"image-attachment",
				"user",
			]);
			expect(JSON.stringify(steering[0])).toContain(IMAGE_SOURCE_PATH);
		});

		it("enqueues live keyword companion groups synchronously during streaming in one-at-a-time mode", async () => {
			const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["steered"] }]);
			cfgMagicKeywordsEnabled.set(session.settings, true);
			cfgMagicKeyword.ultrathink.set(session.settings, true);
			session.setSteeringMode("one-at-a-time");
			const image = {
				type: "image" as const,
				mimeType: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
			};

			let steerPromise: Promise<boolean> | undefined;
			session.agent.setOnBeforeYield(async () => {
				if (steerPromise) return;
				steerPromise = session.prompt("review this ?ultrathink", {
					images: [image],
					streamingBehavior: "steer",
				});
			});

			await session.prompt("start");
			await steerPromise;
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(2);
			const steeredContext = JSON.stringify(mock.calls[1].context.messages);
			expect(steeredContext).toContain("Multi-step reasoning");
			expect(steeredContext).toContain("review this ?ultrathink");
			// The early streaming branch queues before normalization runs; its
			// notice-only metadata must not be mistaken for prepared attachments,
			// or the attachment never reaches the model.
			expect(
				mock.calls[1].context.messages.some(
					message =>
						message.role === "user" &&
						Array.isArray(message.content) &&
						message.content.some(part => part.type === "text" && part.text.includes("review this")) &&
						message.content.some(part => part.type === "image"),
				),
			).toBe(true);
			expect(session.agent.hasQueuedMessages()).toBe(false);
			const ultrathinkMessage = session.messages.find(
				message => message.role === "custom" && message.customType === "ultrathink-notice",
			);
			expect(ultrathinkMessage).toBeDefined();
		});

		it("promotes live keyword companion groups queued as follow-ups into steering atomically", async () => {
			const { session, mock } = await createSession([{ content: ["initial"] }, { content: ["steered"] }]);
			cfgMagicKeywordsEnabled.set(session.settings, true);
			cfgMagicKeyword.ultrathink.set(session.settings, true);
			session.setSteeringMode("one-at-a-time");

			let followUpPromise: Promise<boolean> | undefined;
			let promoted = false;
			session.agent.setOnBeforeYield(async () => {
				if (followUpPromise) return;
				followUpPromise = session.prompt("follow-up with ?ultrathink", {
					streamingBehavior: "followUp",
				});
				await followUpPromise;
				promoted = session.promoteQueuedMessage("follow-up with ?ultrathink");
			});

			await session.prompt("start");
			await session.waitForIdle();

			expect(promoted).toBe(true);
			expect(mock.calls).toHaveLength(2);
			const steeredContext = JSON.stringify(mock.calls[1].context.messages);
			expect(steeredContext).toContain("Multi-step reasoning");
			expect(steeredContext).toContain("follow-up with ?ultrathink");
			expect(session.agent.hasQueuedMessages()).toBe(false);
		});

		it("wakes an idle follow-up and rejects a stale promotion without replaying it", async () => {
			const { session, mock } = await createSession([{ content: ["delivered"] }]);
			await session.followUp("wake me");
			expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: ["wake me"], liveSteered: 0 });
			const delivered = nextUserMessage(session, "wake me");

			expect(session.promoteQueuedMessage("wake me")).toBe(true);
			await delivered;
			await session.waitForIdle();

			expect(session.promoteQueuedMessage("wake me")).toBe(false);
			expect(session.agent.hasQueuedMessages()).toBe(false);
			expect(mock.calls).toHaveLength(1);
			expect(session.messages.filter(message => message.role === "user")).toHaveLength(1);
		});

		it("reports a promotion as one queue_update that never shows the message missing", async () => {
			const { session } = await createSession([{ content: ["delivered"] }]);
			await session.followUp("keep me visible");
			const updates: Array<{ steering: string[]; followUp: string[]; liveSteered: number }> = [];
			const unsubscribe = session.subscribe(event => {
				if (event.type === "queue_update")
					updates.push({ steering: event.steering, followUp: event.followUp, liveSteered: event.liveSteered });
			});
			try {
				expect(session.promoteQueuedMessage("keep me visible")).toBe(true);
				// Synchronous snapshot: the idle drain has not dequeued it yet.
				expect(updates).toEqual([{ steering: ["keep me visible"], followUp: [], liveSteered: 0 }]);
			} finally {
				unsubscribe();
			}
			await session.waitForIdle();
		});

		for (const mode of ["immediate", "wait"] as const) {
			it(`honors ${mode} interruption when promoting during an interruptible tool`, async () => {
				const { session } = await createSession([
					{
						content: [
							{ type: "toolCall", id: "first", name: "pause", arguments: { value: "first" } },
							{ type: "toolCall", id: "second", name: "pause", arguments: { value: "second" } },
						],
					},
					{ content: ["steered"] },
				]);
				const started = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const interrupted = Promise.withResolvers<void>();
				const executed: string[] = [];
				const schema = type({ value: "string" });
				const tool: AgentTool<typeof schema> = {
					name: "pause",
					label: "Pause",
					description: "Wait for release",
					parameters: schema,
					concurrency: "exclusive",
					// "wait" mode spares only side-effecting work; interruptible
					// waits are cut short in either mode.
					interruptible: mode === "immediate",
					async execute(_id, params, signal) {
						executed.push(params.value);
						if (params.value === "first") {
							const onAbort = () => interrupted.resolve();
							signal?.addEventListener("abort", onAbort, { once: true });
							started.resolve();
							try {
								await Promise.race([release.promise, interrupted.promise]);
							} finally {
								signal?.removeEventListener("abort", onAbort);
							}
						}
						return { content: [{ type: "text", text: params.value }], details: {} };
					},
				};
				session.agent.setTools([tool]);
				session.setInterruptMode(mode);
				session.setSteeringMode("one-at-a-time");
				session.setFollowUpMode("one-at-a-time");
				const prompt = session.prompt("start");
				try {
					await withTimeout(started.promise, 2_000, "The first tool did not start");
					await session.followUp("change direction");
					expect(session.promoteQueuedMessage("change direction")).toBe(true);
					if (mode === "immediate")
						await withTimeout(interrupted.promise, 2_000, "Promotion did not wake the tool interrupt");
				} finally {
					release.resolve();
					await prompt;
				}
				await session.waitForIdle();

				expect(executed).toEqual(mode === "immediate" ? ["first"] : ["first", "second"]);
				expect(session.interruptMode).toBe(mode);
				expect(session.steeringMode).toBe("one-at-a-time");
				expect(session.followUpMode).toBe("one-at-a-time");
				expect(session.messages.filter(message => message.role === "user").map(message => message.content)).toEqual(
					["start", "change direction"].map(text => [{ type: "text", text }]),
				);
				expect(session.agent.hasQueuedMessages()).toBe(false);
			});
		}
	});
});
