import { afterEach, describe, expect, test } from "bun:test";
import { Effort, type Model, type UsageRouteCandidate } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { SessionUsageRouting } from "@oh-my-pi/pi-coding-agent/session/usage-routing";
import {
	CODEX,
	PROVIDER,
	createHarness,
	credentialIdOf,
	disposeHarness,
	ENABLED,
	expectNoStrayFetch,
	seedAccounts,
	seedReports,
	windowAt,
} from "../../ai/test/fixtures/usage-governor/harness";

const primary = `${PROVIDER}/primary`;
const first = `${CODEX}/first`;
const second = `${CODEX}/second`;
const owner = { kind: "role", role: "task" } as const;

function definition(id: string, highOnly = false) {
	return {
		id,
		name: id,
		reasoning: highOnly,
		...(highOnly ? { thinking: { mode: "effort" as const, efforts: [Effort.High] } } : {}),
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8192,
	};
}

async function setup(chains: Record<string, string[]> = { task: [first, second] }) {
	const h = await createHarness(ENABLED);
	const provider = h.usage.provider.bind(h.usage);
	h.usage.provider = id => {
		const original = provider(id);
		return {
			...original,
			governorAllowance: () => ["primary"],
			fetchUsage: async (params, ctx) => {
				const report = await original.fetchUsage(params, ctx);
				if (report) for (const limit of report.limits) limit.observedAt = Date.now();
				return report;
			},
		};
	};
	await seedAccounts(h, PROVIDER, [
		{ accountId: "source", email: "source@example.test", window: windowAt(30_000, 60_000, 0.1) },
	]);
	await seedAccounts(h, CODEX, [
		{ accountId: "fallback", email: "fallback@example.test", window: windowAt(30_000, 60_000, 0.1) },
	]);
	await seedReports(h, PROVIDER);
	await seedReports(h, CODEX);
	const settings = Settings.isolated({
		"usageGovernor.enabled": true,
		"retry.modelFallback": true,
		"retry.fallbackChains": chains,
	});
	settings.setModelRole("task", primary);
	if ("judge" in chains) settings.setModelRole("judge", primary);
	const registry = new ModelRegistry(h.storage, `${h.dir}/models.yml`, { settings });
	const oauth = {
		name: "synthetic",
		login: async () => {
			throw new Error("unexpected login");
		},
	};
	registry.registerProvider(PROVIDER, {
		api: "openai-completions",
		baseUrl: "https://source.example.test",
		oauth,
		models: [definition("primary")],
	});
	registry.registerProvider(CODEX, {
		api: "openai-completions",
		baseUrl: "https://fallback.example.test",
		oauth,
		models: [definition("first", true), definition("second")],
	});
	const routing = new SessionUsageRouting(settings, registry);
	return {
		h,
		settings,
		registry,
		routing,
		sourceId: credentialIdOf(h, PROVIDER, "source"),
		fallbackId: credentialIdOf(h, CODEX, "fallback"),
	};
}

afterEach(async () => {
	await disposeHarness();
});

describe("request-bound usage route preparation", () => {
	test("error routing walks verified alternatives even when current included quota is open", async () => {
		const x = await setup();
		try {
			const model = x.registry.find(PROVIDER, "primary")!;
			const proactive = await x.routing.candidates(owner, "s", model, x.sourceId, "proactive");
			const error = await x.routing.candidates(owner, "s", model, x.sourceId, "error");
			expect(proactive).toEqual([]);
			expect(error.map(route => route.target.selector)).toEqual([first, second]);
			expect(error.every(route => route.intent === "error" && route.credentialId === x.fallbackId)).toBe(true);
			expectNoStrayFetch(x.h);
		} finally {
			x.routing.dispose();
		}
	});

	test("a named role cannot borrow another role, exact-model or wildcard chain", async () => {
		const x = await setup({ task: [first], judge: [], [primary]: [second], [`${PROVIDER}/*`]: [second] });
		try {
			const model = x.registry.find(PROVIDER, "primary")!;
			expect(
				(await x.routing.candidates(owner, "s", model, x.sourceId, "error")).map(r => r.target.selector),
			).toEqual([first]);
			expect(await x.routing.candidates({ kind: "role", role: "judge" }, "s", model, x.sourceId, "error")).toEqual(
				[],
			);
		} finally {
			x.routing.dispose();
		}
	});

	test("an unattributed explicit model receives its own model-key envelope", async () => {
		const x = await setup({ task: [first], [primary]: [second] });
		try {
			const model = x.registry.find(PROVIDER, "primary")!;
			const routes = await x.routing.candidates(
				{ kind: "model", selector: primary },
				"s",
				model,
				x.sourceId,
				"error",
			);
			expect(routes.map(r => r.target.selector)).toEqual([second]);
			expect(routes[0]?.owner).toEqual({ kind: "model", selector: primary });
		} finally {
			x.routing.dispose();
		}
	});
});

