import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ModelUsageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
// Earlier full-suite files that boot main() in ACP/RPC mode set PI_NO_TITLE=1
// process-wide and never restore it; automatic titling gates on it.
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

/** Main-turn billing, distinct from the title's so totals can be told apart. */
const MAIN_USAGE: ai.Usage = {
	input: 1000,
	output: 50,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1050,
	cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};
/** What a title request costs; recorded by no transcript entry. */
const TITLE_USAGE: ai.Usage = {
	input: 900,
	output: 12,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 912,
	cost: { input: 0.0004, output: 0.0006, cacheRead: 0, cacheWrite: 0, total: 0.001 },
};

/** Billed by the first, transiently failed attempt of a retried title request. */
const RETRY_USAGE: ai.Usage = {
	input: 600,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 600,
	cost: { input: 0.0002, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0002 },
};
/** Billed by a fork stream that ends in a provider error instead of a reply. */
const FORK_USAGE: ai.Usage = {
	input: 700,
	output: 4,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 704,
	cost: { input: 0.0003, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0004 },
};

/** A session whose main turns answer from `main` and whose side turns (the title fork) from `side`. */
async function createSession(
	main: MockModel,
	side: MockModel,
	settings: Record<string, unknown> = {},
	{ autoTitle = true }: { autoTitle?: boolean } = {},
): Promise<AgentSession> {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	const sessionSettings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		modelRoles: { tiny: `${model.provider}/${model.id}` },
		...settings,
	});
	session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: main.stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: sessionSettings,
		modelRegistry: new ModelRegistry(authStorage),
		sideStreamFn: side.stream,
		autoTitle,
	});
	return session;
}

/** A provider completion shaped like the ones title generation consumes. */
function titleCompletion(text: string, usage: ai.Usage): ai.AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** A transient provider failure: billed, and shaped so the retry wrapper tries again. */
function failedCompletion(usage: ai.Usage): ai.AssistantMessage {
	return {
		...titleCompletion("", usage),
		stopReason: "error",
		errorMessage: "overloaded",
		errorStatus: 503,
	};
}

