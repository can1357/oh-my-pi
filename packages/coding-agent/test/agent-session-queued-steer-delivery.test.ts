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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { PromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";

const COLLAB_PROMPT_TYPE = "collab-prompt";

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
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir, "models.yml"));
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-steer-strand-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		removeSyncWithRetries(tempDir);
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(fixtureDir);
	});

	async function createSession(
		responses: MockResponse[],
		promptTemplates: PromptTemplate[] = [],
	): Promise<SteerHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false });

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, promptTemplates });
		return { session, sessionManager, mock };
	}

	function steerCollabPrompt(target: AgentSession, text: string): Promise<boolean> {
		return target.promptCustomMessage(
			{
				customType: COLLAB_PROMPT_TYPE,
				content: text,
				display: true,
				details: { from: "guest" },
				attribution: "user",
			},
			{ streamingBehavior: "steer" },
		);
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
			await steerCollabPrompt(session, "guest steer at yield");
		});

		await session.prompt("hello");

		expect(streamingAtInject).toBe(true);
		expect(await entryAppended).toBe("guest steer at yield");
		expect(mock.calls.length).toBe(2);
		expect(session.agent.hasQueuedMessages()).toBe(false);
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

	describe("promoteQueuedMessage", () => {
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
			expect(queued).toEqual({ steering: ["existing", "duplicate"], followUp: ["unrelated", "duplicate"] });
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

		it("wakes an idle follow-up and rejects a stale promotion without replaying it", async () => {
			const { session, mock } = await createSession([{ content: ["delivered"] }]);
			await session.followUp("wake me");
			expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: ["wake me"] });
			const delivered = nextUserMessage(session, "wake me");

			expect(session.promoteQueuedMessage("wake me")).toBe(true);
			await delivered;
			await session.waitForIdle();

			expect(session.promoteQueuedMessage("wake me")).toBe(false);
			expect(session.agent.hasQueuedMessages()).toBe(false);
			expect(mock.calls).toHaveLength(1);
			expect(session.messages.filter(message => message.role === "user")).toHaveLength(1);
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
					interruptible: true,
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
