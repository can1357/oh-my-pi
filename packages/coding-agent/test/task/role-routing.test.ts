import { afterEach, describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { Effort, streamSimple, type Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { ModelRegistry } from "../../src/config/model-registry";
import { cfgDisabledProviders, cfgEnabledModels, cfgModelRoles } from "../../src/config/model-settings";
import { Settings } from "../../src/config/settings";
import { cfgRetryFallbackChains } from "../../src/session/settings";
import {
	adoptRoleRouteCandidate,
	assertRoleDispatch,
	createTaskModelRoute,
	inspectRoleRouteCandidate,
	narrowRoleRoute,
	resolveRoleRoute,
	restoreTaskModelRoute,
	roleRouteFallbackCandidates,
	roleRouteMetadata,
	wrapRoleRouteStream,
	type TaskModelAuthority,
} from "../../src/task/role-routing";

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const requestSinks = new Map<string, string[]>();

afterEach(() => {
	for (const server of servers) server.stop(true);
	servers.length = 0;
	requestSinks.clear();
});
function model(id: string, changes: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	const base = buildModel({
		provider: "route-fixture",
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		compat: { supportsReasoningEffort: true },
		input: ["text", "image"],
		supportsTools: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
	return { ...base, ...changes };
}

function fixture() {
	const transport: { onRequest?: (body: Record<string, unknown>, attempt: number) => Response | undefined } = {};
	const received: Record<string, unknown>[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request, server) {
			const body = (await request.json()) as Record<string, unknown>;
			received.push(body);
			requestSinks.get(`${server.url}v1`)?.push(`route-fixture/${body.model}:${body.reasoning_effort ?? "unset"}`);
			const rejected = transport.onRequest?.(body, received.length);
			if (rejected) return rejected;
			return new Response(
				'data: {"id":"route","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
					'data: {"id":"route","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
					"data: [DONE]\n\n",
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	servers.push(server);
	const primary = model("primary", { baseUrl: `${server.url}v1` });
	const fallback = model("fallback", { baseUrl: `${server.url}v1` });
	const outsider = model("outsider", { baseUrl: `${server.url}v1` });
	const state = { models: [primary, fallback, outsider] as Model[], available: true };
	const registry = {
		getAll: () => state.models,
		getAvailable: () => (state.available ? state.models : []),
		hasConfiguredAuth: () => state.available,
		isSelectorSuppressed: () => false,
	} as unknown as ModelRegistry;
	const settings = Settings.isolated({
		modelRoles: { review: "route-fixture/primary:high", independent: "route-fixture/primary" },
		"retry.fallbackChains": { review: ["route-fixture/fallback:low"] },
	});
	const authority: TaskModelAuthority = { settings, agentName: "worker" };
	return { primary, fallback, outsider, state, registry, settings, authority, transport, received };
}

function recordingStream(delivered: string[]): StreamFn {
	return async (serving, context, options) => {
		requestSinks.set(serving.baseUrl, delivered);
		const stream = streamSimple(serving, context, { ...options, apiKey: "test-only-key" });
		const result = await stream.result();
		if (result.stopReason === "error") {
			if (AIError.is(AIError.classifyMessage(result), AIError.Flag.HostAdmission)) {
				throw new AIError.ModelSelectionError(result.errorMessage ?? "Admission rejected");
			}
			throw new Error(result.errorMessage ?? "Loopback provider failed");
		}
		return stream;
	};
}

describe("governed provider dispatch closure", () => {
	it("blocks authenticated enabled catalog models without an operator grant", async () => {
		const f = fixture();
		cfgEnabledModels.override(f.settings, ["route-fixture/*"]);
		await expect(
			createTaskModelRoute({
				authority: f.authority,
				modelRegistry: f.registry,
				selectors: ["route-fixture/outsider"],
				explicit: true,
			}),
		).rejects.toThrow(/not authorized/);
	});

	it("does not fuzzy-rematch an unavailable explicit identity onto a similarly named approved model", async () => {
		const f = fixture();
		const sibling = model("primary-extra");
		f.state.models = [sibling];
		cfgModelRoles.override(f.settings, { expected: "route-fixture/primary", sibling: "route-fixture/primary-extra" });
		cfgRetryFallbackChains.override(f.settings, {});
		const admitted = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["route-fixture/primary"],
			explicit: true,
		});
		expect(() => resolveRoleRoute(admitted.permit, f.registry)).toThrow(/No usable model remains/);
	});

	it("checks disabled entries' authority and preserves their ordered occurrence before using an approved alternative", async () => {
		const f = fixture();
		const disabled = model("disabled", { provider: "disabled-route" });
		const unassigned = model("unassigned", { provider: "disabled-route" });
		f.state.models.push(disabled, unassigned);
		cfgModelRoles.override(f.settings, { disabled: "disabled-route/disabled", enabled: "route-fixture/primary" });
		cfgRetryFallbackChains.override(f.settings, {});
		cfgDisabledProviders.override(f.settings, ["disabled-route"]);
		await expect(
			createTaskModelRoute({
				authority: f.authority,
				modelRegistry: f.registry,
				selectors: ["disabled-route/unassigned", "route-fixture/primary"],
				explicit: true,
			}),
		).rejects.toThrow(/not authorized/);
		const admitted = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["disabled-route/disabled", "route-fixture/primary"],
			explicit: true,
		});
		expect(resolveRoleRoute(admitted.permit, f.registry)).toMatchObject({
			model: { provider: "route-fixture", id: "primary" },
			occurrence: 1,
		});
	});

	it("surfaces fixed effort changes and provider-side fallback options before dispatch", async () => {
		const f = fixture();
		const { permit } = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@review"],
			explicit: true,
		});
		const delivered: string[] = [];
		const guarded = wrapRoleRouteStream(() => permit, recordingStream(delivered), f.registry);
		await guarded(f.primary, { messages: [] }, { reasoning: Effort.High });
		await expect(guarded(f.primary, { messages: [] }, { reasoning: Effort.Low })).rejects.toThrow(/effort/);
		await expect(
			guarded(f.primary, { messages: [] }, { reasoning: Effort.High, forceReasoningOff: true }),
		).rejects.toThrow(/suppression/);
		await expect(
			guarded(f.primary, { messages: [] }, { reasoning: Effort.High, fallbacks: [{ model: "outsider" }] }),
		).rejects.toThrow(/fallback/);
		expect(delivered).toEqual(["route-fixture/primary:high"]);
	});

	it("rejects a payload hook changing the serving model or fixed reasoning", async () => {
		const f = fixture();
		const { permit } = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@review"],
			explicit: true,
		});
		const delivered: string[] = [];
		const guarded = wrapRoleRouteStream(() => permit, recordingStream(delivered), f.registry);
		await expect(
			guarded(
				f.primary,
				{ messages: [] },
				{ reasoning: Effort.High, onPayload: () => ({ model: "outsider", reasoning_effort: "high" }) },
			),
		).rejects.toThrow(AIError.ModelSelectionError);
		await expect(
			guarded(
				f.primary,
				{ messages: [] },
				{ reasoning: Effort.High, onPayload: () => ({ model: "primary", reasoning_effort: "low" }) },
			),
		).rejects.toThrow(AIError.ModelSelectionError);
		expect(delivered).toEqual([]);
	});

	it("allows hook narrowing/reorder and effort qualification without adding authority", async () => {
		const f = fixture();
		cfgModelRoles.override(f.settings, {
			review: "route-fixture/primary",
			fallback: "route-fixture/fallback",
			extra: "route-fixture/outsider",
		});
		const original = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@review", "@fallback"],
			explicit: true,
		});
		const narrowed = narrowRoleRoute(original.permit, ["@fallback:high", "@review:low"], f.registry);
		expect(resolveRoleRoute(narrowed.permit, f.registry)).toMatchObject({
			model: { id: "fallback" },
			thinkingLevel: Effort.High,
			role: "fallback",
			occurrence: 0,
		});
		assertRoleDispatch(narrowed.permit, f.fallback, Effort.High, undefined, f.registry);
		expect(() => narrowRoleRoute(original.permit, ["@extra"], f.registry)).toThrow(/escaped/);
		expect(() => narrowRoleRoute(narrowed.permit, ["@fallback:low"], f.registry)).toThrow(/escaped/);
	});

	for (const change of ["removed", "reordered", "duplicate", "effort"] as const) {
		it(`revokes a ${change} role dependency even when another role grants the same model`, async () => {
			const f = fixture();
			cfgModelRoles.override(f.settings, {
				review: "route-fixture/primary:high,route-fixture/fallback:low",
				independent: "route-fixture/primary",
			});
			cfgRetryFallbackChains.override(f.settings, {});
			const { permit } = await createTaskModelRoute({
				authority: f.authority,
				modelRegistry: f.registry,
				selectors: ["@review"],
				explicit: true,
			});
			const replacements = {
				removed: undefined,
				reordered: "route-fixture/fallback:low,route-fixture/primary:high",
				duplicate: "route-fixture/primary:high,route-fixture/primary:high,route-fixture/fallback:low",
				effort: "route-fixture/primary:low,route-fixture/fallback:low",
			};
			cfgModelRoles.override(f.settings, {
				...(replacements[change] ? { review: replacements[change] } : {}),
				independent: "route-fixture/primary",
			});
			expect(() => assertRoleDispatch(permit, f.primary, Effort.High, undefined, f.registry)).toThrow(
				/configuration changed/,
			);
		});
	}

	it("keeps auto as a configured mode across an approved retry occurrence", async () => {
		const f = fixture();
		cfgModelRoles.override(f.settings, { review: "route-fixture/primary:auto" });
		cfgRetryFallbackChains.override(f.settings, { review: ["route-fixture/fallback:auto"] });
		const { permit } = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@review"],
			explicit: true,
		});
		const next = roleRouteFallbackCandidates(permit, f.registry)[0];
		expect(next).toMatchObject({ model: { id: "fallback" }, thinkingLevel: "auto", fixedEffort: false });
		inspectRoleRouteCandidate(permit, next.selector, next.model, f.registry);
		expect(resolveRoleRoute(permit, f.registry).model.id).toBe("primary");
		adoptRoleRouteCandidate(permit, next.selector, next.model, f.registry);
		assertRoleDispatch(permit, f.fallback, Effort.Low, undefined, f.registry);
		assertRoleDispatch(permit, f.fallback, Effort.High, undefined, f.registry);
		expect(roleRouteMetadata(permit)?.selectedOccurrence).toBe(1);
		expect(() => narrowRoleRoute(permit, ["route-fixture/fallback:low"], f.registry)).toThrow(/escaped/);
	});

	it("preserves literal colon IDs while role effort overrides remain independent", async () => {
		const f = fixture();
		const literal = model("primary:high");
		f.state.models.push(literal);
		cfgModelRoles.override(f.settings, { literal: "route-fixture/primary:high", review: "route-fixture/primary" });
		const literalRoute = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@literal:low"],
			explicit: true,
		});
		expect(resolveRoleRoute(literalRoute.permit, f.registry)).toMatchObject({
			model: { id: "primary:high" },
			thinkingLevel: Effort.Low,
		});
		assertRoleDispatch(literalRoute.permit, literal, Effort.Low, undefined, f.registry);
		const realPrimary = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@review:high"],
			explicit: true,
		});
		expect(resolveRoleRoute(realPrimary.permit, f.registry)).toMatchObject({
			model: { id: "primary" },
			thinkingLevel: Effort.High,
		});
		expect(
			parseModelString("route-fixture/primary:high", {
				isLiteralModelId: (provider, id) => provider === "route-fixture" && id === literal.id,
			}),
		).toEqual({ provider: "route-fixture", id: "primary:high" });
	});

	it("revalidates deferred discovery identity and rejects a late transport replacement", async () => {
		const f = fixture();
		f.state.models = [];
		cfgModelRoles.override(f.settings, { review: "route-fixture/late" });
		cfgRetryFallbackChains.override(f.settings, {});
		const { permit } = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@review:high"],
			explicit: true,
		});
		const late = model("late");
		f.state.models.push(late);
		expect(resolveRoleRoute(permit, f.registry)).toMatchObject({ model: { id: "late" }, thinkingLevel: Effort.High });
		f.state.models = [{ ...late, baseUrl: "http://127.0.0.1:2/v1" }];
		expect(() => assertRoleDispatch(permit, late, Effort.High, undefined, f.registry)).toThrow(/transport/);
		f.state.models = [{ ...late, requestModelId: "unapproved-wire-model" }];
		expect(() => assertRoleDispatch(permit, late, Effort.High, undefined, f.registry)).toThrow(
			/wire model\/effort policy/,
		);
	});

	it("blocks current frontmatter revocation before delivering a provider request", async () => {
		const f = fixture();
		cfgModelRoles.override(f.settings, {});
		cfgRetryFallbackChains.override(f.settings, {});
		const authority: TaskModelAuthority = {
			settings: f.settings,
			agentName: "worker",
			agentModel: ["route-fixture/primary"],
			getAgentModel: async () => [],
		};
		const { permit } = await createTaskModelRoute({
			authority,
			modelRegistry: f.registry,
			selectors: ["route-fixture/primary"],
			explicit: true,
		});
		const delivered: string[] = [];
		await expect(
			wrapRoleRouteStream(() => permit, recordingStream(delivered), f.registry)(
				f.primary,
				{ messages: [] },
				{ reasoning: Effort.High },
			),
		).rejects.toThrow(/not authorized/);
		expect(delivered).toEqual([]);
	});

	it("does not revive a recorded old parent without current independent authority", async () => {
		const f = fixture();
		cfgModelRoles.override(f.settings, {});
		cfgRetryFallbackChains.override(f.settings, {});
		const live: TaskModelAuthority = {
			...f.authority,
			getParentModel: () => f.primary,
			getParentSelector: () => "route-fixture/primary:high",
		};
		const { permit } = await createTaskModelRoute({
			authority: live,
			modelRegistry: f.registry,
			selectors: ["@default"],
			explicit: true,
		});
		const receipt = roleRouteMetadata(permit)!;
		await expect(restoreTaskModelRoute(f.authority, f.registry, receipt)).rejects.toThrow(/not authorized/);
		cfgModelRoles.override(f.settings, { independent: "route-fixture/primary" });
		const restored = await restoreTaskModelRoute(f.authority, f.registry, receipt);
		assertRoleDispatch(restored.permit, f.primary, Effort.High, undefined, f.registry);
	});

	it("fails current enabled/provider/capability loss rather than switching to an unrelated model", async () => {
		const f = fixture();
		const { permit } = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@review"],
			explicit: true,
		});
		cfgEnabledModels.override(f.settings, ["route-fixture/fallback"]);
		expect(() => resolveRoleRoute(permit, f.registry)).toThrow(/unavailable/);
		cfgEnabledModels.override(f.settings, []);
		cfgDisabledProviders.override(f.settings, ["route-fixture"]);
		expect(() => resolveRoleRoute(permit, f.registry)).toThrow(/unavailable/);
		cfgDisabledProviders.override(f.settings, []);
		f.state.models = [{ ...f.primary, supportsTools: false }, f.fallback, f.outsider];
		expect(() => resolveRoleRoute(permit, f.registry)).toThrow(/unavailable/);
	});

	it("keeps @default with unset parent effort unpinned through real provider encoding and hook edits", async () => {
		const f = fixture();
		cfgModelRoles.override(f.settings, {});
		cfgRetryFallbackChains.override(f.settings, {});
		const authority: TaskModelAuthority = {
			...f.authority,
			getParentModel: () => f.primary,
			getParentSelector: () => "route-fixture/primary",
		};
		const { permit } = await createTaskModelRoute({
			authority,
			modelRegistry: f.registry,
			selectors: ["@default"],
			explicit: true,
		});
		expect(resolveRoleRoute(permit).fixedEffort).toBe(false);
		const narrowed = narrowRoleRoute(permit, ["@default"], f.registry);
		expect(resolveRoleRoute(narrowed.permit).fixedEffort).toBe(false);
		const delivered: string[] = [];
		await wrapRoleRouteStream(() => narrowed.permit, recordingStream(delivered), f.registry)(
			f.primary,
			{ messages: [] },
			{
				reasoning: Effort.High,
				onPayload: payload => {
					(payload as Record<string, unknown>).reasoning_effort = "low";
				},
			},
		);
		expect(delivered).toEqual(["route-fixture/primary:low"]);
	});

	it("re-admits current authority before a real HTTP retry without repeating the mutable payload hook", async () => {
		const f = fixture();
		const { permit } = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@review"],
			explicit: true,
		});
		let hooks = 0;
		let beforeRequests = 0;
		f.transport.onRequest = () => {
			cfgModelRoles.override(f.settings, { independent: "route-fixture/primary" });
			return new Response("temporary overload", { status: 503, headers: { "Retry-After": "0" } });
		};
		const delivered: string[] = [];
		await expect(
			wrapRoleRouteStream(() => permit, recordingStream(delivered), f.registry)(
				f.primary,
				{ messages: [] },
				{
					reasoning: Effort.High,
					onPayload: () => {
						hooks++;
					},
					onBeforeRequest: () => {
						beforeRequests++;
					},
				},
			),
		).rejects.toThrow(AIError.ModelSelectionError);
		expect(f.received).toHaveLength(1);
		expect(hooks).toBe(1);
		expect(beforeRequests).toBe(2);
	});

	it("uses configured wildcard and fuzzy grants without granting a catalog-only model", async () => {
		const f = fixture();
		cfgRetryFallbackChains.override(f.settings, {});
		cfgModelRoles.override(f.settings, { wildcard: "route-fixture/prim*", fuzzy: "route-fixture/fall" });
		for (const selector of ["route-fixture/primary", "route-fixture/fallback"]) {
			const { permit } = await createTaskModelRoute({
				authority: f.authority,
				modelRegistry: f.registry,
				selectors: [selector],
				explicit: true,
			});
			await wrapRoleRouteStream(() => permit, recordingStream([]), f.registry)(
				resolveRoleRoute(permit).model,
				{ messages: [] },
				{},
			);
		}
		expect(f.received.map(body => body.model)).toEqual(["primary", "fallback"]);
		await expect(
			createTaskModelRoute({
				authority: f.authority,
				modelRegistry: f.registry,
				selectors: ["route-fixture/outsider"],
				explicit: true,
			}),
		).rejects.toThrow(AIError.ModelSelectionError);
	});

	it("does not invent @best authority from an unrelated configured slow or review role", async () => {
		const f = fixture();
		await expect(
			createTaskModelRoute({
				authority: f.authority,
				modelRegistry: f.registry,
				selectors: ["@best"],
				explicit: true,
			}),
		).rejects.toThrow(AIError.ModelSelectionError);
		expect(f.received).toHaveLength(0);
	});

	it("admits actually configured colon role names through the same real provider boundary", async () => {
		const f = fixture();
		cfgModelRoles.override(f.settings, { "subagent:worker": "route-fixture/primary:high" });
		cfgRetryFallbackChains.override(f.settings, {});
		const { permit } = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@subagent:worker"],
			explicit: true,
		});
		await wrapRoleRouteStream(() => permit, recordingStream([]), f.registry)(
			f.primary,
			{ messages: [] },
			{ reasoning: Effort.High },
		);
		expect(f.received).toHaveLength(1);
		expect(f.received[0]).toMatchObject({ model: "primary", reasoning_effort: "high" });
	});
});

it("does not turn legacy agent inheritance into a fuzzy catalog grant", async () => {
	const f = fixture();
	const unassigned = model("default-extra", { baseUrl: f.primary.baseUrl });
	f.state.models.push(unassigned);
	cfgModelRoles.override(f.settings, {});
	cfgRetryFallbackChains.override(f.settings, {});
	await expect(
		createTaskModelRoute({
			authority: {
				...f.authority,
				agentModel: "default:high",
				getParentModel: () => f.primary,
				getParentSelector: () => "route-fixture/primary:high",
			},
			modelRegistry: f.registry,
			selectors: ["route-fixture/default-extra"],
			explicit: true,
		}),
	).rejects.toThrow(AIError.ModelSelectionError);
	expect(f.received).toHaveLength(0);
});