/** The `model_usage` journal entries title generation wrote. */
function titleUsageEntries(manager: SessionManager): ModelUsageEntry[] {
	return manager
		.getEntries()
		.filter((entry): entry is ModelUsageEntry => entry.type === "model_usage" && entry.purpose === "title");
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

describe("title usage accounting", () => {
	it("journals the default fork title's billed usage into session totals", async () => {
		const main = createMockModel({ responses: [{ content: ["Reading the park tests first."], usage: MAIN_USAGE }] });
		const side = createMockModel({ handler: { content: [CARD_REPLY], usage: TITLE_USAGE } });
		const target = await createSession(main, side);
		const titled = nextTitle(target);

		await target.prompt(FIRST_MESSAGE);
		await titled;

		expect(target.sessionName).toBe("🧪 FLAKY: Fix flaky park tests");
		const entries = titleUsageEntries(target.sessionManager);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.usage).toEqual(TITLE_USAGE);
		// The fork runs on the session's own model, here the side mock.
		expect(entries[0]?.provider).toBe("mock");
		expect(entries[0]?.model).toBe("mock-model");
		// The fork is off-transcript: the side reply is not a session message, so its
		// spend can only come from the usage journal.
		expect(
			target.sessionManager
				.getEntries()
				.filter(entry => entry.type === "message" && entry.message.role === "assistant"),
		).toHaveLength(1);
		expect(target.sessionManager.getUsageStatistics().totalTokens).toBe(
			MAIN_USAGE.totalTokens + TITLE_USAGE.totalTokens,
		);
		expect(target.sessionManager.getUsageStatistics().output).toBe(MAIN_USAGE.output + TITLE_USAGE.output);
	});

	it("journals the tiny-model title's billed usage into session totals", async () => {
		const main = createMockModel({ responses: [{ content: ["unused"] }] });
		const side = createMockModel({ handler: { content: ["unused"] } });
		const target = await createSession(main, side, { "title.generator": "tiny" }, { autoTitle: false });
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			titleCompletion("<title>Fix flaky park tests</title>", TITLE_USAGE),
		);

		const title = await target.generateTitle(FIRST_MESSAGE);

		expect(title).toBe("Fix flaky park tests");
		const entries = titleUsageEntries(target.sessionManager);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.usage).toEqual(TITLE_USAGE);
		expect(target.sessionManager.getUsageStatistics().totalTokens).toBe(TITLE_USAGE.totalTokens);
		// The tiny model bypasses the metered session stream, so the title charges the cost gate itself.
		expect(target.costGate.spent).toBeCloseTo(TITLE_USAGE.cost.total, 10);
	});

	it("drops a stale session's title usage and charges only the session that started it", async () => {
		const main = createMockModel({ responses: [{ content: ["unused"] }] });
		const side = createMockModel({ handler: { content: ["unused"] } });
		const target = await createSession(main, side, { "title.generator": "tiny" }, { autoTitle: false });
		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<ai.AssistantMessage>();
		vi.spyOn(ai, "completeSimple").mockImplementation(() => {
			started.resolve();
			return response.promise;
		});

		const generation = target.generateTitle(FIRST_MESSAGE);
		await started.promise;
		const staleSessionId = target.sessionManager.getSessionId();
		const staleGate = target.costGate;
		expect(await target.newSession()).toBe(true);
		expect(target.sessionManager.getSessionId()).not.toBe(staleSessionId);
		response.resolve(titleCompletion("<title>Fix flaky park tests</title>", TITLE_USAGE));

		expect(await generation).toBeNull();
		expect(titleUsageEntries(target.sessionManager)).toHaveLength(0);
		expect(target.sessionManager.getUsageStatistics().totalTokens).toBe(0);
		expect(staleGate.spent).toBeCloseTo(TITLE_USAGE.cost.total, 10);
		expect(target.costGate.spent).toBe(0);
	});

	it("journals every billed attempt of a retried title request exactly once", async () => {
		const main = createMockModel({ responses: [{ content: ["unused"] }] });
		const side = createMockModel({ handler: { content: ["unused"] } });
		const target = await createSession(main, side, { "title.generator": "tiny" }, { autoTitle: false });
		vi.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(failedCompletion(RETRY_USAGE))
			.mockResolvedValueOnce(titleCompletion("<title>Fix flaky park tests</title>", TITLE_USAGE));

		const title = await target.generateTitle(FIRST_MESSAGE);

		expect(title).toBe("Fix flaky park tests");
		const entries = titleUsageEntries(target.sessionManager);
		// One entry per provider attempt: the transient failure and the retry that
		// answered. The retry's own report must not duplicate either of them.
		expect(entries.map(entry => [entry.stopReason, entry.usage.totalTokens])).toEqual([
			["error", RETRY_USAGE.totalTokens],
			["stop", TITLE_USAGE.totalTokens],
		]);
		expect(target.sessionManager.getUsageStatistics().totalTokens).toBe(
			RETRY_USAGE.totalTokens + TITLE_USAGE.totalTokens,
		);
		expect(target.costGate.spent).toBeCloseTo(RETRY_USAGE.cost.total + TITLE_USAGE.cost.total, 10);
	});

	it("journals a failed fork stream's billed usage before falling back", async () => {
		const main = createMockModel({ responses: [{ content: ["Reading the park tests first."], usage: MAIN_USAGE }] });
		const side = createMockModel({
			handler: { content: [], stopReason: "error", errorMessage: "overloaded", usage: FORK_USAGE },
		});
		const target = await createSession(main, side, { "title.icons": "emoji" });
		const replies = ["<title>Fix flaky park tests</title>", "<title>🧪 FLAKY</title>"];
		vi.spyOn(ai, "completeSimple").mockImplementation(async () =>
			titleCompletion(replies.shift() ?? "<title/>", TITLE_USAGE),
		);
		const titled = nextTitle(target);

		await target.prompt(FIRST_MESSAGE);
		await titled;

		// The failed fork names nothing, so the title model retitles and cards it.
		expect(target.sessionName).toContain("Fix flaky park tests");
		const entries = titleUsageEntries(target.sessionManager);
		// The failed fork's error message carries usage; it is journaled once,
		// followed by the fallback's own title and card requests.
		expect(entries.map(entry => [entry.stopReason, entry.usage.totalTokens])).toEqual([
			["error", FORK_USAGE.totalTokens],
			["stop", TITLE_USAGE.totalTokens],
			["stop", TITLE_USAGE.totalTokens],
		]);
		expect(target.sessionManager.getUsageStatistics().totalTokens).toBe(
			MAIN_USAGE.totalTokens + FORK_USAGE.totalTokens + TITLE_USAGE.totalTokens * 2,
		);
	});
});
