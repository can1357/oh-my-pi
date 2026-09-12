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
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { PromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { tryRunRpcSkillCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

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

	describe("removeQueuedMessage", () => {
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
			expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: ["keep"] });
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
});
