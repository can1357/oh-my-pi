/**
 * Contract: an advisor's fallback walk passes over a chain entry whose
 * resolved model is in cooldown, also when the entry is an alias such as
 * `pi/advisor` that names no model itself. A regression sends the review back
 * to the model that just failed, although a later entry of the chain could
 * answer it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { formatModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, fixedAdvisorTools } from "./helpers/agent-session-setup";

const WAIT_MS = 4_000;

function bundled(provider: string, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected the bundled model ${provider}/${id}`);
	return model;
}

const MAIN = bundled("openai", "gpt-4o-mini");
const ADVISOR_PRIMARY = bundled("anthropic", "claude-sonnet-4-5");
const ADVISOR_FALLBACK = bundled("google", "gemini-2.5-flash");
const NEXT_FALLBACK = bundled("openai", "gpt-4o");

describe("advisor fallback walk", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		for (const model of [ADVISOR_PRIMARY, ADVISOR_FALLBACK, NEXT_FALLBACK]) {
			authStorage.keys.setRuntime(model.provider, "test-key");
		}
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		modelRegistry.clearSuppressedSelectors();
	});

	it("passes over an alias of the failed primary in cooldown when its fallback fails, to the model after it", async () => {
		// The advisor's primary fails and goes into cooldown, and the advisor
		// moves to its fallback. The fallback fails too. Its own chain names
		// `pi/advisor`, which resolves to the primary, and then the next fallback.
		// The advisor must not go back to the primary while it is in cooldown: it
		// passes over the alias and answers from the next fallback. A walk that
		// took the alias would send the primary its second request, which answers.
		const advisorMock = createMockModel();
		const requestedModels: string[] = [];
		const answeredBy: string[] = [];
		// Each of these models fails its first request and answers after that.
		const failsOnce = new Set([formatModelString(ADVISOR_PRIMARY), formatModelString(ADVISOR_FALLBACK)]);
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: MAIN, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ handler: { content: ["Primary complete"] } }).stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"advisor.syncBacklog": "1",
			"retry.baseDelayMs": 1,
			"retry.fallbackChains": {
				advisor: [formatModelString(ADVISOR_FALLBACK)],
				[formatModelString(ADVISOR_FALLBACK)]: ["pi/advisor", formatModelString(NEXT_FALLBACK)],
			},
		});
		settings.setModelRole("advisor", formatModelString(ADVISOR_PRIMARY));
		const advised = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: fixedAdvisorTools(),
			advisorStreamFn: (model, context, options) => {
				const selector = formatModelString(model);
				requestedModels.push(selector);
				if (failsOnce.delete(selector)) {
					advisorMock.push({ throw: "overloaded_error: provider returned error 503" });
				} else {
					answeredBy.push(selector);
					advisorMock.push({ content: ["advisor ok"] });
				}
				return advisorMock.stream(model, context, options);
			},
		});
		session = advised;
		const fellBack = Promise.withResolvers<void>();
		advised.subscribe(event => {
			if (event.type === "retry_fallback_succeeded") fellBack.resolve();
		});
		expect(advised.setAdvisorEnabled(true)).toBe(true);

		await advised.prompt("Review this turn");
		await advised.waitForIdle();
		await withTimeout(fellBack.promise, WAIT_MS, "The advisor answered on no fallback");

		expect(requestedModels).toEqual([
			formatModelString(ADVISOR_PRIMARY),
			formatModelString(ADVISOR_FALLBACK),
			formatModelString(NEXT_FALLBACK),
		]);
		expect(answeredBy).toEqual([formatModelString(NEXT_FALLBACK)]);
	});
});
