import { afterEach, describe, expect, it, vi } from "bun:test";
import { fromJsonSchema, OmpErrors } from "@oh-my-pi/omptype";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { adaptSchemaForStrict, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { VibeJudgeTool } from "../../src/tools/vibe";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const SMOL: Model<Api> = {
	id: "smol",
	name: "smol",
	api: "openai-responses",
	provider: "p",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
	contextWindow: 128000,
	maxTokens: 4096,
} as Model<Api>;

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "p",
		model: "smol",
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeSession(appendModelUsage: (...args: unknown[]) => void): ToolSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.isolation.enabled": false,
		modelRoles: { judge: "p/smol" },
		"retry.fallbackChains": { judge: ["p/smol"] },
	});
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("p", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, "/nonexistent/vibe-judge-models.yml");
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([SMOL]);
	return {
		settings,
		modelRegistry,
		getSessionId: () => "sess-1",
		sessionManager: { appendModelUsage, getSessionId: () => "sess-1", getLeafId: () => null },
	} as unknown as ToolSession;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("vibe_judge", () => {
	it("answers through the session judge and journals the cost on the director's ledger", async () => {
		// completeSimple reports each attempt through onAttempt; the judge bills from there.
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, options) => {
			const message = reply("best: b\nclaims_tests: yes");
			options?.onAttempt?.(message);
			return message;
		});
		const appendModelUsage = vi.fn();
		const tool = new VibeJudgeTool(makeSession(appendModelUsage));

		const result = await tool.execute("call-1", {
			state: "Worker A: renamed the helper.\nWorker B: renamed the helper and all tests pass.",
			questions: [
				{
					id: "best",
					type: "choice",
					instructions: "Which worker result is more complete?",
					criteria: [{ label: "a" }, { label: "b" }],
				},
				{ id: "claims_tests", type: "bool", instructions: "Does any worker claim tests pass?" },
			],
		});

		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
		expect(JSON.parse(text)).toEqual({
			answers: {
				best: { type: "choice", choice: "b", probabilities: { a: 0, b: 1 }, confidence: 1 },
				claims_tests: { type: "bool", bool: 1 },
			},
			model: "p/smol",
		});
		expect(appendModelUsage).toHaveBeenCalledTimes(1);
		expect(appendModelUsage.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ purpose: "vibe_judge" }));
	});

	it("keeps questions callable when strict-mode providers rewrite the wire schema", () => {
		// An id-keyed question map is unrepresentable in strict mode, so providers
		// would silently send the tool non-strict; strict nulls must still validate.
		const strict = adaptSchemaForStrict(toolWireSchema(new VibeJudgeTool(makeSession(vi.fn()))), true);
		expect(strict.strict).toBe(true);
		const validate = fromJsonSchema(strict.schema);
		const call = {
			state: "Worker B: all tests pass.",
			questions: [
				{
					id: "best",
					type: "choice",
					instructions: "Which?",
					criteria: [
						{ label: "a", rubric: null },
						{ label: "b", rubric: "complete" },
					],
				},
				{ id: "tests", type: "bool", instructions: "Tests pass?", criteria: null },
			],
		};
		expect(validate(call)).not.toBeInstanceOf(OmpErrors);
	});
});
