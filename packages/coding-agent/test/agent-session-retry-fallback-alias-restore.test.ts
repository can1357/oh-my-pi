/**
 * Contract: with `retry.fallbackRevertPolicy: "cooldown-expiry"`, a session
 * that starts on a fallback returns to its primary only once the model the
 * recorded primary resolves to is out of cooldown, also when that primary is
 * an alias such as `pi/slow`. Startup records the configured string, and a
 * cooldown is keyed by the model that failed, never by the alias. A regression
 * restores the primary while it is in cooldown and sends it the next request.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
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
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const WAIT_MS = 4_000;
const COOLDOWN_MS = 60_000;

function bundled(provider: string, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected the bundled model ${provider}/${id}`);
	return model;
}

const PRIMARY = bundled("anthropic", "claude-sonnet-4-5");
const FALLBACK = bundled("openai", "gpt-4o-mini");

async function runTurn(session: AgentSession, text: string): Promise<void> {
	await withTimeout(session.prompt(text), WAIT_MS, "The prompt did not settle");
	await withTimeout(session.waitForIdle(), WAIT_MS, "The session did not settle");
}

describe("cooldown-expiry restore of a startup fallback", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		for (const model of [PRIMARY, FALLBACK]) {
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
		vi.restoreAllMocks();
	});

	it("stays on the fallback while the model its alias primary resolves to is in cooldown, and restores that model once the cooldown ends", async () => {
		// The default role is the alias `pi/slow`, which resolves to the primary.
		// Startup chose the fallback and recorded that configured string as the
		// primary to restore, which `initialRetryFallback` carries into the
		// session. The primary is in cooldown under its own `provider/id`, the
		// key `noteRetryFallbackCooldown` writes after a failure on it. The check
		// before each prompt reads the cooldown: a session that read only the
		// alias string would answer the first turn from the primary.
		const requestedModels: string[] = [];
		const mock = createMockModel({ handler: { content: ["answered"] } });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: FALLBACK, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(formatModelString(model));
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": { default: [formatModelString(FALLBACK)] },
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("slow", formatModelString(PRIMARY));
		settings.setModelRole("default", "pi/slow");
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		modelRegistry.suppressSelector(formatModelString(PRIMARY), now + COOLDOWN_MS);
		const started = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			initialRetryFallback: { role: "default", originalSelector: "pi/slow", originalThinkingLevel: undefined },
		});
		session = started;

		await runTurn(started, "Answer while the primary is in cooldown");
		expect(requestedModels).toEqual([formatModelString(FALLBACK)]);
		expect(started.model).toMatchObject({ provider: FALLBACK.provider, id: FALLBACK.id });

		now += COOLDOWN_MS + 1;
		await runTurn(started, "Answer after the cooldown");
		expect(requestedModels).toEqual([formatModelString(FALLBACK), formatModelString(PRIMARY)]);
		expect(started.model).toMatchObject({ provider: PRIMARY.provider, id: PRIMARY.id });
	});
});
