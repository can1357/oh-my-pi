/**
 * Regression test for issue #4094: "Plan reference is marked sent before prompt
 * delivery, so setup aborts can permanently suppress approved-plan context".
 *
 * After a plan is approved (but before plan mode re-entry), the executor's first
 * prompt injects the approved plan reference (`plan-mode-reference`) via
 * `#buildPlanReferenceMessage`, gated by `#planReferenceSent`. The flag used to
 * flip to `true` at message-construction time — before the prompt survived the
 * async setup steps (generation-bail returns, @-mention reads,
 * `before_agent_start` hooks, pre-prompt compaction) that precede
 * `agent.prompt`. If any of those bailed or threw, the flag stayed `true` with
 * nothing delivered, and the retry short-circuited to `null`, silently dropping
 * the approved plan for the rest of the session.
 *
 * Contract: `#planReferenceSent` tracks *delivery*, not construction. A prompt
 * that never reaches `agent.prompt` leaves the flag clear, so the next prompt
 * re-injects the plan. A prompt that DOES reach `agent.prompt` sets it, so the
 * plan is delivered exactly once.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { resolveLocalUrlToPath } from "../src/internal-urls";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import * as fileMentions from "../src/utils/file-mentions";

type ObservedPromptCall = { messageTexts: string[] };

type Harness = {
	session: AgentSession;
	sessionManager: SessionManager;
	observedCalls: ObservedPromptCall[];
};

function isTextContentBlock(value: unknown): value is TextContent {
	if (!value || typeof value !== "object") return false;
	return (value as TextContent).type === "text" && typeof (value as TextContent).text === "string";
}

function getMessageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const text: string[] = [];
	for (const content of message.content) {
		if (isTextContentBlock(content)) text.push(content.text);
	}
	return text.join("\n");
}

function createAssistantResponse(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("AgentSession plan-reference delivery tracking (issue #4094)", () => {
	let tempDir: TempDir;
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const cleanups: Array<() => Promise<void>> = [];

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-agent-session-plan-ref-setup-bail-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-session-plan-ref-setup-bail-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
	});

	async function createHarness(): Promise<Harness> {
		const observedCalls: ObservedPromptCall[] = [];

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"task.eager": "off",
			"todo.enabled": false,
			"todo.eager": "off",
			"todo.reminders": false,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		let session: AgentSession;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: (_model, context) => {
				observedCalls.push({ messageTexts: context.messages.map(message => getMessageText(message)) });
				const response = createAssistantResponse("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		cleanups.push(() => session.dispose());
		return { session, sessionManager, observedCalls };
	}

	/** Write a plan file to the session-scoped local root the executor reads from. */
	function writePlanFile(sessionManager: SessionManager, url: string, content: string): void {
		const resolved = resolveLocalUrlToPath(url, {
			getArtifactsDir: () => sessionManager.getArtifactsDir(),
			getSessionId: () => sessionManager.getSessionId(),
		});
		fs.mkdirSync(path.dirname(resolved), { recursive: true });
		fs.writeFileSync(resolved, content);
	}

	function hasPlanReference(call: ObservedPromptCall | undefined, planUrl: string): boolean {
		if (!call) return false;
		return call.messageTexts.some(text => text.includes("## Existing Plan") && text.includes(planUrl));
	}

	function countPlanReferences(call: ObservedPromptCall | undefined, planUrl: string): number {
		if (!call) return 0;
		return call.messageTexts.filter(text => text.includes("## Existing Plan") && text.includes(planUrl)).length;
	}

	it("re-injects the approved plan on retry when a @-mention read throws mid-setup", async () => {
		const { session, sessionManager, observedCalls } = await createHarness();
		const planUrl = "local://approved-plan.md";
		writePlanFile(sessionManager, planUrl, "# Approved Plan\n\nPHASE-6-MARKER\n");
		session.setPlanReferencePath(planUrl);

		// First post-approval prompt @-mentions a file whose read throws (I/O error).
		// The throw propagates out of the setup path before `agent.prompt`, so no
		// model request ever received the plan reference.
		const readSpy = vi
			.spyOn(fileMentions, "generateFileMentionMessages")
			.mockRejectedValue(new Error("EACCES: permission denied"));
		await expect(session.prompt("review @notes.md and continue")).rejects.toThrow();
		expect(observedCalls).toHaveLength(0);
		readSpy.mockRestore();

		// Retry (no @-mention): the plan reference MUST be re-injected.
		await session.prompt("continue the approved plan");
		expect(observedCalls).toHaveLength(1);
		expect(hasPlanReference(observedCalls[0], planUrl)).toBe(true);
	});

	it("re-injects the approved plan on retry when the prompt is aborted mid-setup", async () => {
		const { session, sessionManager, observedCalls } = await createHarness();
		const planUrl = "local://approved-plan-abort.md";
		writePlanFile(sessionManager, planUrl, "# Approved Plan\n\nABORT-MARKER\n");
		session.setPlanReferencePath(planUrl);

		// Fire a user interrupt (Esc) while the setup is still awaiting the
		// @-mention read: abort() bumps #promptGeneration, so the post-setup
		// generation-bail returns before `agent.prompt`. Nothing is delivered.
		let abortDone: Promise<void> = Promise.resolve();
		const readSpy = vi.spyOn(fileMentions, "generateFileMentionMessages").mockImplementation(async () => {
			abortDone = session.abort({ reason: USER_INTERRUPT_LABEL });
			return [];
		});
		await session.prompt("review @notes.md and continue");
		await abortDone;
		expect(observedCalls).toHaveLength(0);
		readSpy.mockRestore();

		// Retry: the plan reference MUST be re-injected.
		await session.prompt("continue the approved plan");
		expect(observedCalls).toHaveLength(1);
		expect(hasPlanReference(observedCalls[0], planUrl)).toBe(true);
	});

	it("delivers the approved plan exactly once when setup succeeds", async () => {
		const { session, sessionManager, observedCalls } = await createHarness();
		const planUrl = "local://approved-plan-once.md";
		writePlanFile(sessionManager, planUrl, "# Approved Plan\n\nONCE-MARKER\n");
		session.setPlanReferencePath(planUrl);

		// First prompt reaches agent.prompt: the plan reference is delivered once
		// and the flag is committed to the delivered state.
		await session.prompt("start executing the approved plan");
		expect(observedCalls).toHaveLength(1);
		expect(countPlanReferences(observedCalls[0], planUrl)).toBe(1);

		// Second prompt: the flag stays committed, so no SECOND copy is injected.
		// The turn-1 reference persists in history (that is correct context), so
		// the guard is that the count does not grow — not that it is absent.
		await session.prompt("keep going");
		expect(observedCalls).toHaveLength(2);
		expect(countPlanReferences(observedCalls[1], planUrl)).toBe(1);
	});
});
