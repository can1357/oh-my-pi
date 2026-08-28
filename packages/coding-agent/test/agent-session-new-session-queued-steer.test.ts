import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";

const OLD_USER = "OLD_SESSION_USER_SENTINEL";
const OLD_ASSISTANT = "OLD_SESSION_ASSISTANT_SENTINEL";
const HIDDEN_XDEV = "HIDDEN_XDEV_STEER_SENTINEL";
const LATE_OUTPUT = "LATE_OUTPUT_FROM_OLD_CONTINUE";

/** Collect the text of every message, tolerant of the AgentMessage union
 *  (some variants carry no `content`, and content blocks are a mixed union
 *  where only text blocks expose `text`). */
function collectText(messages: readonly unknown[]): string[] {
	const out: string[] = [];
	for (const message of messages) {
		if (!message || typeof message !== "object" || !("content" in message)) continue;
		const content = message.content;
		if (typeof content === "string") {
			out.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
				const text = block.text;
				if (typeof text === "string") out.push(text);
			}
		}
	}
	return out;
}
describe("newSession() atomic boundary vs queued hidden steer", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-new-session-steer-");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			for (const authStorage of authStorages.splice(0)) authStorage.close();
			await tempDir?.remove();
		}
	});

	it("does not start an old-context turn from a queued steer during /new", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const secondCallStarted = Promise.withResolvers<void>();
		const releaseSecondCall = Promise.withResolvers<void>();
		let secondRequestMessages: string[] = [];
		let providerCalls = 0;

		const mock: MockModel = createMockModel({
			handler: async context => {
				providerCalls++;
				if (providerCalls === 1) {
					return { content: [OLD_ASSISTANT], stopReason: "stop" };
				}
				// Second (stale) turn: snapshot the request tail and hold the
				// stream open so newSession() can complete before it appends.
				secondRequestMessages = collectText(context.messages);
				secondCallStarted.resolve();
				await releaseSecondCall.promise;
				return { content: [LATE_OUTPUT], stopReason: "stop" };
			},
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		// Build an old session with recognizable user + assistant messages.
		await session.prompt(OLD_USER);
		await agent.waitForIdle();
		expect(agent.state.messages.some(m => m.role === "assistant")).toBe(true);

		// Queue a hidden custom steer (xdev-mount-notice equivalent) while idle.
		agent.steer({
			role: "custom",
			customType: "xdev-mount-notice",
			content: HIDDEN_XDEV,
			display: false,
			timestamp: Date.now(),
		});
		expect(agent.hasQueuedMessages()).toBe(true);

		// Drive /new. The stale steer must NOT start an old-context turn.
		const newSessionDone = session.newSession();

		// Give the abort finally / post-prompt drain a chance to schedule.
		const raced = await Promise.race([
			secondCallStarted.promise.then(() => "second-started" as const),
			newSessionDone.then(() => "new-resolved" as const),
		]);

		const secondStartedBeforeReset = raced === "second-started";

		await newSessionDone;

		// After the transition the fresh agent owns no queued messages: reset drops them.
		expect(agent.hasQueuedMessages()).toBe(false);

		// Release the deferred stream (only relevant if a stale turn regressed into
		// starting) and let any stream settle.
		releaseSecondCall.resolve();
		await agent.waitForIdle();

		const branchText = collectText(agent.state.messages);

		// Contract 1: no second provider request starts during newSession().
		expect(secondStartedBeforeReset).toBe(false);
		expect(providerCalls).toBe(1);
		// Contract 2: fresh branch contains no old markers or hidden steer.
		expect(secondRequestMessages).not.toContain(OLD_USER);
		expect(secondRequestMessages).not.toContain(HIDDEN_XDEV);
		expect(branchText).not.toContain(OLD_USER);
		expect(branchText).not.toContain(OLD_ASSISTANT);
		// Contract 3: no late output appended to the fresh session.
		expect(branchText).not.toContain(LATE_OUTPUT);
	});
});
