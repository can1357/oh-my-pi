/**
 * Regression test for issue #18610: "Agent receives 'Approved plan ... continue
 * executing' after the user paused plan mode, and edits files".
 *
 * Entering plan mode arms the draft plan path as the session's plan reference
 * and clears the delivery flag. If the operator then pauses or exits plan mode
 * WITHOUT approving, the draft stayed armed, so the next prompt re-injected it
 * through `#buildPlanReferenceMessage` as an "Approved plan inlined below;
 * MUST continue executing" message — telling the model to start editing.
 *
 * Contract: the plan reference is injected only after a real approval. A
 * plan-mode draft that was paused or exited without approval MUST NOT reach the
 * model as an approved plan; an approved plan MUST still be injected.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
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
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

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

describe("AgentSession plan-reference approval gate (issue #18610)", () => {
	let tempDir: TempDir;
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const cleanups: Array<() => Promise<void>> = [];

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-agent-session-plan-ref-approval-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-session-plan-ref-approval-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
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
			"task.eager": "default",
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

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

		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

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

	function planReferenceTexts(call: ObservedPromptCall | undefined): string[] {
		if (!call) return [];
		return call.messageTexts.filter(text => text.includes("## Existing Plan"));
	}

	it("does not inject a paused, unapproved plan draft as an approved plan", async () => {
		const { session, sessionManager, observedCalls } = await createHarness();
		const planUrl = "local://draft-plan.md";
		const planMarker = "UNAPPROVED-DRAFT-MARKER";
		writePlanFile(sessionManager, planUrl, `# Draft Plan\n\n${planMarker}\n`);

		// Plan mode entry arms the draft as the reference candidate.
		session.setPlanModeState({ enabled: true, planFilePath: planUrl, workflow: "parallel" });
		// The operator pauses/exits plan mode without approving.
		session.setPlanModeState(undefined);

		await session.prompt("what do you think about the testing approach?");

		// The prompt reached the model, so the absence below is a real negative.
		expect(observedCalls).toHaveLength(1);
		// The draft must NOT be described to the model as an approved plan.
		expect(planReferenceTexts(observedCalls[0])).toEqual([]);
		expect(observedCalls[0]?.messageTexts.some(text => text.includes(planMarker))).toBe(false);
	});

	it("still injects the plan reference after a real approval", async () => {
		const { session, sessionManager, observedCalls } = await createHarness();
		const planUrl = "local://approved-plan.md";
		const planMarker = "APPROVED-PLAN-MARKER";
		writePlanFile(sessionManager, planUrl, `# Approved Plan\n\n${planMarker}\n`);

		// Approval paths arm the reference via setPlanReferencePath.
		session.setPlanReferencePath(planUrl);

		await session.prompt("continue executing the approved plan");

		const references = planReferenceTexts(observedCalls[0]);
		expect(references).toHaveLength(1);
		expect(references[0]).toContain(planMarker);
		expect(references[0]).toContain(`<plan path="${planUrl}">`);
	});

	it("injects the plan after approval even when plan mode was paused first", async () => {
		const { session, sessionManager, observedCalls } = await createHarness();
		const planUrl = "local://paused-then-approved-plan.md";
		const planMarker = "PAUSED-THEN-APPROVED-MARKER";
		writePlanFile(sessionManager, planUrl, `# Plan\n\n${planMarker}\n`);

		session.setPlanModeState({ enabled: true, planFilePath: planUrl, workflow: "parallel" });
		session.setPlanModeState(undefined);
		// A later approval must re-arm the reference; the gate cannot be sticky.
		session.setPlanReferencePath(planUrl);

		await session.prompt("continue executing the approved plan");

		const references = planReferenceTexts(observedCalls[0]);
		expect(references).toHaveLength(1);
		expect(references[0]).toContain(planMarker);
	});
});
