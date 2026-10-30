/**
 * Contract: an editor-restoring interrupt (TUI Esc, RPC `abort_and_restore_queue`:
 * `clearQueue({ forInterrupt: true })` followed by a user-interrupt abort) hands the
 * person back only what they typed, and loses nothing anyone else queued. Visible queued
 * messages an extension or agent sent are recorded in the transcript without starting a
 * turn, so the run the user stopped does not resume on them, and the next turn sends them
 * to the model.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	createMockModel,
	type MockModel,
	type MockResponse,
	type MockResponseSource,
} from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface ParkedHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
	/** Resolves when the first turn's model stream begins. */
	streamStarted: Promise<void>;
}

const IMAGE: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD3sAAAAASUVORK5CYII=",
};

describe("AgentSession editor-restoring interrupt", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	const authStorages: AuthStorage[] = [];

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-interrupt-queue-");
	});

	afterEach(async () => {
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

	async function createSession(responses: MockResponseSource): Promise<Omit<ParkedHarness, "streamStarted">> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			// The session's own conversion, so custom transcript entries reach the request as they do in a real run.
			convertToLlm,
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		return { session, sessionManager, mock };
	}

	/** The first turn stays open (a 60 s mock delay the abort cancels), so messages can queue behind it. */
	async function createParkedSession(tailResponses: MockResponse[] = []): Promise<ParkedHarness> {
		const started = Promise.withResolvers<void>();
		const harness = await createSession([
			() => {
				started.resolve();
				return { content: ["working"], delayMs: 60_000 };
			},
			...tailResponses,
		]);
		return { ...harness, streamStarted: started.promise };
	}

	/** Text of every persisted transcript entry, in order, as `role[/customType]: text`. */
	function persistedTranscript(sessionManager: SessionManager): string[] {
		const out: string[] = [];
		for (const entry of sessionManager.getBranch()) {
			if (entry.type === "custom_message") {
				out.push(`custom/${entry.customType}: ${typeof entry.content === "string" ? entry.content : ""}`);
			} else if (entry.type === "message" && entry.message.role === "user") {
				const { content } = entry.message;
				const text =
					typeof content === "string"
						? content
						: content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
				out.push(`user: ${text}`);
			}
		}
		return out;
	}

	it("records queued extension messages in the transcript without resuming, and sends them with the next turn", async () => {
		const { session, sessionManager, mock, streamStarted } = await createParkedSession([{ content: ["answered"] }]);
		const running = session.prompt("first task");
		await streamStarted;

		// An extension delivers two visible cards while the run streams (pi.sendMessage).
		await session.sendCustomMessage(
			{ customType: "peer-card", content: "first peer card", display: true },
			{ deliverAs: "steer", triggerTurn: true },
		);
		await session.sendCustomMessage(
			{ customType: "peer-card", content: "second peer card", display: true },
			{ deliverAs: "followUp" },
		);

		const restored = session.clearQueue({ forInterrupt: true });
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		await running.catch(() => {});

		// Not the person's input, so not handed back for the editor ...
		expect(restored).toEqual({ steering: [], followUp: [] });
		// ... and not lost: both cards are persisted transcript entries, in queue order,
		expect(persistedTranscript(sessionManager)).toEqual([
			"user: first task",
			"custom/peer-card: first peer card",
			"custom/peer-card: second peer card",
		]);
		// while nothing is left to resume the stopped run on, and none started.
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(mock.calls).toHaveLength(1);

		// The person's next prompt carries both cards to the model, ahead of the prompt.
		await session.prompt("next prompt");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(2);
		const request = JSON.stringify(mock.calls[1]!.context.messages);
		const card1 = request.indexOf("first peer card");
		const card2 = request.indexOf("second peer card");
		expect(card1).toBeGreaterThan(-1);
		expect(card2).toBeGreaterThan(card1);
		expect(request.indexOf("next prompt")).toBeGreaterThan(card2);
	});

	it("records the messages ahead of a prompt that another source started while the interrupt settled", async () => {
		const { session, sessionManager, mock, streamStarted } = await createParkedSession([
			{ content: ["answered"] },
			{ content: ["never seen"] },
		]);
		const running = session.prompt("first task");
		await streamStarted;
		await session.sendCustomMessage(
			{ customType: "peer-card", content: "withdrawn peer card", display: true },
			{ deliverAs: "followUp" },
		);

		// Once the stopped run has settled, and before the abort records what it withdrew, a new
		// prompt is admitted and held in its setup, where the agent is not yet streaming.
		const setupReached = Promise.withResolvers<void>();
		const setupRelease = Promise.withResolvers<void>();
		const registry = session.modelRegistry;
		const getApiKey = registry.getApiKey.bind(registry);
		registry.getApiKey = async (...args) => {
			registry.getApiKey = getApiKey;
			setupReached.resolve();
			await setupRelease.promise;
			return getApiKey(...args);
		};
		const agentWaitForIdle = session.agent.waitForIdle.bind(session.agent);
		let next: Promise<boolean> | undefined;
		session.agent.waitForIdle = async () => {
			session.agent.waitForIdle = agentWaitForIdle;
			await agentWaitForIdle();
			await running.catch(() => {});
			expect(session.isStreaming).toBe(false);
			next = session.prompt("next prompt");
			await setupReached.promise;
			// Admitted (the session counts it as in flight), but the agent has not started streaming.
			expect(session.isStreaming).toBe(true);
			expect(session.agent.state.isStreaming).toBe(false);
		};

		session.clearQueue({ forInterrupt: true });
		await session.abort({ reason: USER_INTERRUPT_LABEL });

		// The prompt in setup has sent nothing yet, so the card is recorded now, not queued behind it.
		expect(session.agent.state.isStreaming).toBe(false);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(persistedTranscript(sessionManager)).toEqual([
			"user: first task",
			"custom/peer-card: withdrawn peer card",
		]);

		setupRelease.resolve();
		expect(await next).toBe(true);
		await session.waitForIdle();

		// That prompt is the next turn: it carries the card ahead of its own text, as a prompt sent
		// after the interrupt settled does, and no extra model call runs on the card.
		expect(mock.calls).toHaveLength(2);
		const request = JSON.stringify(mock.calls[1]!.context.messages);
		expect(request.indexOf("withdrawn peer card")).toBeGreaterThan(-1);
		expect(request.indexOf("next prompt")).toBeGreaterThan(request.indexOf("withdrawn peer card"));
		expect(persistedTranscript(sessionManager)).toEqual([
			"user: first task",
			"custom/peer-card: withdrawn peer card",
			"user: next prompt",
		]);
	});

	it("hands back each typed message separately and keeps an agent-attributed prompt as its own message", async () => {
		const { session, sessionManager, mock, streamStarted } = await createParkedSession();
		const running = session.prompt("first task");
		await streamStarted;

		await session.prompt("typed steer", { streamingBehavior: "steer", images: [IMAGE] });
		// A prompt an extension forwards on behalf of an agent (e.g. a push-notification bridge).
		await session.sendUserMessage("notice from a bridge", { deliverAs: "steer", attribution: "agent" });
		await session.prompt("typed follow-up", { streamingBehavior: "followUp" });

		const restored = session.clearQueue({ forInterrupt: true });
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		await running.catch(() => {});

		// The editor gets the person's own messages, one entry each, with their images.
		expect(restored.steering).toHaveLength(1);
		expect(restored.steering[0]!.text).toBe("typed steer");
		expect(restored.steering[0]!.images).toHaveLength(1);
		expect(restored.followUp).toEqual([{ text: "typed follow-up", images: undefined }]);
		// The agent-attributed prompt is neither merged into that draft nor dropped: it stays a
		// separate user message with its attribution, recorded without a turn.
		const recorded = session.agent.state.messages.filter(
			message => message.role === "user" && JSON.stringify(message.content).includes("notice from a bridge"),
		);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({ role: "user", attribution: "agent" });
		expect(persistedTranscript(sessionManager)).toEqual(["user: first task", "user: notice from a bridge"]);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(mock.calls).toHaveLength(1);
	});

	it("records an agent prompt with the hidden companion queued for it, and drops a restored prompt's companion", async () => {
		const { session, sessionManager, mock, streamStarted } = await createParkedSession();
		const running = session.prompt("first task");
		await streamStarted;

		// The queue shape #queueUserMessage publishes: each prompt's hidden companion right before it.
		const companion = (content: string): AgentMessage => ({
			role: "custom",
			customType: "ultrathink-notice",
			content,
			display: false,
			attribution: "user",
			timestamp: Date.now(),
		});
		session.agent.steer(companion("notice for the typed prompt"));
		session.agent.steer({
			role: "user",
			content: [{ type: "text", text: "typed prompt" }],
			steering: true,
			attribution: "user",
			timestamp: Date.now(),
		});
		session.agent.steer(companion("notice for the agent prompt"));
		session.agent.steer({
			role: "user",
			content: [{ type: "text", text: "agent prompt" }],
			steering: true,
			attribution: "agent",
			timestamp: Date.now(),
		});

		const restored = session.clearQueue({ forInterrupt: true });
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		await running.catch(() => {});

		// The typed prompt goes back to the editor; resubmitting it builds its notice again.
		expect(restored.steering).toEqual([{ text: "typed prompt", images: undefined }]);
		// The agent prompt is recorded with its notice right before it, as a normal delivery would send it.
		expect(persistedTranscript(sessionManager)).toEqual([
			"user: first task",
			"custom/ultrathink-notice: notice for the agent prompt",
			"user: agent prompt",
		]);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(mock.calls).toHaveLength(1);
	});

	it("records an extension message the run already took for its next model call exactly once", async () => {
		const { session, sessionManager, mock } = await createSession([
			{ content: ["first reply"] },
			{ content: ["never seen"] },
		]);
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		// The card is queued during the first model call; the loop dequeues it for the second call,
		// which this hook holds before the transcript records it.
		const removeGate = session.agent.addBeforeModelCallHook(async () => {
			if (calls++ === 0) {
				await session.sendCustomMessage(
					{ customType: "peer-card", content: "withdrawn peer card", display: true },
					{ deliverAs: "steer" },
				);
				return;
			}
			reached.resolve();
			await release.promise;
		});
		const ends: AgentMessage[][] = [];
		session.subscribe(event => {
			if (event.type === "agent_end") ends.push(event.messages);
		});
		const running = session.prompt("first task");
		await reached.promise;
		expect(session.agent.hasQueuedMessages()).toBe(false);

		const restored = session.clearQueue({ forInterrupt: true });
		const aborting = session.abort({ reason: USER_INTERRUPT_LABEL });
		release.resolve();
		await aborting;
		await running.catch(() => {});
		removeGate();

		expect(restored).toEqual({ steering: [], followUp: [] });
		// Recorded once by the interrupt, never by the aborted loop or its agent_end report.
		expect(persistedTranscript(sessionManager).filter(line => line.includes("withdrawn peer card"))).toEqual([
			"custom/peer-card: withdrawn peer card",
		]);
		expect(ends.flat().filter(message => JSON.stringify(message).includes("withdrawn peer card"))).toEqual([]);
		expect(mock.calls).toHaveLength(2);
	});

	it("discards hidden queued context instead of recording it", async () => {
		const { session, sessionManager, mock, streamStarted } = await createParkedSession();
		const running = session.prompt("first task");
		await streamStarted;

		// Context the user never sees: a display:false custom steer and a synthetic directive.
		await session.sendCustomMessage(
			{ customType: "hidden-context", content: "hidden context", display: false },
			{ deliverAs: "steer" },
		);
		await session.followUp("hidden directive", undefined, { synthetic: true });

		session.clearQueue({ forInterrupt: true });
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		await running.catch(() => {});

		// Stale hidden context must not land in history for the next prompt, nor resume the run.
		expect(persistedTranscript(sessionManager)).toEqual(["user: first task"]);
		expect(JSON.stringify(session.agent.state.messages)).not.toMatch(/hidden (context|directive)/);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(mock.calls).toHaveLength(1);
	});
});
