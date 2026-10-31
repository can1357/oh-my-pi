import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	AUTO_PREWALK_TIMEOUT_MS,
	type AutoPrewalkInput,
	classifyAutoPrewalk,
	type PrewalkRoute,
} from "@oh-my-pi/pi-coding-agent/auto-prewalk/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { hasNativeJudge, resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { MAX_TINY_MESSAGE_CHARS } from "@oh-my-pi/pi-coding-agent/tiny/message-preproc";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";

const JEV_PREVIEW = {
	id: "jev-preview",
	name: "JEV Preview",
	api: "typesafe",
	provider: "typesafe",
	baseUrl: "https://judge.example.test/",
	kind: "judge",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as Model<Api>;

const LOCAL = getBundledModel("local", "qwen2.5-1.5b");
if (!LOCAL) throw new Error("Expected bundled local judge model");

const REQUEST = "trace the sync engine, then fix the stale cursor";

interface JudgeRequest {
	state: Record<string, string>;
	questions: Record<string, { criteria: Record<string, string> }>;
}

function nativeJudgeDeps() {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("typesafe", "ts-key");
	const registry = new ModelRegistry(authStorage, "/nonexistent/auto-prewalk-models.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue([JEV_PREVIEW]);
	return { settings: Settings.isolated({ modelRoles: { judge: "typesafe/jev-preview" } }), registry };
}

/** A System One answer; `choice` is the highest probability, as the real API reports. */
function answer(prewalk: number, primary: number, direct: number) {
	const probabilities: Record<PrewalkRoute, number> = { prewalk, primary, direct };
	const choice: PrewalkRoute =
		prewalk >= primary && prewalk >= direct ? "prewalk" : primary >= direct ? "primary" : "direct";
	return { type: "choice", choice, probabilities, confidence: probabilities[choice] };
}

/** Serve `route` as the System One reply and record every request body. */
function serveJudge(route: unknown): JudgeRequest[] {
	const requests: JudgeRequest[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async (_url, init) => {
			requests.push(JSON.parse(String(init?.body)) as JudgeRequest);
			return Response.json({
				model: "jev-1.13.0",
				answers: { route },
				usage: { input_tokens: 8, output_tokens: 2 },
			});
		}),
	);
	return requests;
}

const userTurn = (text: string, extra: Partial<Extract<AgentMessage, { role: "user" }>> = {}): AgentMessage => ({
	role: "user",
	content: text,
	timestamp: 1,
	...extra,
});

const classify = (input: Partial<AutoPrewalkInput> = {}) =>
	classifyAutoPrewalk({ request: REQUEST, history: [], ...input }, nativeJudgeDeps());

afterEach(() => {
	vi.restoreAllMocks();
});

describe("classifyAutoPrewalk decision", () => {
	it.each([
		["a confident prewalk", answer(0.84, 0.1, 0.06), "prewalk", true],
		["a prewalk exactly at the threshold", answer(0.7, 0.2, 0.1), "prewalk", true],
		["a prewalk that wins below the threshold", answer(0.69, 0.21, 0.1), "prewalk", false],
		["a primary win", answer(0.18, 0.62, 0.2), "primary", false],
		["a direct win", answer(0.06, 0.1, 0.84), "direct", false],
	] as const)("arms only for confident prewalk: %s", async (_label, reply, route, arm) => {
		serveJudge(reply);

		expect(await classify()).toEqual({
			route,
			probabilities: reply.probabilities,
			confidence: reply.confidence,
			arm,
		});
	});

	it("asks a single route question over the three outcomes and bills it as auto-prewalk", async () => {
		const requests = serveJudge(answer(0.84, 0.1, 0.06));
		const onUsage = vi.fn();

		await classifyAutoPrewalk({ request: REQUEST, history: [] }, { ...nativeJudgeDeps(), onUsage });

		expect(requests).toHaveLength(1);
		expect(Object.keys(requests[0]!.questions)).toEqual(["route"]);
		expect(Object.keys(requests[0]!.questions.route!.criteria).sort()).toEqual(["direct", "prewalk", "primary"]);
		expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ purpose: "auto-prewalk", role: "typesafe" }));
	});

	it("rejects an answer without probabilities instead of guessing an arm", async () => {
		serveJudge({ type: "choice", choice: "prewalk" });

		await expect(classify()).rejects.toThrow("malformed");
	});

	it.each([
		["probabilities that do not sum to one", { ...answer(0.8, 0.9, 0.1), choice: "primary", confidence: 0.9 }],
		["a selected route that is not the most probable", { ...answer(0.8, 0.1, 0.1), choice: "primary" }],
		["a negative confidence", { ...answer(0.8, 0.1, 0.1), confidence: -0.8 }],
		["a non-finite confidence", { ...answer(0.8, 0.1, 0.1), confidence: Number.POSITIVE_INFINITY }],
		[
			"a probability outside 0-1",
			{ ...answer(0.8, 0.1, 0.1), probabilities: { prewalk: 1.2, primary: -0.1, direct: -0.1 } },
		],
	])("rejects %s instead of normalizing it into a decision", async (_label, reply) => {
		serveJudge(reply);

		await expect(classify()).rejects.toThrow("auto-prewalk");
	});

	it("never executes a prompted model when the cached chain predates a native login", async () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.now());
		const { registry } = nativeJudgeDeps();
		const stale = Settings.isolated({
			modelRoles: { judge: "typesafe/jev-preview" },
			"retry.fallbackChains": { judge: [`${LOCAL.provider}/${LOCAL.id}`] },
		});
		const available = vi.spyOn(registry, "getAvailable").mockReturnValue([LOCAL]);
		resolveJudge({ settings: stale, registry, purpose: "seed" }).primaryModel();
		available.mockReturnValue([JEV_PREVIEW, LOCAL]);
		const complete = vi.spyOn(tinyModelClient, "complete").mockResolvedValue("prewalk");
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		expect(hasNativeJudge(stale, registry)).toBe(true);
		await expect(
			classifyAutoPrewalk({ request: REQUEST, history: [] }, { settings: stale, registry }),
		).rejects.toThrow("native");

		expect(complete).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("never falls back to a prompted model when the judge role has no native backend", async () => {
		const registry = new ModelRegistry(createInMemoryAuthStorage(), "/nonexistent/auto-prewalk-models.yml");
		vi.spyOn(registry, "getAvailable").mockReturnValue([LOCAL]);
		const settings = Settings.isolated({ modelRoles: { judge: `${LOCAL.provider}/${LOCAL.id}` } });
		const complete = vi.spyOn(tinyModelClient, "complete").mockResolvedValue("prewalk");
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await expect(classifyAutoPrewalk({ request: REQUEST, history: [] }, { settings, registry })).resolves.toBe(
			undefined,
		);

		expect(complete).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("classifyAutoPrewalk bounds", () => {
	it("gives up on a judge that never answers once the timeout fires", async () => {
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation(ms =>
			ms === AUTO_PREWALK_TIMEOUT_MS
				? AbortSignal.abort(new DOMException("timed out", "TimeoutError"))
				: realTimeout(ms),
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(asGlobalFetch(() => new Promise<Response>(() => {})));

		await expect(classify()).rejects.toThrow();
	});

	it("stops waiting when the caller aborts", async () => {
		const requested = Promise.withResolvers<void>();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(
				(_url, init) =>
					new Promise<Response>((_resolve, reject) => {
						requested.resolve();
						init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
					}),
			),
		);
		const controller = new AbortController();
		const pending = classifyAutoPrewalk(
			{ request: REQUEST, history: [] },
			{ ...nativeJudgeDeps(), signal: controller.signal },
		);

		await requested.promise;
		controller.abort(new Error("prompt aborted"));

		await expect(pending).rejects.toThrow("prompt aborted");
	});
});

describe("classifyAutoPrewalk follow-up context", () => {
	it("sends only the request when the transcript has nothing before it", async () => {
		const requests = serveJudge(answer(0.1, 0.1, 0.8));

		await classify();

		expect(requests[0]!.state).toEqual({ request: REQUEST });
	});

	it("resolves a short follow-up through the earlier request and the agent's reply, not its reasoning", async () => {
		const requests = serveJudge(answer(0.8, 0.1, 0.1));
		const reply: AgentMessage = {
			...createAssistantMessage("The cursor resets because sync() reads a stale offset."),
			content: [
				{ type: "thinking", thinking: "PRIVATE-REASONING" },
				{ type: "text", text: "The cursor resets because sync() reads a stale offset." },
			],
		};

		await classify({
			request: "do that",
			history: [userTurn("why does the sync cursor reset after a reconnect?"), reply],
		});

		expect(requests[0]!.state).toEqual({
			request: "do that",
			previous_request: "why does the sync cursor reset after a reconnect?",
			previous_response: "The cursor resets because sync() reads a stale offset.",
		});
	});

	it("keeps only the latest request/reply pair and bounds it", async () => {
		const requests = serveJudge(answer(0.1, 0.1, 0.8));

		await classify({
			request: "continue",
			history: [
				userTurn("ancient task about the billing exporter"),
				createAssistantMessage("ancient reply about the billing exporter"),
				userTurn("latest task about the sync cursor"),
				createAssistantMessage("x".repeat(10 * MAX_TINY_MESSAGE_CHARS)),
			],
		});

		const { state } = requests[0]!;
		expect(state.previous_request).toBe("latest task about the sync cursor");
		expect(state.previous_response!.length).toBeLessThanOrEqual(MAX_TINY_MESSAGE_CHARS);
		expect(JSON.stringify(state)).not.toContain("billing exporter");
	});

	it("looks past acknowledgements and injected turns to the request they follow", async () => {
		const requests = serveJudge(answer(0.1, 0.1, 0.8));

		await classify({
			request: "yes, implement it",
			history: [
				userTurn("refactor the scheduler to use a priority queue"),
				createAssistantMessage("Plan: replace the sorted array with a heap."),
				userTurn("ok"),
				userTurn("steered nudge", { attribution: "agent" }),
				userTurn("auto-continue", { synthetic: true }),
			],
		});

		expect(requests[0]!.state).toEqual({
			request: "yes, implement it",
			previous_request: "refactor the scheduler to use a priority queue",
			previous_response: "Plan: replace the sorted array with a heap.",
		});
	});
});