async function preparationHarness(kind: "unavailable" | "context" | "effort" | "suppressed" | "normal") {
	const x = await setup();
	const source = x.registry.find(PROVIDER, "primary")!;
	const firstModel = x.registry.find(CODEX, "first")!;
	const secondModel = x.registry.find(CODEX, "second")!;
	let active: Model = source;
	let valid = true;
	let validations = 0;
	const route = (selector: string, model: Model): UsageRouteCandidate => ({
		scopeId: "preparation-test",
		revision: 1,
		owner,
		intent: "proactive",
		target: { selector, provider: model.provider, modelId: model.id, baseUrl: model.baseUrl },
		credentialId: x.fallbackId,
	});
	const routes = [route(kind === "unavailable" ? `${CODEX}/missing` : first, firstModel), route(second, secondModel)];
	// Keep the real registry and recovery path; replace only the external credential and
	// governor boundary so each eligibility branch can be exercised deterministically.
	x.registry.getApiKeyWithCredentialForProvider = async () =>
		({ apiKey: "test-bearer", credentialId: x.fallbackId }) as never;
	x.registry.authStorage.governor.validateRoute = () => {
		validations++;
		return valid;
	};
	x.registry.isSelectorSuppressed = selector => kind === "suppressed" && selector === first;
	const host = {
		agent: { state: { messages: [] } },
		settings: x.settings,
		usesRegistryAuth: () => true,
		modelRegistry: x.registry,
		usageRouting: { candidates: async () => routes },
		model: () => active,
		sessionId: () => "s",
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		thinkingLevelCeiling: () => (kind === "effort" ? Effort.Low : undefined),
		contextFitsModel: (model: Model) => kind !== "context" || model.id !== "first",
		resolveActiveEditMode: () => "hashline",
		setModelWithProviderSessionReset: async (model: Model) => {
			active = model;
		},
		sessionManager: { appendModelChange: () => {}, getSessionId: () => "s" },
		setThinkingLevel: () => {},
		syncAfterModelChange: async () => {},
		emitSessionEvent: async () => {},
		configWarnings: [],
	} as unknown as TurnRecoveryHost;
	const recovery = new TurnRecovery(host, { deferFallbackChainValidation: true });
	const current = async () =>
		({
			model: source,
			apiKey: () => undefined,
			resolved: { apiKey: "source-bearer", credentialId: x.sourceId },
		}) as never;
	return {
		...x,
		source,
		recovery,
		current,
		active: () => active,
		invalidate: () => {
			valid = false;
		},
		validations: () => validations,
	};
}

describe("preparation walks eligible routes", () => {
	for (const kind of ["unavailable", "context", "effort", "suppressed"] as const) {
		test(`skips ${kind} first route and selects the next authorized route`, async () => {
			const x = await preparationHarness(kind);
			try {
				const prepared = await x.recovery.prepareGovernedModelCall(x.source, x.current, owner);
				expect(prepared?.model.id).toBe("second");
				expect(x.active().id).toBe("second");
				expectNoStrayFetch(x.h);
			} finally {
				x.routing.dispose();
			}
		});
	}

	test("revalidates the selected binding on the next attempt", async () => {
		const x = await preparationHarness("normal");
		try {
			const firstAttempt = await x.recovery.prepareGovernedModelCall(x.source, x.current, owner);
			expect(firstAttempt?.model.id).toBe("first");
			expect(x.validations()).toBe(1);
			x.invalidate();
			await expect(x.recovery.prepareGovernedModelCall(x.active(), x.current, owner)).rejects.toThrow();
			expect(x.validations()).toBe(2);
		} finally {
			x.routing.dispose();
		}
	});

	test("aborted preparation does not switch models", async () => {
		const x = await preparationHarness("normal");
		try {
			const controller = new AbortController();
			controller.abort();
			await expect(
				x.recovery.prepareGovernedModelCall(x.source, x.current, owner, controller.signal),
			).rejects.toThrow();
			expect(x.active()).toBe(x.source);
			expect(x.validations()).toBe(0);
		} finally {
			x.routing.dispose();
		}
	});
});
