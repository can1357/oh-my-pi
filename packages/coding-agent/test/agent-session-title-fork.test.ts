import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
// Full-suite files that boot main() in ACP/RPC mode leave PI_NO_TITLE=1 behind,
// which gates titling off.
let previousNoTitle: string | undefined;

beforeEach(() => {
	previousNoTitle = Bun.env.PI_NO_TITLE;
	delete Bun.env.PI_NO_TITLE;
});

afterEach(async () => {
	if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
	else Bun.env.PI_NO_TITLE = previousNoTitle;
	vi.restoreAllMocks();
	await session?.dispose();
	authStorage?.close();
	session = undefined;
	authStorage = undefined;
});

const FIRST_MESSAGE = "fix the flaky park tests";
const CARD_REPLY = '<title nf="nf-md-flask" emoji="🧪" code="FLAKY">Fix flaky park tests</title>';

/** A session whose main turns answer from `main` and whose side turns (the title fork) from `side`. */
async function createSession(
	main: MockModel,
	side: MockModel,
	settings: Record<string, unknown> = {},
): Promise<AgentSession> {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: main.stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			modelRoles: { tiny: `${model.provider}/${model.id}` },
			...settings,
		}),
		modelRegistry: new ModelRegistry(authStorage),
		sideStreamFn: side.stream,
	});
	return session;
}

/** Resolves on the session's next title change. */
function nextTitle(target: AgentSession): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = target.sessionManager.onSessionNameChanged(() => {
		unsubscribe();
		resolve();
	});
	return promise;
}

describe("AgentSession title fork", () => {
	it("titles the session from a fork of the first reply, sharing the main request's prefix and cache key", async () => {
		const main = createMockModel({ responses: [{ content: ["Reading the park tests first."] }] });
		const side = createMockModel({ handler: { content: [CARD_REPLY] } });
		const target = await createSession(main, side);
		const titleModel = vi.spyOn(ai, "completeSimple");
		const titled = nextTitle(target);

		target.maybeStartTitleGeneration(FIRST_MESSAGE);
		await target.prompt(FIRST_MESSAGE);
		await titled;

		expect(target.sessionName).toBe("🧪 FLAKY: Fix flaky park tests");
		expect(titleModel).not.toHaveBeenCalled();
		const mainCall = main.calls[0]!;
		const sideCall = side.calls[0]!;
		expect(sideCall.context.systemPrompt).toEqual(mainCall.context.systemPrompt);
		expect(sideCall.context.tools).toEqual(mainCall.context.tools);
		expect(sideCall.context.messages.slice(0, mainCall.context.messages.length)).toEqual(mainCall.context.messages);
		// Providers key the prompt cache on `promptCacheKey`, else the session id.
		expect(sideCall.options?.promptCacheKey).toBe(mainCall.options?.promptCacheKey ?? mainCall.options?.sessionId);
		// The fork runs beside the main turn, which finishes on its own.
		expect(target.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it.each<[string, MockResponse, MockResponse]>([
		["the fork declines", { content: ["Reading the park tests first."] }, { content: ["<title/>"] }],
		["the fork request fails", { content: ["Reading the park tests first."] }, { throw: "overloaded" }],
		["the reply never starts a block to fork", { throw: "invalid request" }, { content: [CARD_REPLY] }],
	])("falls back to the title model when %s", async (_case, mainResponse, sideResponse) => {
		const main = createMockModel({ responses: [mainResponse] });
		const side = createMockModel({ handler: sideResponse });
		const target = await createSession(main, side);
		const titleInputs: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
			const content = context.messages[0]?.content;
			titleInputs.push(typeof content === "string" ? content : "");
			return createAssistantMessage("<title>Fix flaky park tests</title>");
		});
		const titled = nextTitle(target);

		target.maybeStartTitleGeneration(FIRST_MESSAGE);
		await target.prompt(FIRST_MESSAGE).catch(() => {});
		await titled;

		expect(target.sessionName).toBe("Fix flaky park tests");
		expect(titleInputs).toHaveLength(1);
		expect(titleInputs[0]).toContain(FIRST_MESSAGE);
	});

	it("forks a title for a message that arrived while a declining title request still ran", async () => {
		const main = createMockModel({ handler: { content: ["Reading the park tests first."] } });
		const side = createMockModel({ responses: [{ content: ["<title/>"] }], handler: { content: [CARD_REPLY] } });
		const target = await createSession(main, side);
		const titleModelStarted = Promise.withResolvers<void>();
		const titleModelReply = Promise.withResolvers<ai.AssistantMessage>();
		const titleModel = vi.spyOn(ai, "completeSimple").mockImplementation(() => {
			titleModelStarted.resolve();
			return titleModelReply.promise;
		});

		// The first message's fork declines, so the title model takes over and is still running...
		target.maybeStartTitleGeneration("look at the park tests");
		await target.prompt("look at the park tests");
		await titleModelStarted.promise;
		// ...when the second message arrives; the title model then declines too.
		target.maybeStartTitleGeneration(FIRST_MESSAGE);
		await target.prompt(FIRST_MESSAGE);
		const titled = nextTitle(target);
		titleModelReply.resolve(createAssistantMessage("<title/>"));
		await titled;

		expect(target.sessionName).toBe("🧪 FLAKY: Fix flaky park tests");
		expect(side.calls).toHaveLength(2);
		expect(titleModel).toHaveBeenCalledTimes(1);
	});

	it("titles with the title model alone under title.generator tiny", async () => {
		const main = createMockModel({ responses: [{ content: ["Reading the park tests first."] }] });
		const side = createMockModel({ handler: { content: [CARD_REPLY] } });
		const target = await createSession(main, side, { "title.generator": "tiny" });
		vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("<title>Fix flaky park tests</title>"));
		const titled = nextTitle(target);

		target.maybeStartTitleGeneration(FIRST_MESSAGE);
		await target.prompt(FIRST_MESSAGE);
		await titled;

		expect(target.sessionName).toBe("Fix flaky park tests");
		expect(side.calls).toHaveLength(0);
	});

	it("cancels an armed fork on interrupt without blocking the next message's title", async () => {
		const main = createMockModel({ responses: [{ content: ["Reading the park tests first."] }] });
		const side = createMockModel({ handler: { content: [CARD_REPLY] } });
		const target = await createSession(main, side);
		const titleModel = vi.spyOn(ai, "completeSimple");

		target.maybeStartTitleGeneration("look at the park tests");
		await target.abort();
		const titled = nextTitle(target);
		target.maybeStartTitleGeneration(FIRST_MESSAGE);
		await target.prompt(FIRST_MESSAGE);
		await titled;

		expect(target.sessionName).toBe("🧪 FLAKY: Fix flaky park tests");
		expect(side.calls).toHaveLength(1);
		expect(titleModel).not.toHaveBeenCalled();
	});
});
