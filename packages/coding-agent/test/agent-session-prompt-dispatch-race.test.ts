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
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("AgentSession concurrent prompt dispatch", () => {
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;

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
	});

	function createSession() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: createMockModel({
				responses: [{ content: ["First done"] }, { content: ["Second done"] }, { content: ["Third done"] }],
			}).stream,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
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
